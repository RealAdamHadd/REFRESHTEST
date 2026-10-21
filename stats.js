/**
 * RefreshTest statistics module.
 *
 * Classic browser script with a guarded CommonJS export for Node tests.
 * It deliberately has no DOM access, no rendering code, and no hidden state.
 *
 * Measurement contract (all intervals are milliseconds):
 * - An observation is accepted when it is a finite number greater than 0 and
 *   no greater than MAX_ACCEPTED_INTERVAL_MS (250 ms).
 * - A finite interval above 250 ms is an excluded long gap, not an invalid
 *   observation.
 * - Anything else (zero, negative, NaN, Infinity) is invalid and reported as
 *   such. Invalid data never enters accepted-interval statistics.
 *
 * Callback intervals describe browser animation-callback cadence. They are not
 * a direct count of every physical display frame and cannot prove panel refresh
 * rate, GPU presentation, or VRR behavior.
 */
(function () {
  "use strict";

  // Bump when a statistical definition changes in a way that could alter
  // historical comparisons. Saved sessions record this version.
  const STATISTICS_VERSION = 2;
  const MAX_STATISTICS_VERSION = 1000;
  const MAX_ACCEPTED_INTERVAL_MS = 250;
  const MIN_ACCEPTED_SAMPLES = 30;
  // A 99th percentile is very close to the maximum below ~100 samples, so it is
  // withheld rather than presented as a stable tail estimate.
  const MIN_P99_SAMPLES = 100;
  const STABILITY_TOLERANCE_RATIO = 0.05;
  const STABLE_THRESHOLD_PERCENT = 95;
  const VARIABLE_THRESHOLD_PERCENT = 80;
  const DEFAULT_HISTOGRAM_BINS = 18;

  const OBSERVATION_KIND = Object.freeze({
    ACCEPTED: "accepted",
    LONG_GAP: "long-gap",
    INVALID: "invalid"
  });

  const EMPTY_HIDDEN_PAUSE_ACCOUNTING = Object.freeze({
    count: 0,
    durationMs: 0
  });

  function isFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
  }

  /**
   * A statistics version is metadata, not a metric. Missing or malformed values
   * stay unknown so callers never silently treat an unlabelled session as if it
   * had been produced by the current definitions.
   */
  function normalizeStatisticsVersion(value) {
    if (!isFiniteNumber(value) || !Number.isInteger(value)) return null;
    if (value < 1 || value > MAX_STATISTICS_VERSION) return null;
    return value;
  }

  /**
   * Resolve the two historical version fields. The summary field is
   * authoritative because it describes the definitions used for the stored
   * metrics; settings.statsVersion is retained as a legacy mirror. Values that
   * disagree are reported as a conflict rather than one field silently winning.
   */
  function resolveStatisticsVersion(summaryVersion, settingsVersion) {
    const summary = normalizeStatisticsVersion(summaryVersion);
    const settings = normalizeStatisticsVersion(settingsVersion);
    if (summary !== null && settings !== null) {
      return summary === settings
        ? { version: summary, conflict: false }
        : { version: null, conflict: true };
    }
    return {
      version: summary !== null ? summary : settings,
      conflict: false
    };
  }

  /**
   * One compatibility policy shared by Compare and Insights.
   *
   * - current/current: comparable.
   * - older/older with the same version: comparable, but flagged as older.
   * - missing/unknown: not comparable as a cross-session claim.
   * - different versions: not comparable.
   * - a future version: not comparable because this build cannot know its
   *   definitions.
   */
  function checkStatisticsCompatibility(leftVersion, rightVersion) {
    const left = normalizeStatisticsVersion(leftVersion);
    const right = normalizeStatisticsVersion(rightVersion);
    if (left === null || right === null) {
      return { compatible: false, status: "unknown", left, right };
    }
    if (left > STATISTICS_VERSION || right > STATISTICS_VERSION) {
      return { compatible: false, status: "future", left, right };
    }
    if (left !== right) {
      return { compatible: false, status: "mismatch", left, right };
    }
    return {
      compatible: true,
      status: left === STATISTICS_VERSION ? "current" : "older",
      left,
      right
    };
  }

  /**
   * Classify one raw observation without changing it.
   * @returns {"accepted"|"long-gap"|"invalid"}
   */
  function classifyObservation(value) {
    if (!isFiniteNumber(value) || value <= 0) return OBSERVATION_KIND.INVALID;
    if (value > MAX_ACCEPTED_INTERVAL_MS) return OBSERVATION_KIND.LONG_GAP;
    return OBSERVATION_KIND.ACCEPTED;
  }

  /**
   * Kahan-compensated summation. Accepted intervals are bounded, but this keeps
   * long sample runs and gap-duration totals as stable as the doubles allow.
   */
  function compensatedSum(values) {
    let sum = 0;
    let compensation = 0;
    for (let index = 0; index < values.length; index++) {
      const adjusted = values[index] - compensation;
      const next = sum + adjusted;
      compensation = (next - sum) - adjusted;
      sum = next;
    }
    return sum;
  }

  /**
   * Median of a collection. The caller's array is never sorted in place.
   * Returns null for empty input. For an even count, the two middle values are
   * averaged.
   */
  function median(values) {
    if (!Array.isArray(values) || values.length === 0) return null;
    const ordered = values.slice().sort((a, b) => a - b);
    const middle = Math.floor(ordered.length / 2);
    return ordered.length % 2
      ? ordered[middle]
      : (ordered[middle - 1] + ordered[middle]) / 2;
  }

  /**
   * Population standard deviation (denominator n, not n - 1). Returns null for
   * empty input and 0 for a single value. `center` may be supplied to reuse the
   * already-computed arithmetic mean.
   */
  function populationStandardDeviation(values, center) {
    if (!Array.isArray(values) || values.length === 0) return null;
    const mean = isFiniteNumber(center) ? center : compensatedSum(values) / values.length;
    let squaredDeviations = 0;
    for (let index = 0; index < values.length; index++) {
      const deviation = values[index] - mean;
      squaredDeviations += deviation * deviation;
    }
    return Math.sqrt(squaredDeviations / values.length);
  }

  /**
   * Nearest-rank percentile with no interpolation.
   * rank = ceil(percentile * n), one-based; the result is ordered[rank - 1].
   */
  function nearestRankPercentile(values, percentile) {
    if (!Array.isArray(values) || values.length === 0) return null;
    if (!isFiniteNumber(percentile) || percentile <= 0 || percentile > 1) return null;
    const ordered = values.slice().sort((a, b) => a - b);
    const rank = Math.ceil(percentile * ordered.length);
    const boundedRank = Math.min(ordered.length, Math.max(1, rank));
    return ordered[boundedRank - 1];
  }

  /**
   * Coefficient of variation (population standard deviation / mean). It is a
   * dimensionless description of spread and is null when no positive mean can
   * be established. It is not a confidence interval or a quality score.
   */
  function coefficientOfVariation(values, center) {
    if (!Array.isArray(values) || values.length === 0) return null;
    const mean = isFiniteNumber(center) ? center : compensatedSum(values) / values.length;
    if (!isFiniteNumber(mean) || mean <= 0) return null;
    const deviation = populationStandardDeviation(values, mean);
    if (deviation === null || !Number.isFinite(deviation)) return null;
    return deviation / mean;
  }

  /**
   * Deterministic histogram for a list of interval values.
   *
   * Bins are half-open [start, end) except the final bin, which includes the
   * upper bound. Finite values below `min` are counted as underflow, values
   * above `max` as overflow, and non-positive/non-finite values as invalid.
   * The caller's array is never sorted or mutated. The function is intended for
   * post-run display, not for the animation callback.
   *
   * @param {number[]} values
   * @param {{binCount?: number, min?: number, max?: number}} [options]
   * @returns {{bins: Array<{start: number, end: number, count: number}>, min: number|null, max: number|null, binWidth: number|null, binCount: number, sampleCount: number, invalidCount: number, underflowCount: number, overflowCount: number}|null}
   */
  function buildHistogram(values, options) {
    const settings = options && typeof options === "object" ? options : {};
    const requestedBins = isFiniteNumber(settings.binCount)
      ? Math.floor(settings.binCount)
      : DEFAULT_HISTOGRAM_BINS;
    const binCount = Math.max(1, Math.min(100, requestedBins));

    let smallest = Infinity;
    let largest = -Infinity;
    let sampleCount = 0;
    let invalidCount = 0;
    const source = Array.isArray(values) ? values : [];

    for (let index = 0; index < source.length; index++) {
      const value = source[index];
      if (!isFiniteNumber(value) || value <= 0) {
        invalidCount++;
        continue;
      }
      sampleCount++;
      if (value < smallest) smallest = value;
      if (value > largest) largest = value;
    }

    if (sampleCount === 0) {
      return {
        bins: [],
        min: null,
        max: null,
        binWidth: null,
        binCount: 0,
        sampleCount: 0,
        invalidCount,
        underflowCount: 0,
        overflowCount: 0
      };
    }

    let lower = isFiniteNumber(settings.min) ? settings.min : smallest;
    let upper = isFiniteNumber(settings.max) ? settings.max : largest;
    if (!Number.isFinite(lower) || !Number.isFinite(upper)) return null;
    if (upper <= lower) upper = lower + 1;

    const binWidth = (upper - lower) / binCount;
    const bins = [];
    for (let index = 0; index < binCount; index++) {
      bins.push({
        start: lower + index * binWidth,
        end: lower + (index + 1) * binWidth,
        count: 0
      });
    }

    let underflowCount = 0;
    let overflowCount = 0;
    for (let index = 0; index < source.length; index++) {
      const value = source[index];
      if (!isFiniteNumber(value) || value <= 0) continue;
      if (value < lower) {
        underflowCount++;
      } else if (value > upper) {
        overflowCount++;
      } else {
        const rawIndex = value === upper ? binCount - 1 : Math.floor((value - lower) / binWidth);
        const binIndex = Math.max(0, Math.min(binCount - 1, rawIndex));
        bins[binIndex].count++;
      }
    }

    return {
      bins,
      min: lower,
      max: upper,
      binWidth,
      binCount,
      sampleCount,
      invalidCount,
      underflowCount,
      overflowCount
    };
  }

  /**
   * Percentage of intervals within +/-5% of the median (inclusive boundary).
   * Returns null when no median can be established.
   */
  function computeStabilityPercent(intervals, medianValue) {
    if (!Array.isArray(intervals) || intervals.length === 0) return null;
    const center = isFiniteNumber(medianValue) ? medianValue : median(intervals);
    if (center === null) return null;
    const tolerance = Math.abs(center) * STABILITY_TOLERANCE_RATIO;
    let stableCount = 0;
    for (let index = 0; index < intervals.length; index++) {
      if (Math.abs(intervals[index] - center) <= tolerance) stableCount++;
    }
    return stableCount / intervals.length * 100;
  }

  /**
   * Preserve the existing UI thresholds: 95% and above is STABLE, 80% and above
   * is VARIABLE, and anything lower is UNSTABLE. Missing values are not given a
   * definitive classification.
   */
  function classifyStability(percent) {
    if (!isFiniteNumber(percent)) return "INSUFFICIENT";
    if (percent >= STABLE_THRESHOLD_PERCENT) return "STABLE";
    if (percent >= VARIABLE_THRESHOLD_PERCENT) return "VARIABLE";
    return "UNSTABLE";
  }

  /**
   * Split raw observations into accepted intervals, excluded long gaps, and
   * invalid values. Input order is preserved inside each bucket and the caller's
   * array is not modified.
   */
  function classifyObservations(observations) {
    const acceptedIntervals = [];
    const excludedGaps = [];
    const invalidObservations = [];

    if (Array.isArray(observations)) {
      for (let index = 0; index < observations.length; index++) {
        const value = observations[index];
        const kind = classifyObservation(value);
        if (kind === OBSERVATION_KIND.ACCEPTED) acceptedIntervals.push(value);
        else if (kind === OBSERVATION_KIND.LONG_GAP) excludedGaps.push(value);
        else invalidObservations.push(value);
      }
    }

    let longestExcludedGapMs = 0;
    for (let index = 0; index < excludedGaps.length; index++) {
      if (excludedGaps[index] > longestExcludedGapMs) {
        longestExcludedGapMs = excludedGaps[index];
      }
    }

    return {
      acceptedIntervals,
      excludedGaps,
      invalidObservations,
      acceptedCount: acceptedIntervals.length,
      excludedGapCount: excludedGaps.length,
      invalidCount: invalidObservations.length,
      acceptedDurationMs: compensatedSum(acceptedIntervals),
      excludedGapDurationMs: compensatedSum(excludedGaps),
      longestExcludedGapMs
    };
  }

  /**
   * Compute the full result from raw observations.
   *
   * P95 and stability are unavailable below MIN_ACCEPTED_SAMPLES so the UI
   * cannot present a 2-sample stability score as if it were meaningful. The
   * other statistics remain available from one accepted interval onward.
   *
   * Average FPS is 1000 / arithmeticMean(accepted intervals), preserving the
   * existing metric. It is not total accepted frames divided by wall-clock time
   * and is not end-to-end throughput. Usable coverage is reported separately:
   * 100 * acceptedDuration / (acceptedDuration + excludedGapDuration). Hidden
   * tab pauses are tracked outside this function and are not long gaps.
   */
  function computeStatistics(observations) {
    const classified = classifyObservations(observations);
    const accepted = classified.acceptedIntervals;
    const acceptedCount = classified.acceptedCount;
    const meanIntervalMs = acceptedCount
      ? classified.acceptedDurationMs / acceptedCount
      : null;
    const medianIntervalMs = median(accepted);

    let minIntervalMs = null;
    let maxIntervalMs = null;
    if (acceptedCount) {
      minIntervalMs = accepted[0];
      maxIntervalMs = accepted[0];
      for (let index = 1; index < accepted.length; index++) {
        if (accepted[index] < minIntervalMs) minIntervalMs = accepted[index];
        if (accepted[index] > maxIntervalMs) maxIntervalMs = accepted[index];
      }
    }

    const standardDeviationMs = acceptedCount
      ? populationStandardDeviation(accepted, meanIntervalMs)
      : null;
    const sufficientSample = acceptedCount >= MIN_ACCEPTED_SAMPLES;
    const p95IntervalMs = sufficientSample
      ? nearestRankPercentile(accepted, 0.95)
      : null;
    const p99IntervalMs = acceptedCount >= MIN_P99_SAMPLES
      ? nearestRankPercentile(accepted, 0.99)
      : null;
    const stabilityPercent = sufficientSample
      ? computeStabilityPercent(accepted, medianIntervalMs)
      : null;
    const coverageDenominator = classified.acceptedDurationMs + classified.excludedGapDurationMs;
    const usableCoveragePercent = coverageDenominator > 0
      ? 100 * classified.acceptedDurationMs / coverageDenominator
      : null;

    return {
      acceptedIntervals: accepted,
      excludedGaps: classified.excludedGaps,
      invalidObservations: classified.invalidObservations,
      acceptedCount,
      excludedGapCount: classified.excludedGapCount,
      invalidCount: classified.invalidCount,
      acceptedDurationMs: classified.acceptedDurationMs,
      excludedGapDurationMs: classified.excludedGapDurationMs,
      longestExcludedGapMs: classified.longestExcludedGapMs,
      usableCoveragePercent,
      meanIntervalMs,
      medianIntervalMs,
      minIntervalMs,
      maxIntervalMs,
      standardDeviationMs,
      coefficientOfVariation: acceptedCount
        ? coefficientOfVariation(accepted, meanIntervalMs)
        : null,
      p50IntervalMs: medianIntervalMs,
      p95IntervalMs,
      p99IntervalMs,
      stabilityPercent,
      stabilityClassification: sufficientSample
        ? classifyStability(stabilityPercent)
        : "INSUFFICIENT",
      sufficientSample,
      minimumAcceptedSamples: MIN_ACCEPTED_SAMPLES,
      minimumP99Samples: MIN_P99_SAMPLES,
      statisticsVersion: STATISTICS_VERSION,
      averageFps: meanIntervalMs === null ? null : 1000 / meanIntervalMs,
      medianFps: medianIntervalMs === null ? null : 1000 / medianIntervalMs,
      minimumFps: maxIntervalMs === null ? null : 1000 / maxIntervalMs,
      maximumFps: minIntervalMs === null ? null : 1000 / minIntervalMs,
      lastIntervalFps: acceptedCount ? 1000 / accepted[acceptedCount - 1] : null
    };
  }

  /**
   * Pure hidden-tab pause accumulation. A pause is counted only when its
   * duration is finite and non-negative; negative or non-finite durations are
   * ignored rather than producing negative accounting. The browser must call
   * this once per completed hidden -> visible transition.
   */
  function addHiddenPause(accounting, durationMs) {
    const prior = accounting && typeof accounting === "object" ? accounting : EMPTY_HIDDEN_PAUSE_ACCOUNTING;
    const count = isFiniteNumber(prior.count) && prior.count >= 0 ? Math.floor(prior.count) : 0;
    const accumulatedMs = isFiniteNumber(prior.durationMs) && prior.durationMs >= 0 ? prior.durationMs : 0;

    if (!isFiniteNumber(durationMs) || durationMs < 0) {
      return { count, durationMs: accumulatedMs };
    }

    return {
      count: count + 1,
      durationMs: accumulatedMs + durationMs
    };
  }

  const api = Object.freeze({
    STATISTICS_VERSION,
    MAX_STATISTICS_VERSION,
    MAX_ACCEPTED_INTERVAL_MS,
    MIN_ACCEPTED_SAMPLES,
    MIN_P99_SAMPLES,
    STABILITY_TOLERANCE_RATIO,
    STABLE_THRESHOLD_PERCENT,
    VARIABLE_THRESHOLD_PERCENT,
    DEFAULT_HISTOGRAM_BINS,
    OBSERVATION_KIND,
    EMPTY_HIDDEN_PAUSE_ACCOUNTING,
    normalizeStatisticsVersion,
    resolveStatisticsVersion,
    checkStatisticsCompatibility,
    classifyObservation,
    classifyObservations,
    classifyStability,
    coefficientOfVariation,
    computeStabilityPercent,
    computeStatistics,
    buildHistogram,
    median,
    nearestRankPercentile,
    populationStandardDeviation,
    addHiddenPause
  });

  // Guarded CommonJS export for the Node test suite.
  if (typeof module === "object" && module && module.exports) {
    module.exports = api;
  }

  // Single browser namespace used by script.js. No DOM access is performed here.
  if (typeof window !== "undefined") {
    window.RefreshTestStats = api;
  }
})();
