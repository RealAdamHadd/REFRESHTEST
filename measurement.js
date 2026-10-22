/**
 * RefreshTest measurement lifecycle.
 *
 * Pure, DOM-free run state machine shared by every test mode. It owns raw
 * observation collection, pause/resume accounting, completion, cancellation,
 * and bounded retention. It never schedules animation frames; the browser
 * integration does that. Loading or requiring this file requires stats.js.
 *
 * Callback timestamps are treated as milliseconds from the same time origin as
 * performance.now(). A hidden-tab pause is not a frame interval and is never
 * added to the observation list.
 */
(function () {
  "use strict";

  const Stats = typeof window !== "undefined" && window.RefreshTestStats
    ? window.RefreshTestStats
    : typeof require === "function"
      ? require("./stats.js")
      : null;

  if (!Stats) {
    throw new Error("RefreshTestMeasurement requires stats.js to be loaded first.");
  }

  const RUN_STATE = Object.freeze({
    RUNNING: "running",
    COMPLETED: "completed",
    CANCELLED: "cancelled"
  });

  /**
   * Test windows are active time, excluding hidden-tab pauses.
   *
   * Standard preserves the original eight-second default. Longer modes are
   * optional so the default experience does not become slower.
   */
  const TEST_MODES = Object.freeze({
    quick: Object.freeze({
      id: "quick",
      label: "Quick",
      shortLabel: "3 s",
      durationMs: 3000,
      description: "Fast check for obvious cadence problems; may not collect enough intervals for stable percentiles at low frame rates.",
      tradeOff: "Shortest wait, smallest sample."
    }),
    standard: Object.freeze({
      id: "standard",
      label: "Standard",
      shortLabel: "8 s",
      durationMs: 8000,
      description: "The original RefreshTest window. A practical balance between sample size and waiting.",
      tradeOff: "Default; suitable for most checks."
    }),
    extended: Object.freeze({
      id: "extended",
      label: "Extended",
      shortLabel: "20 s",
      durationMs: 20000,
      description: "Longer observation window for more accepted intervals and a less volatile upper tail.",
      tradeOff: "More samples and a longer wait; conditions can change during the run."
    }),
    diagnostics: Object.freeze({
      id: "diagnostics",
      label: "Diagnostics",
      shortLabel: "30 s",
      durationMs: 30000,
      description: "Largest practical default window for distribution detail and tail estimates.",
      tradeOff: "Best sample size here, but the most exposure to background activity."
    })
  });

  const MODE_ORDER = Object.freeze(["quick", "standard", "extended", "diagnostics"]);
  const DEFAULT_MODE = "standard";
  const DEFAULT_DURATION_MS = TEST_MODES[DEFAULT_MODE].durationMs;
  // Roughly 80 seconds at 300 callbacks/s. Retention is bounded so a stalled or
  // unusually fast callback source cannot grow memory without limit.
  const MAX_OBSERVATIONS = 24000;

  function isFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
  }

  function getMode(modeId) {
    return TEST_MODES[modeId] || TEST_MODES[DEFAULT_MODE];
  }

  function createRun(options) {
    const settings = options && typeof options === "object" ? options : {};
    const mode = getMode(settings.mode);
    const startedAt = settings.startedAt;

    if (!isFiniteNumber(startedAt)) {
      throw new TypeError("createRun requires a finite startedAt timestamp.");
    }

    const requestedDuration = isFiniteNumber(settings.durationMs) && settings.durationMs > 0
      ? settings.durationMs
      : mode.durationMs;
    const requestedCapacity = isFiniteNumber(settings.maxObservations) && settings.maxObservations > 0
      ? Math.floor(settings.maxObservations)
      : MAX_OBSERVATIONS;

    return {
      id: typeof settings.id === "string" && settings.id ? settings.id : null,
      mode: mode.id,
      modeConfig: mode,
      state: RUN_STATE.RUNNING,
      paused: false,
      startedAt,
      activeStartedAt: startedAt,
      activeElapsedMs: 0,
      pausedAt: null,
      durationMs: requestedDuration,
      maxObservations: requestedCapacity,
      lastFrameTimestamp: null,
      observations: [],
      acceptedIntervals: [],
      acceptedCount: 0,
      excludedGapCount: 0,
      excludedGapDurationMs: 0,
      longestExcludedGapMs: 0,
      invalidCount: 0,
      droppedObservations: 0,
      hiddenPauses: { ...Stats.EMPTY_HIDDEN_PAUSE_ACCOUNTING }
    };
  }

  function isLive(run) {
    return Boolean(run) && run.state === RUN_STATE.RUNNING;
  }

  function getElapsedMs(run, now) {
    if (!run || typeof run !== "object") return 0;
    const accumulated = Math.max(0, run.activeElapsedMs || 0);
    if (run.state !== RUN_STATE.RUNNING) return accumulated;
    if (run.paused) {
      return accumulated + Math.max(0, run.pausedAt - run.activeStartedAt);
    }
    if (!isFiniteNumber(now)) return accumulated;
    return accumulated + Math.max(0, now - run.activeStartedAt);
  }

  /**
   * Record one animation callback timestamp. Returns a small result object so
   * the caller can render live diagnostics without asking for statistics.
   */
  function recordFrame(run, frameTimestamp, now) {
    if (!isLive(run)) {
      return { ok: false, reason: "not-running", recorded: false, complete: false };
    }
    if (!isFiniteNumber(frameTimestamp) || !isFiniteNumber(now)) {
      return { ok: false, reason: "invalid-timestamp", recorded: false, complete: false };
    }
    if (run.paused) {
      return {
        ok: true,
        reason: "paused",
        recorded: false,
        complete: false,
        elapsedMs: getElapsedMs(run, now)
      };
    }

    let delta = null;
    let kind = null;
    let stored = false;

    if (run.lastFrameTimestamp !== null) {
      delta = frameTimestamp - run.lastFrameTimestamp;
      if (!isFiniteNumber(delta)) {
        run.invalidCount++;
      } else if (run.observations.length < run.maxObservations) {
        run.observations.push(delta);
        stored = true;
        kind = Stats.classifyObservation(delta);
        if (kind === Stats.OBSERVATION_KIND.ACCEPTED) {
          run.acceptedIntervals.push(delta);
          run.acceptedCount++;
        } else if (kind === Stats.OBSERVATION_KIND.LONG_GAP) {
          run.excludedGapCount++;
          run.excludedGapDurationMs += delta;
          if (delta > run.longestExcludedGapMs) run.longestExcludedGapMs = delta;
        } else {
          run.invalidCount++;
        }
      } else {
        // Never silently truncate a run: the caller can surface this count and
        // the final analysis still describes the retained observations.
        run.droppedObservations++;
      }
    }

    run.lastFrameTimestamp = frameTimestamp;
    const elapsedMs = getElapsedMs(run, now);
    const complete = elapsedMs >= run.durationMs;

    return {
      ok: true,
      recorded: stored,
      delta,
      kind,
      elapsedMs,
      complete,
      acceptedCount: run.acceptedCount,
      excludedGapCount: run.excludedGapCount
    };
  }

  /**
   * Pause a live run. Repeated pause requests are no-ops so duplicate
   * visibilitychange events cannot double-count a hidden interval.
   */
  function pauseRun(run, now) {
    if (!isLive(run) || run.paused || !isFiniteNumber(now)) return false;
    run.paused = true;
    run.pausedAt = now;
    return true;
  }

  /**
   * Resume a paused live run, accumulating hidden time separately and resetting
   * the frame timestamp so the hidden gap can never become an accepted interval.
   */
  function resumeRun(run, now) {
    if (!isLive(run) || !run.paused || !isFiniteNumber(now)) return null;

    const hiddenDurationMs = Math.max(0, now - run.pausedAt);
    run.hiddenPauses = Stats.addHiddenPause(run.hiddenPauses, hiddenDurationMs);
    run.activeElapsedMs += Math.max(0, run.pausedAt - run.activeStartedAt);
    run.activeStartedAt = now;
    run.paused = false;
    run.pausedAt = null;
    run.lastFrameTimestamp = null;

    return {
      hiddenDurationMs,
      hiddenPauses: run.hiddenPauses,
      elapsedMs: getElapsedMs(run, now)
    };
  }

  function completeRun(run, now) {
    if (!isLive(run)) return null;
    const elapsedMs = getElapsedMs(run, now);
    run.activeElapsedMs = elapsedMs;
    run.state = RUN_STATE.COMPLETED;
    run.paused = false;
    run.pausedAt = null;
    run.lastFrameTimestamp = null;
    return elapsedMs;
  }

  function cancelRun(run, now) {
    if (!isLive(run)) return null;
    const elapsedMs = getElapsedMs(run, now);
    run.activeElapsedMs = elapsedMs;
    run.state = RUN_STATE.CANCELLED;
    run.paused = false;
    run.pausedAt = null;
    run.lastFrameTimestamp = null;
    return elapsedMs;
  }

  const api = Object.freeze({
    RUN_STATE,
    TEST_MODES,
    MODE_ORDER,
    DEFAULT_MODE,
    DEFAULT_DURATION_MS,
    MAX_OBSERVATIONS,
    createRun,
    isLive,
    getMode,
    getElapsedMs,
    recordFrame,
    pauseRun,
    resumeRun,
    completeRun,
    cancelRun
  });

  if (typeof module === "object" && module && module.exports) {
    module.exports = api;
  }

  if (typeof window !== "undefined") {
    window.RefreshTestMeasurement = api;
  }
})();
