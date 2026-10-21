/**
 * RefreshTest session comparison.
 *
 * Pure, DOM-free comparison of two or more saved sessions. Historical metrics
 * are recomputed from stored raw observations with the current statistics
 * engine whenever possible; a saved summary is used only as a clearly labelled
 * fallback. Differences are descriptive and do not establish causation.
 */
(function () {
  "use strict";

  const Stats = typeof window !== "undefined" && window.RefreshTestStats
    ? window.RefreshTestStats
    : typeof require === "function"
      ? require("./stats.js")
      : null;

  if (!Stats) {
    throw new Error("RefreshTestComparison requires stats.js to be loaded first.");
  }

  const MIN_SESSIONS = 2;
  const MAX_COMPARE_SESSIONS = 6;
  const DURATION_MISMATCH_RATIO = 1.2;
  const SAMPLE_COUNT_RATIO = 10;

  const METRICS = Object.freeze([
    Object.freeze({ key: "medianIntervalMs", label: "Median interval", unit: "ms", digits: 2, scale: 1 }),
    Object.freeze({ key: "averageFps", label: "Average FPS", unit: "FPS", digits: 1, scale: 1 }),
    Object.freeze({ key: "p95IntervalMs", label: "P95 interval", unit: "ms", digits: 2, scale: 1, note: "Needs 30 accepted intervals" }),
    Object.freeze({ key: "p99IntervalMs", label: "P99 interval", unit: "ms", digits: 2, scale: 1, note: "Needs 100 accepted intervals" }),
    Object.freeze({ key: "standardDeviationMs", label: "Frame-time variation", unit: "ms", digits: 2, scale: 1, note: "Population σ" }),
    Object.freeze({ key: "coefficientOfVariation", label: "Coefficient of variation", unit: "%", digits: 2, scale: 100 }),
    Object.freeze({ key: "stabilityPercent", label: "Stability", unit: "%", digits: 1, scale: 1, note: "Within ±5% of median" }),
    Object.freeze({ key: "usableCoveragePercent", label: "Usable coverage", unit: "%", digits: 1, scale: 1 }),
    Object.freeze({ key: "acceptedCount", label: "Accepted intervals", unit: "count", digits: 0, scale: 1 }),
    Object.freeze({ key: "excludedGapCount", label: "Long gaps", unit: "count", digits: 0, scale: 1 }),
    Object.freeze({ key: "excludedGapDurationMs", label: "Excluded gap time", unit: "s", digits: 1, scale: 0.001 }),
    Object.freeze({ key: "durationMs", label: "Active duration", unit: "s", digits: 1, scale: 0.001 })
  ]);

  const COMPARISON_NOTE = "Differences describe measured browser animation-callback cadence only. They do not establish causation and are not direct physical panel measurements.";

  function isFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
  }

  function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function parseTime(value) {
    const parsed = typeof value === "string" ? Date.parse(value) : NaN;
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function pad(value) {
    return String(value).padStart(2, "0");
  }

  function formatSavedAt(value) {
    const parsed = parseTime(value);
    if (!parsed) return "Unknown date";
    const date = new Date(parsed);
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
  }

  function deriveSessionSummary(record) {
    if (!isPlainObject(record)) return null;
    // Stored validation requires a summary accepted count to be backed by raw
    // observations, so the old summary-only fallback could never be reached
    // through the app. Require raw intervals and report unavailable otherwise.
    if (!Array.isArray(record.observations) || record.observations.length === 0) return null;
    return {
      summary: Stats.computeStatistics(record.observations),
      source: "recomputed"
    };
  }

  function sessionView(record) {
    const derived = deriveSessionSummary(record);
    const version = Stats.resolveStatisticsVersion(
      record.summary && record.summary.statisticsVersion,
      record.settings && record.settings.statsVersion
    );
    return {
      id: record.id,
      savedAt: record.savedAt,
      label: `${formatSavedAt(record.savedAt)} · ${record.modeLabel || record.mode || "Unknown mode"}`,
      shortLabel: formatSavedAt(record.savedAt),
      mode: record.mode || null,
      modeLabel: record.modeLabel || record.mode || "Unknown mode",
      durationMs: isFiniteNumber(record.durationMs) ? record.durationMs : null,
      settings: isPlainObject(record.settings) ? record.settings : null,
      hiddenPauses: isPlainObject(record.hiddenPauses) ? record.hiddenPauses : { count: 0, durationMs: 0 },
      summary: derived ? derived.summary : null,
      source: derived ? derived.source : "unavailable",
      // Capture the recorded definitions before the derived summary replaces
      // them with current-version metrics.
      statisticsVersion: version.version,
      statisticsVersionConflict: version.conflict
    };
  }

  function metricRawValue(session, metric) {
    if (!session) return null;
    if (metric.key === "durationMs") {
      return isFiniteNumber(session.durationMs) ? session.durationMs : null;
    }
    if (!session.summary) return null;
    const value = session.summary[metric.key];
    return isFiniteNumber(value) ? value : null;
  }

  function computeDelta(value, baseline) {
    if (!isFiniteNumber(value) || !isFiniteNumber(baseline)) return null;
    const absolute = value - baseline;
    return {
      absolute,
      percent: baseline === 0 ? null : absolute / baseline * 100,
      direction: absolute > 0 ? "increase" : absolute < 0 ? "decrease" : "unchanged"
    };
  }

  function uniqueValues(sessions, read) {
    const values = [];
    for (const session of sessions) {
      const value = read(session);
      if (value !== null && value !== undefined && !values.includes(value)) values.push(value);
    }
    return values;
  }

  function buildWarnings(sessions) {
    const warnings = [];
    const modes = uniqueValues(sessions, (session) => session.mode);
    if (modes.length > 1) {
      warnings.push({
        code: "mode-mismatch",
        severity: "notice",
        title: "Different test modes",
        message: "Selected sessions used different measurement windows. Interval metrics remain comparable, but longer runs may include different conditions."
      });
    }

    const durations = sessions.map((session) => session.durationMs).filter(isFiniteNumber);
    if (durations.length >= 2) {
      const shortest = Math.min(...durations);
      const longest = Math.max(...durations);
      if (shortest > 0 && longest / shortest > DURATION_MISMATCH_RATIO) {
        warnings.push({
          code: "duration-mismatch",
          severity: "notice",
          title: "Different active durations",
          message: "Active measurement windows differ by more than 20%. Differences may reflect the different observation windows rather than a stable change."
        });
      }
    }

    const versionStates = sessions.map((session) => ({
      version: session.statisticsVersion,
      conflict: session.statisticsVersionConflict === true
    }));
    const versions = uniqueValues(
      versionStates.filter((state) => !state.conflict && state.version !== null),
      (state) => state.version
    );
    const unknownVersions = versionStates.filter((state) => !state.conflict && state.version === null);
    const conflicts = versionStates.filter((state) => state.conflict);
    const futureVersions = versions.filter((version) => version > Stats.STATISTICS_VERSION);

    if (futureVersions.length > 0) {
      warnings.push({
        code: "statistics-version-future",
        severity: "warning",
        title: "A session uses a newer statistics version",
        message: `At least one session was recorded with statistics version ${futureVersions[0]}, newer than this app's version ${Stats.STATISTICS_VERSION}. Descriptive differences are withheld because these definitions are not known to this build.`
      });
    } else if (conflicts.length > 0 || versions.length > 1) {
      warnings.push({
        code: "statistics-version-mismatch",
        severity: "notice",
        title: "Different statistics versions",
        message: "Selected sessions do not share one statistics definition. Absolute values remain visible, but descriptive differences are withheld because they would not be a same-definition comparison."
      });
    } else if (unknownVersions.length > 0) {
      warnings.push({
        code: "statistics-version-unknown",
        severity: "warning",
        title: "Statistics version was not recorded",
        message: "One or more sessions do not record which statistics definitions produced their stored summary. They remain viewable, but descriptive differences are withheld rather than assuming they match the current version."
      });
    } else if (versions.length === 1 && versions[0] < Stats.STATISTICS_VERSION) {
      warnings.push({
        code: "statistics-version-older",
        severity: "info",
        title: "Sessions use an earlier statistics version",
        message: `These sessions were recorded with statistics version ${versions[0]} (current: ${Stats.STATISTICS_VERSION}). Metrics are recomputed from raw intervals with the current engine, so the comparison remains same-definition.`
      });
    }

    const unavailable = sessions.filter((session) => session.source === "unavailable");
    if (unavailable.length > 0) {
      warnings.push({
        code: "missing-raw-intervals",
        severity: "warning",
        title: "Raw intervals are unavailable",
        message: "One or more sessions do not contain stored raw intervals. Their metrics are shown as unavailable rather than being reconstructed from a summary."
      });
    }

    const hidden = sessions.filter((session) => session.hiddenPauses && session.hiddenPauses.count > 0);
    if (hidden.length > 0) {
      warnings.push({
        code: "hidden-pauses",
        severity: "info",
        title: "Hidden-tab pauses occurred",
        message: "One or more sessions paused while the tab was hidden. Hidden time was excluded from active duration and was not counted as frame intervals."
      });
    }

    const limitedSamples = sessions.filter((session) => !session.summary || session.summary.sufficientSample !== true);
    if (limitedSamples.length > 0) {
      warnings.push({
        code: "limited-sample",
        severity: "warning",
        title: "One or more samples were limited",
        message: "Percentile and stability values may be unavailable for sessions below 30 accepted intervals. Missing values are shown as unavailable rather than zero."
      });
    }

    const acceptedCounts = sessions
      .map((session) => session.summary && session.summary.acceptedCount)
      .filter((value) => isFiniteNumber(value) && value > 0);
    if (acceptedCounts.length >= 2) {
      const smallest = Math.min(...acceptedCounts);
      const largest = Math.max(...acceptedCounts);
      if (smallest > 0 && largest / smallest > SAMPLE_COUNT_RATIO) {
        warnings.push({
          code: "sample-size-spread",
          severity: "info",
          title: "Very different sample counts",
          message: "Accepted sample counts differ by more than 10×. Tail estimates from the smaller session are less precise."
        });
      }
    }

    return warnings;
  }

  function buildRows(sessions, allowDeltas) {
    return METRICS.map((metric) => {
      const values = sessions.map((session) => {
        const raw = metricRawValue(session, metric);
        return raw === null ? null : raw * metric.scale;
      });
      const baseline = values.length ? values[0] : null;
      const deltas = values.map((value, index) => {
        if (!allowDeltas || index === 0 || value === null || baseline === null) return null;
        return computeDelta(value, baseline);
      });
      const availableCount = values.filter((value) => value !== null).length;
      return {
        key: metric.key,
        label: metric.label,
        unit: metric.unit,
        digits: metric.digits,
        note: metric.note || null,
        values,
        baselineValue: baseline,
        deltas,
        availableCount,
        comparable: availableCount >= 2
      };
    });
  }

  /**
   * A comparison is same-definition only when every view has a recorded
   * version, no record has conflicting fields, and the shared version is known
   * to this build's policy.
   */
  function sessionsShareStatisticsVersion(sessions) {
    if (!Array.isArray(sessions) || sessions.length === 0) return false;
    const first = sessions[0];
    if (!first || first.statisticsVersionConflict) return false;
    return sessions.every((session) => {
      if (!session || session.statisticsVersionConflict) return false;
      return Stats.checkStatisticsCompatibility(
        first.statisticsVersion,
        session.statisticsVersion
      ).compatible;
    });
  }

  /**
   * Compare two or more saved sessions. The earliest session is the baseline.
   * Values are absolute; `deltas` hold descriptive differences for every other
   * session. Missing metrics are null, never zero. Deltas are withheld when the
   * recorded statistics versions are not comparable.
   */
  function compareSessions(records) {
    if (!Array.isArray(records) || records.length === 0) {
      return {
        ok: false,
        reason: "empty",
        message: "No saved sessions are available to compare.",
        sessions: [],
        rows: [],
        warnings: [],
        notes: [COMPARISON_NOTE]
      };
    }
    if (records.length < MIN_SESSIONS) {
      return {
        ok: false,
        reason: "need-two",
        message: `Select at least ${MIN_SESSIONS} saved sessions to compare.`,
        sessions: [],
        rows: [],
        warnings: [],
        notes: [COMPARISON_NOTE]
      };
    }

    const views = records.map(sessionView).sort((left, right) => {
      return parseTime(left.savedAt) - parseTime(right.savedAt) || left.id.localeCompare(right.id);
    });

    const warnings = buildWarnings(views);
    const versionCompatible = sessionsShareStatisticsVersion(views);
    const rows = buildRows(views, versionCompatible);
    const notes = [
      `Baseline is the earliest selected session (${views[0].label}).`,
      COMPARISON_NOTE
    ];

    if (!versionCompatible) {
      notes.push("Descriptive differences are withheld because the selected sessions do not share a recorded, comparable statistics version.");
    }
    if (rows.some((row) => !row.comparable)) {
      notes.push("Metrics with fewer than two available values are retained in the table as unavailable rather than inferred.");
    }

    return {
      ok: true,
      reason: null,
      sessions: views,
      rows,
      warnings,
      notes,
      versionCompatible,
      baselineId: views[0].id
    };
  }

  const api = Object.freeze({
    MIN_SESSIONS,
    MAX_COMPARE_SESSIONS,
    METRICS,
    COMPARISON_NOTE,
    deriveSessionSummary,
    sessionView,
    computeDelta,
    sessionsShareStatisticsVersion,
    compareSessions,
    formatSavedAt
  });

  if (typeof module === "object" && module && module.exports) {
    module.exports = api;
  }

  if (typeof window !== "undefined") {
    window.RefreshTestComparison = api;
  }
})();
