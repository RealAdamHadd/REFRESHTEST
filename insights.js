/**
 * RefreshTest deterministic insight engine.
 *
 * Pure, DOM-free interpretation of measured statistics. Rules use fixed,
 * documented thresholds and only the data supplied by the caller. There is no
 * cloud service, no model inference, and no hidden state.
 *
 * These findings describe browser animation-callback cadence. They do not
 * diagnose hardware, identify a faulty monitor, measure pixel response time,
 * or establish the physical panel's exact refresh rate. Session differences are
 * descriptive and do not establish causation.
 */
(function () {
  "use strict";

  const Stats = typeof window !== "undefined" && window.RefreshTestStats
    ? window.RefreshTestStats
    : typeof require === "function"
      ? require("./stats.js")
      : null;

  if (!Stats) {
    throw new Error("RefreshTestInsights requires stats.js to be loaded first.");
  }

  const THRESHOLDS = Object.freeze({
    LOW_VARIATION_CV: 0.02,
    MODERATE_VARIATION_CV: 0.05,
    LOW_COVERAGE_PERCENT: 95,
    P95_TAIL_RATIO: 1.5,
    P99_TAIL_RATIO: 2,
    LOW_CADENCE_FPS: 55,
    SIMILAR_SESSION_RELATIVE_CHANGE: 0.01,
    PREVIOUS_DURATION_MISMATCH_RATIO: 1.2,
    MIN_ACCEPTED_SAMPLES: Stats.MIN_ACCEPTED_SAMPLES,
    MIN_P99_SAMPLES: Stats.MIN_P99_SAMPLES
  });

  // Stability and the coefficient of variation answer related but different
  // questions. Mapping stability onto the same LOW/MODERATE/HIGH bands lets the
  // insight engine avoid claiming consistency when either measure disagrees.
  const STABILITY_VARIATION = Object.freeze({
    STABLE: "LOW",
    VARIABLE: "MODERATE",
    UNSTABLE: "HIGH"
  });
  const VARIATION_RANK = Object.freeze({ LOW: 0, MODERATE: 1, HIGH: 2 });

  const SEVERITY = Object.freeze({
    INFO: "info",
    NOTICE: "notice",
    WARNING: "warning"
  });

  const CONFIDENCE = Object.freeze({
    MEASURED: "measured",
    LIMITED: "limited",
    INSUFFICIENT: "insufficient"
  });

  const LIMITATIONS = Object.freeze([
    "Insights use fixed deterministic thresholds. They are descriptive, not a validated hardware score or a confidence interval.",
    "Measurements describe browser animation-callback cadence, not direct physical display refresh rate, pixel response time, GPU presentation, or VRR behavior.",
    "Differences between sessions do not establish causation; display mode, power state, load, browser compositing, and viewing conditions can all contribute."
  ]);

  function isFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
  }

  function formatNumber(value, digits) {
    if (!isFiniteNumber(value)) return "—";
    return value.toFixed(digits);
  }

  function formatPercent(value, digits) {
    if (!isFiniteNumber(value)) return "—";
    return `${value.toFixed(digits)}%`;
  }

  function formatInteger(value) {
    if (!isFiniteNumber(value)) return "—";
    return Math.round(value).toLocaleString("en-US");
  }

  function formatDuration(ms) {
    if (!isFiniteNumber(ms) || ms < 0) return "—";
    return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
  }

  function normalizePauses(value) {
    if (!value || typeof value !== "object") return { count: 0, durationMs: 0 };
    return {
      count: isFiniteNumber(value.count) && value.count > 0 ? Math.floor(value.count) : 0,
      durationMs: isFiniteNumber(value.durationMs) && value.durationMs > 0 ? value.durationMs : 0
    };
  }

  function normalizePrevious(value) {
    if (!value || typeof value !== "object") return null;
    const summary = value.summary && typeof value.summary === "object" ? value.summary : value;
    if (!summary || typeof summary !== "object") return null;
    if (!isFiniteNumber(summary.acceptedCount) || summary.acceptedCount <= 0) return null;
    const rawVersion = value.statisticsVersion !== undefined
      ? value.statisticsVersion
      : summary.statisticsVersion;
    return {
      summary,
      label: typeof value.label === "string" && value.label ? value.label : null,
      mode: typeof value.mode === "string" && value.mode ? value.mode : null,
      durationMs: isFiniteNumber(value.durationMs) && value.durationMs > 0 ? value.durationMs : null,
      statisticsVersion: Stats.normalizeStatisticsVersion(rawVersion),
      statisticsVersionConflict: value.statisticsVersionConflict === true
    };
  }

  function finding(id, severity, title, evidence, explanation, recommendation, confidence, metrics) {
    return Object.freeze({
      id,
      severity,
      title,
      evidence,
      explanation,
      recommendation: recommendation || null,
      confidence,
      metrics: metrics && typeof metrics === "object" ? Object.freeze({ ...metrics }) : Object.freeze({})
    });
  }

  /**
   * Classify frame-time variation from the coefficient of variation. Returns
   * LOW, MODERATE, HIGH, or null when there is not enough information.
   */
  function classifyVariation(coefficient) {
    if (!isFiniteNumber(coefficient) || coefficient < 0) return null;
    if (coefficient <= THRESHOLDS.LOW_VARIATION_CV) return "LOW";
    if (coefficient <= THRESHOLDS.MODERATE_VARIATION_CV) return "MODERATE";
    return "HIGH";
  }

  function classifyStabilityVariation(classification) {
    return typeof classification === "string" && STABILITY_VARIATION[classification]
      ? STABILITY_VARIATION[classification]
      : null;
  }

  /**
   * Reconcile the two spread measures. Coefficient of variation is sensitive to
   * every observation, including a few outliers; stability only counts values
   * near the median. When they disagree, the more cautious band is used so the
   * UI never calls a sample consistent while another displayed metric does not.
   */
  function reconcileVariation(coefficient, stabilityClassification) {
    const cvVariation = classifyVariation(coefficient);
    const stabilityVariation = classifyStabilityVariation(stabilityClassification);
    if (!cvVariation) return stabilityVariation;
    if (!stabilityVariation) return cvVariation;
    return VARIATION_RANK[cvVariation] >= VARIATION_RANK[stabilityVariation]
      ? cvVariation
      : stabilityVariation;
  }

  /**
   * Decide whether a previous session is directly comparable with this one.
   * Missing metadata is treated as incompatible rather than assumed equal.
   */
  function checkSessionCompatibility(current, previous) {
    const reasons = [];
    const left = current && typeof current === "object" ? current : {};
    const right = previous && typeof previous === "object" ? previous : {};
    const leftSummary = left.summary && typeof left.summary === "object" ? left.summary : null;
    const rightSummary = right.summary && typeof right.summary === "object" ? right.summary : null;

    if (!leftSummary || !rightSummary) {
      reasons.push("A complete summary is not available for both measurements.");
    }

    if (!left.mode || !right.mode) {
      reasons.push("The measurement mode was not recorded for both sessions.");
    } else if (left.mode !== right.mode) {
      reasons.push(`Different measurement modes (${left.mode} vs ${right.mode}).`);
    }

    if (!isFiniteNumber(left.durationMs) || !isFiniteNumber(right.durationMs)
      || left.durationMs <= 0 || right.durationMs <= 0) {
      reasons.push("Active duration was not recorded for both sessions.");
    } else {
      const shortest = Math.min(left.durationMs, right.durationMs);
      const longest = Math.max(left.durationMs, right.durationMs);
      if (longest / shortest > THRESHOLDS.PREVIOUS_DURATION_MISMATCH_RATIO) {
        reasons.push(
          `Active durations differ by more than 20% (${formatDuration(left.durationMs)} vs ${formatDuration(right.durationMs)}).`
        );
      }
    }

    if (left.statisticsVersionConflict === true || right.statisticsVersionConflict === true) {
      reasons.push("The stored statistics version fields disagree for at least one session.");
    } else {
      const versionCheck = Stats.checkStatisticsCompatibility(
        left.statisticsVersion,
        right.statisticsVersion
      );
      if (!versionCheck.compatible) {
        if (versionCheck.status === "unknown") {
          reasons.push("The statistics version was not recorded for both sessions.");
        } else if (versionCheck.status === "future") {
          reasons.push(
            `A session was recorded with a newer statistics version (${formatInteger(versionCheck.left)} vs ${formatInteger(versionCheck.right)}; this app supports ${Stats.STATISTICS_VERSION}).`
          );
        } else {
          reasons.push(
            `Different statistics versions (${formatInteger(versionCheck.left)} vs ${formatInteger(versionCheck.right)}).`
          );
        }
      }
    }

    if (!leftSummary || !rightSummary
      || leftSummary.sufficientSample !== true
      || rightSummary.sufficientSample !== true) {
      reasons.push(`At least one session has fewer than ${Stats.MIN_ACCEPTED_SAMPLES} accepted intervals.`);
    }

    return { compatible: reasons.length === 0, reasons };
  }

  /**
   * Choose the newest saved session that is actually comparable with the
   * current result. Candidates are expected newest-first. If none is
   * compatible, the newest readable one is returned so the UI can explain why
   * no difference is shown instead of silently hiding the rest of history.
   */
  function selectPreviousSession(current, candidates) {
    const list = Array.isArray(candidates) ? candidates : [];
    if (list.length === 0) return null;

    let newest = null;
    for (let index = 0; index < list.length; index++) {
      const normalized = normalizePrevious(list[index]);
      if (!normalized) continue;
      if (!newest) newest = normalized;
      const compatibility = checkSessionCompatibility(current, normalized);
      if (compatibility.compatible) {
        return {
          previous: normalized,
          compatible: true,
          reasons: [],
          checkedCount: index + 1,
          skippedCount: index
        };
      }
    }

    if (!newest) return null;
    const compatibility = checkSessionCompatibility(current, newest);
    return {
      previous: newest,
      compatible: false,
      reasons: compatibility.reasons,
      checkedCount: list.length,
      skippedCount: list.length
    };
  }

  /**
   * Build deterministic findings from a statistics summary.
   *
   * @param {object} summary Output of RefreshTestStats.computeStatistics.
   * @param {object} [context]
   * @param {string} [context.mode] Measurement mode id (quick, standard, extended, diagnostics).
   * @param {number} [context.durationMs] Active measurement duration.
   * @param {number} [context.statisticsVersion] Statistics definitions used for this summary.
   * @param {string} [context.modeLabel] Human-readable mode label.
   * @param {{count: number, durationMs: number}} [context.hiddenPauses]
   * @param {object|{summary: object, label?: string, mode?: string, durationMs?: number, statisticsVersion?: number}} [context.previous]
   * @param {number} [context.droppedObservations]
   * @returns {{findings: ReadonlyArray<object>, limitations: ReadonlyArray<string>, headline: string, thresholds: object}}
   */
  function buildInsights(summary, context) {
    const settings = context && typeof context === "object" ? context : {};
    const pauses = normalizePauses(settings.hiddenPauses);
    const previous = normalizePrevious(settings.previous);
    const findings = [];

    const safeSummary = summary && typeof summary === "object" ? summary : null;
    const acceptedCount = safeSummary && isFiniteNumber(safeSummary.acceptedCount) && safeSummary.acceptedCount > 0
      ? Math.floor(safeSummary.acceptedCount)
      : 0;

    if (!safeSummary || acceptedCount === 0) {
      const gapCount = safeSummary && isFiniteNumber(safeSummary.excludedGapCount)
        ? safeSummary.excludedGapCount
        : 0;
      const invalidCount = safeSummary && isFiniteNumber(safeSummary.invalidCount)
        ? safeSummary.invalidCount
        : 0;
      findings.push(finding(
        "no-accepted-intervals",
        SEVERITY.WARNING,
        "No usable frame intervals were recorded",
        `${formatInteger(acceptedCount)} accepted intervals · ${formatInteger(gapCount)} long gaps · ${formatInteger(invalidCount)} invalid observations${pauses.count ? ` · ${pauses.count} hidden pause${pauses.count === 1 ? "" : "s"}` : ""}`,
        "Headline cadence statistics cannot be calculated without at least one accepted callback interval. Hidden time and long callback gaps are not substitutes for accepted intervals.",
        "Keep this tab visible, close heavy background work if appropriate, and run a Standard or longer measurement.",
        CONFIDENCE.INSUFFICIENT,
        { acceptedCount, gapCount, invalidCount, hiddenPauseCount: pauses.count }
      ));

      if (pauses.count > 0) {
        findings.push(hiddenPauseFinding(pauses));
      }

      return {
        findings: Object.freeze(findings),
        limitations: LIMITATIONS,
        headline: "No usable frame intervals were recorded",
        thresholds: THRESHOLDS
      };
    }

    const median = safeSummary.medianIntervalMs;
    const medianFps = safeSummary.medianFps;
    const sufficient = safeSummary.sufficientSample === true;
    const cv = safeSummary.coefficientOfVariation;
    const stability = safeSummary.stabilityPercent;
    const modeLabel = typeof settings.modeLabel === "string" && settings.modeLabel ? settings.modeLabel : null;

    if (!sufficient) {
      findings.push(finding(
        "sample-sufficiency",
        SEVERITY.WARNING,
        "The sample is too small for percentile and stability analysis",
        `${formatInteger(acceptedCount)} accepted intervals · minimum ${Stats.MIN_ACCEPTED_SAMPLES} · P95 and stability withheld`,
        "A short sample can look stable by chance. RefreshTest withholds P95, stability, and P99 until enough accepted intervals exist so the result is not presented as more precise than it is.",
        "Run Standard (8 s), Extended (20 s), or Diagnostics (30 s) while keeping the tab visible.",
        CONFIDENCE.INSUFFICIENT,
        { acceptedCount, minimumAcceptedSamples: Stats.MIN_ACCEPTED_SAMPLES }
      ));
    } else if (acceptedCount < Stats.MIN_P99_SAMPLES) {
      findings.push(finding(
        "p99-unavailable",
        SEVERITY.INFO,
        "P99 was withheld at this sample size",
        `${formatInteger(acceptedCount)} accepted intervals · P99 requires ${Stats.MIN_P99_SAMPLES} · P95 is available`,
        "Below 100 accepted intervals, a 99th-percentile estimate is effectively one of the largest observations and is unstable. P95 remains available at 30 or more intervals.",
        "Use Extended or Diagnostics when a tail estimate is important.",
        CONFIDENCE.LIMITED,
        { acceptedCount, minimumP99Samples: Stats.MIN_P99_SAMPLES }
      ));
    }

    if (sufficient && isFiniteNumber(cv)) {
      const cvVariation = classifyVariation(cv);
      const stabilityVariation = classifyStabilityVariation(safeSummary.stabilityClassification);
      const variation = reconcileVariation(cv, safeSummary.stabilityClassification);
      const diverged = cvVariation !== null && stabilityVariation !== null && cvVariation !== stabilityVariation;
      const evidence = `Population σ ${formatNumber(safeSummary.standardDeviationMs, 2)} ms · coefficient of variation ${formatPercent(cv * 100, 2)} · stability ${formatPercent(stability, 1)} within ±5% of the median`;
      const definitions = " Coefficient of variation reflects overall spread and is sensitive to a small number of outliers, while stability is the share of accepted intervals within ±5% of the median.";
      const divergence = diverged
        ? ` The two spread measures classify this sample differently (coefficient of variation: ${cvVariation}; stability: ${stabilityVariation}); the more cautious classification is used.${definitions}`
        : definitions;
      const metrics = {
        coefficientOfVariation: cv,
        stabilityPercent: stability,
        standardDeviationMs: safeSummary.standardDeviationMs,
        variationByCoefficient: cvVariation,
        variationByStability: stabilityVariation,
        combinedVariation: variation
      };

      if (variation === "LOW") {
        findings.push(finding(
          "variation-low",
          SEVERITY.INFO,
          "Frame timing was consistent during this sample",
          evidence,
          `Most accepted intervals clustered near the median during this measurement.${definitions} This describes browser callback consistency in this sample, not display hardware quality.`,
          null,
          CONFIDENCE.MEASURED,
          metrics
        ));
      } else if (variation === "MODERATE") {
        findings.push(finding(
          "variation-moderate",
          SEVERITY.NOTICE,
          "Frame timing showed moderate variation",
          evidence,
          `The spread of accepted intervals exceeded the low-variation threshold.${divergence} Scheduling noise, compositing, power management, or background load can contribute; browser timing alone cannot identify the cause.`,
          "Repeat the measurement with the tab visible and background load reduced, then compare results taken under similar conditions.",
          CONFIDENCE.MEASURED,
          metrics
        ));
      } else {
        // A STABLE sample can only reach this branch through a high coefficient
        // of variation, which is driven by a small number of late intervals.
        // Naming the core cadence as stable keeps the card consistent with the
        // displayed stability badge while still disclosing the real spread.
        const stableCore = safeSummary.stabilityClassification === "STABLE";
        findings.push(finding(
          "variation-high",
          SEVERITY.WARNING,
          stableCore
            ? "Overall variability was high despite a stable core"
            : "Frame timing varied substantially in this sample",
          evidence,
          stableCore
            ? `A small number of late intervals raised the coefficient of variation while most accepted intervals stayed near the median.${divergence} This can reduce perceived smoothness even when the typical cadence is steady; it does not identify a hardware fault.`
            : `Accepted intervals were widely spread around the median.${divergence} This can make motion less even when the average rate looks similar; it does not identify a hardware fault.`,
          "Check background activity, power mode, browser acceleration, and the active display mode, then repeat the test under similar conditions.",
          CONFIDENCE.MEASURED,
          metrics
        ));
      }
    }

    const gapCount = isFiniteNumber(safeSummary.excludedGapCount) ? safeSummary.excludedGapCount : 0;
    if (gapCount > 0) {
      findings.push(finding(
        "long-gaps-excluded",
        SEVERITY.NOTICE,
        "Long callback gaps were excluded from headline cadence",
        `${formatInteger(gapCount)} long gap${gapCount === 1 ? "" : "s"} · ${formatDuration(safeSummary.excludedGapDurationMs)} excluded · longest ${formatDuration(safeSummary.longestExcludedGapMs)}`,
        "Intervals above 250 ms were treated as long callback gaps rather than ordinary frame intervals. They remain visible in the diagnostics but do not pull the cadence estimate upward. Their cause cannot be determined from browser timing alone.",
        "If gaps persist, repeat with the tab visible and lower background activity, and check power and browser settings.",
        CONFIDENCE.MEASURED,
        { excludedGapCount: gapCount, excludedGapDurationMs: safeSummary.excludedGapDurationMs, longestExcludedGapMs: safeSummary.longestExcludedGapMs }
      ));
    }

    if (isFiniteNumber(safeSummary.usableCoveragePercent) && safeSummary.usableCoveragePercent < THRESHOLDS.LOW_COVERAGE_PERCENT) {
      findings.push(finding(
        "low-coverage",
        SEVERITY.NOTICE,
        "Usable interval coverage was limited",
        `${formatPercent(safeSummary.usableCoveragePercent, 1)} coverage · ${formatDuration(safeSummary.acceptedDurationMs)} accepted interval time · ${formatDuration(safeSummary.excludedGapDurationMs)} excluded gap time`,
        "Coverage is retained accepted interval time divided by accepted plus excluded-gap time. It is not a count of every physical display frame. Lower coverage means headline cadence describes a smaller share of the observed callback time.",
        "Repeat the measurement and compare coverage before treating the cadence estimate as representative.",
        CONFIDENCE.LIMITED,
        { usableCoveragePercent: safeSummary.usableCoveragePercent, acceptedDurationMs: safeSummary.acceptedDurationMs, excludedGapDurationMs: safeSummary.excludedGapDurationMs }
      ));
    }

    if (isFiniteNumber(median) && median > 0) {
      const p95 = safeSummary.p95IntervalMs;
      const p99 = safeSummary.p99IntervalMs;
      const p95Ratio = isFiniteNumber(p95) ? p95 / median : null;
      const p99Ratio = isFiniteNumber(p99) ? p99 / median : null;
      const tailFlagged = (isFiniteNumber(p95Ratio) && p95Ratio > THRESHOLDS.P95_TAIL_RATIO)
        || (isFiniteNumber(p99Ratio) && p99Ratio > THRESHOLDS.P99_TAIL_RATIO);

      if (tailFlagged) {
        const parts = [`P95 ${formatNumber(p95, 2)} ms`];
        if (isFiniteNumber(p95Ratio)) parts.push(`${formatNumber(p95Ratio, 2)}× median`);
        if (isFiniteNumber(p99)) parts.push(`P99 ${formatNumber(p99, 2)} ms`);
        if (isFiniteNumber(p99Ratio)) parts.push(`${formatNumber(p99Ratio, 2)}× median`);
        parts.push(`median ${formatNumber(median, 2)} ms`);
        findings.push(finding(
          "interval-tail",
          SEVERITY.NOTICE,
          "Upper-tail intervals were longer than typical",
          parts.join(" · "),
          "A small share of accepted intervals arrived later than the typical interval. Upper-tail behavior can affect perceived smoothness even when the median cadence is steady; this is not a pixel-response measurement.",
          "Compare repeated runs under similar conditions and inspect whether the tail persists when background load is reduced.",
          CONFIDENCE.MEASURED,
          { medianIntervalMs: median, p95IntervalMs: p95, p99IntervalMs: p99, p95Ratio, p99Ratio }
        ));
      }
    }

    if (pauses.count > 0) {
      findings.push(hiddenPauseFinding(pauses));
    }

    if (isFiniteNumber(medianFps) && medianFps < THRESHOLDS.LOW_CADENCE_FPS) {
      findings.push(finding(
        "low-cadence",
        SEVERITY.INFO,
        "Browser cadence was below a common 60 Hz cadence",
        `Median ${formatNumber(medianFps, 1)} FPS · median interval ${formatNumber(median, 2)} ms${modeLabel ? ` · ${modeLabel}` : ""}`,
        "If the display is configured for a higher mode, browser throttling, power settings, compositing, hardware acceleration, background load, or the display path may be limiting callback cadence. This tool cannot determine which factor applies.",
        "Verify the active display mode in system settings, keep the tab visible, and compare browsers or power modes under similar conditions.",
        CONFIDENCE.LIMITED,
        { medianFps, medianIntervalMs: median }
      ));
    }

    if (previous) {
      const compatibility = checkSessionCompatibility({
        summary: safeSummary,
        mode: typeof settings.mode === "string" ? settings.mode : null,
        durationMs: settings.durationMs,
        statisticsVersion: safeSummary.statisticsVersion
      }, previous);

      if (!compatibility.compatible) {
        findings.push(finding(
          "session-comparison-unavailable",
          SEVERITY.NOTICE,
          "Comparison with the previous saved session is unavailable",
          `${previous.label ? `Baseline: ${previous.label} · ` : ""}${compatibility.reasons.join(" ")}`,
          "RefreshTest only describes a session difference when both measurements used the same mode, comparable active durations, the same statistics definitions, and a sufficient sample. Presenting other runs as a change would overstate what the data supports.",
          "Run the same mode for a comparable duration, then compare the new result with a saved session recorded under similar conditions.",
          CONFIDENCE.INSUFFICIENT,
          { reasons: compatibility.reasons.join(" | ") }
        ));
      } else {
        const previousMedian = previous.summary.medianIntervalMs;
        const previousMedianFps = previous.summary.medianFps;
        if (isFiniteNumber(previousMedian) && isFiniteNumber(median) && previousMedian > 0) {
          const deltaMs = median - previousMedian;
          const relative = deltaMs / previousMedian;
          const similar = Math.abs(relative) <= THRESHOLDS.SIMILAR_SESSION_RELATIVE_CHANGE;
          const direction = similar
            ? "essentially unchanged"
            : deltaMs > 0 ? "longer" : deltaMs < 0 ? "shorter" : "unchanged";
          const evidenceParts = [
            `Median interval ${formatNumber(previousMedian, 2)} → ${formatNumber(median, 2)} ms (${deltaMs >= 0 ? "+" : ""}${formatNumber(deltaMs, 2)} ms, ${relative >= 0 ? "+" : ""}${formatPercent(relative * 100, 1)}; ${direction})`
          ];
          if (isFiniteNumber(previousMedianFps) && isFiniteNumber(medianFps)) {
            evidenceParts.push(`median FPS ${formatNumber(previousMedianFps, 1)} → ${formatNumber(medianFps, 1)}`);
          }
          if (previous.label) evidenceParts.push(`baseline: ${previous.label}`);

          findings.push(finding(
            "session-difference",
            similar ? SEVERITY.INFO : SEVERITY.NOTICE,
            similar
              ? "Cadence was similar to the previous saved session"
              : "Cadence differed from the previous saved session",
            evidenceParts.join(" · "),
            "This is a descriptive difference between two browser measurements. Browser timing alone cannot determine whether the change came from display mode, power state, system load, browser compositing, viewing conditions, or another factor.",
            "Repeat both conditions under similar settings and sample windows before drawing conclusions.",
            CONFIDENCE.LIMITED,
            {
              currentMedianIntervalMs: median,
              previousMedianIntervalMs: previousMedian,
              deltaMs,
              relativeChange: relative,
              similar
            }
          ));
        }
      }
    }

    findings.push(finding(
      "cadence-baseline",
      SEVERITY.INFO,
      `Measured cadence centered near ${formatNumber(medianFps, 1)} FPS`,
      `Median ${formatNumber(median, 2)} ms (${formatNumber(medianFps, 1)} FPS) · mean ${formatNumber(safeSummary.meanIntervalMs, 2)} ms (${formatNumber(safeSummary.averageFps, 1)} FPS) · ${formatInteger(acceptedCount)} accepted intervals${isFiniteNumber(settings.durationMs) ? ` · ${formatDuration(settings.durationMs)} active` : ""}`,
      "The median is the middle accepted interval. Average FPS is 1000 divided by the mean accepted interval, so it is an interval-derived rate, not a count of every physical display frame.",
      null,
      sufficient ? CONFIDENCE.MEASURED : CONFIDENCE.LIMITED,
      {
        medianIntervalMs: median,
        medianFps,
        meanIntervalMs: safeSummary.meanIntervalMs,
        averageFps: safeSummary.averageFps,
        acceptedCount
      }
    ));

    const invalidCount = isFiniteNumber(safeSummary.invalidCount) ? safeSummary.invalidCount : 0;
    if (invalidCount > 0) {
      findings.push(finding(
        "invalid-observations",
        SEVERITY.INFO,
        "Invalid observations were excluded",
        `${formatInteger(invalidCount)} invalid observation${invalidCount === 1 ? "" : "s"} · accepted statistics are unaffected`,
        "Zero, negative, and non-finite callback deltas cannot be used as frame intervals. They were counted for diagnostics and never entered accepted-interval statistics.",
        null,
        CONFIDENCE.MEASURED,
        { invalidCount }
      ));
    }

    if (isFiniteNumber(settings.droppedObservations) && settings.droppedObservations > 0) {
      findings.push(finding(
        "retention-limit",
        SEVERITY.WARNING,
        "The sample retention limit was reached",
        `${formatInteger(settings.droppedObservations)} callback interval${settings.droppedObservations === 1 ? "" : "s"} not retained`,
        "The run exceeded the bounded observation buffer. Retained intervals still describe the measured sample, but the dropped tail is not included.",
        "Use a shorter measurement mode or investigate unusually high callback frequency.",
        CONFIDENCE.LIMITED,
        { droppedObservations: settings.droppedObservations }
      ));
    }

    return {
      findings: Object.freeze(findings),
      limitations: LIMITATIONS,
      headline: headlineFor(safeSummary, findings),
      thresholds: THRESHOLDS
    };
  }

  function hiddenPauseFinding(pauses) {
    return finding(
      "hidden-pauses",
      SEVERITY.NOTICE,
      "Tab visibility pauses interrupted sampling",
      `${formatInteger(pauses.count)} hidden pause${pauses.count === 1 ? "" : "s"} · ${formatDuration(pauses.durationMs)} excluded`,
      "The tab was hidden during the run. Sampling paused, hidden time was excluded from active duration, and callback timestamps were reset on return so hidden time could not become an accepted frame interval.",
      "Rerun with the tab visible for an uninterrupted sample.",
      CONFIDENCE.LIMITED,
      { hiddenPauseCount: pauses.count, hiddenPauseDurationMs: pauses.durationMs }
    );
  }

  function headlineFor(summary, findings) {
    // The displayed stability badge is driven by summary.stabilityClassification.
    // A STABLE sample can still reach the HIGH coefficient-of-variation band
    // because CV counts every observation, including isolated late callbacks.
    // Headlining "varied substantially" would then contradict the badge, so the
    // high-variation headline is skipped for STABLE samples: a flagged upper
    // tail describes the outliers, otherwise the neutral cadence headline is used.
    const stableSample = summary && summary.stabilityClassification === "STABLE";
    const variation = findings.find((item) => item.id === "variation-moderate"
      || (item.id === "variation-high" && !stableSample));
    if (variation) return variation.title;
    const sufficiency = findings.find((item) => item.id === "sample-sufficiency");
    if (sufficiency) return "Limited sample: interpret with caution";
    if (findings.some((item) => item.id === "variation-low")) return "Frame timing was consistent in this sample";
    if (stableSample) {
      const tail = findings.find((item) => item.id === "interval-tail");
      if (tail) return tail.title;
    }
    if (findings.some((item) => item.id === "long-gaps-excluded")) return "Cadence excludes long callback gaps";
    if (summary && isFiniteNumber(summary.medianFps)) {
      return `Measured cadence centered near ${formatNumber(summary.medianFps, 1)} FPS`;
    }
    return "Measurement summary";
  }

  const api = Object.freeze({
    THRESHOLDS,
    SEVERITY,
    CONFIDENCE,
    LIMITATIONS,
    STABILITY_VARIATION,
    classifyVariation,
    classifyStabilityVariation,
    reconcileVariation,
    checkSessionCompatibility,
    selectPreviousSession,
    buildInsights
  });

  if (typeof module === "object" && module && module.exports) {
    module.exports = api;
  }

  if (typeof window !== "undefined") {
    window.RefreshTestInsights = api;
  }
})();
