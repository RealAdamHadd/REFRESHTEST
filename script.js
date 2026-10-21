/**
 * RefreshTest V2 browser integration.
 *
 * This file owns DOM wiring only. Measurement lifecycle lives in
 * measurement.js, statistics in stats.js, interpretation in insights.js,
 * persistence in storage.js, and cross-session comparison in comparison.js.
 *
 * Canvas drawing, local file downloads, and localStorage access are the only
 * browser-specific behaviours here. No network requests are made, and imported
 * or stored values are always rendered with textContent, never innerHTML.
 */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const Stats = window.RefreshTestStats;
  const Measurement = window.RefreshTestMeasurement;
  const Insights = window.RefreshTestInsights;
  const Storage = window.RefreshTestStorage;
  const Comparison = window.RefreshTestComparison;

  if (!Stats || !Measurement || !Insights || !Storage || !Comparison) {
    const status = $("statusText");
    if (status) status.textContent = "MODULE LOAD ERROR";
    return;
  }

  const frameCanvas = $("frameGraph");
  const frameContext = frameCanvas && frameCanvas.getContext ? frameCanvas.getContext("2d") : null;
  const runButton = $("startTest");
  const motion = $("motionObject");
  const track = document.querySelector(".motion-track");
  const speedButtons = [...document.querySelectorAll("[data-speed]")];
  const modeButtons = [...document.querySelectorAll("[data-mode]")];
  const viewElements = [...document.querySelectorAll("[data-view]")];
  const navLinks = [...document.querySelectorAll("[data-view-link]")];
  const reduceMotion = window.matchMedia
    ? window.matchMedia("(prefers-reduced-motion: reduce)")
    : { matches: false };

  const VIEWS = Object.freeze(["test", "history", "compare", "lab"]);
  const VIEW_TITLES = Object.freeze({
    test: "Screen Refresh Rate Test — RefreshTest",
    history: "Session History — RefreshTest",
    compare: "Session Comparison — RefreshTest",
    lab: "Advanced Lab — RefreshTest"
  });
  const RENDER_INTERVAL_MS = 100;
  const MAX_GRAPH_POINTS = 180;
  const MAX_CHART_POINTS = 6;
  const CHART_COLORS = Object.freeze(["#76d8ca", "#f4b35e", "#ed796c", "#9ab7e8", "#c7a6e0", "#8fbfb5"]);

  let activeRun = null;
  let measureFrame = 0;
  let measureToken = 0;
  let motionFrame = 0;
  let lastGraphDraw = 0;
  let motionSpeed = 1;
  let currentMode = Measurement.DEFAULT_MODE;
  let lastResult = null;
  let currentView = "test";
  let sessionCache = [];
  let storageAvailable = false;
  let storageLoadErrors = [];
  let selectedForExport = new Set();
  let compareSelected = new Set();
  let detailSessionId = null;
  let labRunButtons = [];
  let pendingCompareResize = 0;

  function getStorage() {
    try {
      return window.localStorage;
    } catch (_) {
      return null;
    }
  }

  function getBrowser() {
    const ua = navigator.userAgent;
    if (/Edg\//.test(ua)) return "Microsoft Edge";
    if (/Firefox\//.test(ua)) return "Firefox";
    if (/Chrome\//.test(ua)) return "Google Chrome";
    if (/Safari\//.test(ua)) return "Safari";
    return "Unknown";
  }

  function getOperatingSystem() {
    const value = navigator.userAgentData?.platform || navigator.platform || navigator.userAgent;
    if (/Windows/i.test(value)) return "Windows";
    if (/Mac/i.test(value)) return "macOS";
    if (/Android/i.test(value)) return "Android";
    if (/iPhone|iPad|iPod/i.test(value)) return "iOS";
    if (/Linux/i.test(value)) return "Linux";
    return "Not exposed";
  }

  function getEnvironment() {
    return {
      browser: getBrowser(),
      os: getOperatingSystem(),
      devicePixelRatio: window.devicePixelRatio || 1
    };
  }

  function updateEnvironment() {
    const ratio = window.devicePixelRatio || 1;
    setText("resolution", `${screen.width} × ${screen.height}`);
    setText("viewport", `${innerWidth} × ${innerHeight} CSS px`);
    setText("pixelRatio", `${ratio.toFixed(2)}×`);
    setText("browser", getBrowser());
    setText("operatingSystem", getOperatingSystem());
    drawGraph(activeRun && activeRun.acceptedIntervals ? activeRun.acceptedIntervals : []);
  }

  function setText(id, value) {
    const element = $(id);
    if (element) element.textContent = value;
  }

  function setMetricParts(id, parts) {
    const output = $(id);
    if (!output) return;
    const fragment = document.createDocumentFragment();
    parts.forEach(({ text, small = false }) => {
      if (small) {
        const unit = document.createElement("small");
        unit.textContent = text;
        fragment.append(unit);
      } else {
        fragment.append(document.createTextNode(text));
      }
    });
    output.replaceChildren(fragment);
  }

  function setMetric(id, value, unit) {
    if (value === null || value === undefined) {
      setMetricParts(id, [{ text: "—" }]);
      return;
    }
    setMetricParts(id, [{ text: value }, { text: unit, small: true }]);
  }

  function formatNumber(value, digits = 1) {
    return Number.isFinite(value) ? value.toFixed(digits) : "—";
  }

  function formatPercentValue(value, digits = 2) {
    return Number.isFinite(value) ? `${(value * 100).toFixed(digits)}%` : "—";
  }

  function formatDuration(ms) {
    if (!Number.isFinite(ms) || ms < 0) return "—";
    return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
  }

  function setStatus(text, mode = "") {
    setText("statusText", text);
    const dot = $("statusDot");
    if (dot) dot.className = `state-dot ${mode}`;
  }

  function setRunButton(text, disabled = false) {
    if (!runButton) return;
    runButton.disabled = disabled;
    const label = runButton.querySelector("span:nth-child(2)");
    if (label) label.textContent = text;
  }

  function isRunning() {
    return Boolean(activeRun) && Measurement.isLive(activeRun);
  }

  // ---------------------------------------------------------------------------
  // Measurement lifecycle
  // ---------------------------------------------------------------------------

  function resetStatistics() {
    setText("currentHz", "—");
    setText("liveFps", "—");
    setText("avgFps", "—");
    setText("minFps", "—");
    setText("maxFps", "—");
    setMetric("avgFrameTime", null, "ms");
    setMetric("minMaxFrameTime", null, "ms");
    setMetric("variation", null, "ms");
    setMetric("stability", null, "%");
    setText("stabilityLabel", "NO DATA");
    setText("framesTested", "—");
    setMetric("testDuration", null, "s");
    setText("sampleCount", "0 samples");
    setMetric("p50Interval", null, "ms");
    setMetric("p95Interval", null, "ms");
    setMetric("p99Interval", null, "ms");
    setMetric("coverage", null, "%");
    setText("p95Note", `Needs ${Stats.MIN_ACCEPTED_SAMPLES} accepted`);
    setText("p99Note", `Needs ${Stats.MIN_P99_SAMPLES} accepted`);
    setText("diagnostics", `P95 — (needs ${Stats.MIN_ACCEPTED_SAMPLES} accepted) · 0 accepted · 0 long gaps · coverage —`);
  }

  function resetResultArea() {
    const extras = $("resultExtras");
    if (extras) extras.hidden = true;
    const insights = $("insightPanel");
    if (insights) insights.hidden = true;
    setSaveStatus("");
    renderLabEmpty();
  }

  function startMeasurement() {
    if (isRunning()) return;

    cancelScheduledFrame();
    activeRun = null;
    lastResult = null;
    resetResultArea();
    resetStatistics();
    updateSaveAvailability();
    drawGraph([]);

    const startedAt = performance.now();
    const run = Measurement.createRun({ mode: currentMode, startedAt });
    const token = ++measureToken;
    run.measureToken = token;
    run.wallClockStartedAt = Date.now();
    activeRun = run;

    setText("readoutCaption", "Live refresh rate");
    setStatus(document.hidden ? "PAUSED" : "SAMPLING...", "active");
    setRunButton("Cancel measurement");
    document.body.classList.add("measuring");
    updateModeControls();

    if (document.hidden) {
      Measurement.pauseRun(run, startedAt);
      setText("rateNote", "Tab hidden · sampling paused until the tab is visible again");
      return;
    }

    setText("rateNote", `Sampling ${run.modeConfig.label.toLowerCase()} · keep this tab visible`);
    scheduleMeasurementFrame();
  }

  function scheduleMeasurementFrame() {
    cancelScheduledFrame();
    measureFrame = requestAnimationFrame(measure);
  }

  function cancelScheduledFrame() {
    if (measureFrame) {
      cancelAnimationFrame(measureFrame);
      measureFrame = 0;
    }
  }

  function measure(frameTimestamp) {
    measureFrame = 0;
    const run = activeRun;
    if (!run || run.measureToken !== measureToken || !Measurement.isLive(run) || document.hidden) return;

    const now = performance.now();
    const frameResult = Measurement.recordFrame(run, frameTimestamp, now);
    if (!frameResult.ok) return;

    if (frameResult.recorded) renderLive(run, now);

    if (frameResult.complete) {
      completeMeasurement(run);
      return;
    }

    scheduleMeasurementFrame();
  }

  function completeMeasurement(run) {
    if (run !== activeRun || !Measurement.isLive(run)) return;

    cancelScheduledFrame();
    const elapsedMs = Measurement.completeRun(run, performance.now());
    if (elapsedMs === null) return;

    measureToken++;
    activeRun = null;
    document.body.classList.remove("measuring");
    updateModeControls();
    setRunButton("Run again");

    const summary = Stats.computeStatistics(run.observations);
    const result = {
      summary,
      observations: run.observations.slice(),
      acceptedIntervals: summary.acceptedIntervals.slice(),
      elapsedMs,
      durationMs: run.durationMs,
      mode: run.mode,
      modeLabel: run.modeConfig.label,
      modeShortLabel: run.modeConfig.shortLabel,
      wallClockStartedAt: run.wallClockStartedAt,
      hiddenPauses: { ...run.hiddenPauses },
      droppedObservations: run.droppedObservations,
      diagnostics: {
        invalidCount: summary.invalidCount,
        droppedObservations: run.droppedObservations,
        observationCount: run.observations.length
      },
      environment: getEnvironment(),
      savedId: null,
      sessionRecord: null,
      insights: null
    };
    lastResult = result;

    renderCompletedResult(result);
    renderInsights(result);
    renderLabResult(result);
    updateSaveAvailability();

    if (summary.acceptedCount === 0) {
      setStatus("NO DATA");
      setText("readoutCaption", "REFRESH RATE");
      setText("rateNote", "No accepted frame intervals captured. Keep this tab visible and run again.");
    } else if (!summary.sufficientSample) {
      setStatus("INSUFFICIENT");
    } else {
      setStatus("SAMPLE COMPLETE", "complete");
    }
  }

  function cancelMeasurement(reason) {
    const run = activeRun;
    if (!run || !Measurement.isLive(run)) return;

    cancelScheduledFrame();
    const elapsedMs = Measurement.cancelRun(run, performance.now());
    measureToken++;
    activeRun = null;
    lastResult = null;
    document.body.classList.remove("measuring");
    updateModeControls();
    setRunButton("Run measurement");
    resetStatistics();
    resetResultArea();
    updateSaveAvailability();
    drawGraph([]);
    setStatus("CANCELLED");
    setText("readoutCaption", "Refresh rate");
    setText(
      "rateNote",
      reason === "navigation"
        ? `Measurement cancelled after ${formatDuration(elapsedMs)} because you left the Test view. No result was saved.`
        : `Measurement cancelled after ${formatDuration(elapsedMs)}. No result was saved.`
    );
  }

  function renderCompletedResult(result) {
    const { summary, elapsedMs, hiddenPauses } = result;
    setText("sampleCount", `${summary.acceptedCount.toLocaleString()} sample${summary.acceptedCount === 1 ? "" : "s"}`);

    setText("currentHz", formatNumber(summary.medianFps, 1));
    setText("liveFps", formatNumber(summary.lastIntervalFps, 1));
    setText("avgFps", formatNumber(summary.averageFps, 1));
    setText("minFps", formatNumber(summary.minimumFps, 1));
    setText("maxFps", formatNumber(summary.maximumFps, 1));
    setMetric("avgFrameTime", formatNumber(summary.meanIntervalMs, 2), "ms");
    setMetric(
      "minMaxFrameTime",
      summary.minIntervalMs === null || summary.maxIntervalMs === null
        ? null
        : `${summary.minIntervalMs.toFixed(2)} / ${summary.maxIntervalMs.toFixed(2)}`,
      "ms"
    );
    setMetric("variation", formatNumber(summary.standardDeviationMs, 2), "ms");
    if (summary.sufficientSample) {
      setMetric("stability", formatNumber(summary.stabilityPercent, 1), "%");
      setText("stabilityLabel", summary.stabilityClassification);
    } else {
      setMetric("stability", null, "%");
      setText("stabilityLabel", summary.acceptedCount ? "INSUFFICIENT" : "NO DATA");
    }
    setText("framesTested", summary.acceptedCount.toLocaleString());
    setMetric("testDuration", (elapsedMs / 1000).toFixed(1), "s");
    setMetric("p50Interval", formatNumber(summary.p50IntervalMs, 2), "ms");
    setMetric("p95Interval", formatNumber(summary.p95IntervalMs, 2), "ms");
    setMetric("p99Interval", formatNumber(summary.p99IntervalMs, 2), "ms");
    setMetric("coverage", formatNumber(summary.usableCoveragePercent, 1), "%");
    setText(
      "p95Note",
      summary.p95IntervalMs === null
        ? `Needs ${Stats.MIN_ACCEPTED_SAMPLES} accepted`
        : "Nearest-rank percentile"
    );
    setText(
      "p99Note",
      summary.p99IntervalMs === null
        ? `Needs ${Stats.MIN_P99_SAMPLES} accepted`
        : "Nearest-rank percentile"
    );
    setText("diagnostics", formatDiagnostics(summary, hiddenPauses));

    setText("readoutCaption", summary.acceptedCount ? "Measured browser frame cadence" : "Refresh rate");
    const noteParts = [];
    if (summary.excludedGapCount) {
      noteParts.push(
        `${summary.excludedGapCount} long gap${summary.excludedGapCount === 1 ? "" : "s"} excluded · longest ${formatDuration(summary.longestExcludedGapMs)}`
      );
    } else {
      noteParts.push("0 long gaps excluded");
    }
    if (hiddenPauses.count) {
      noteParts.push(`${hiddenPauses.count} hidden pause${hiddenPauses.count === 1 ? "" : "s"} · ${formatDuration(hiddenPauses.durationMs)}`);
    }
    noteParts.push("cadence uses median interval");
    setText("rateNote", noteParts.join(" · "));

    const extras = $("resultExtras");
    if (extras) extras.hidden = false;
    const summaryParts = [
      `${result.modeLabel} · ${(elapsedMs / 1000).toFixed(1)} s active`,
      `${summary.acceptedCount.toLocaleString()} accepted interval${summary.acceptedCount === 1 ? "" : "s"}`
    ];
    if (summary.medianIntervalMs !== null && summary.medianFps !== null) {
      summaryParts.push(
        `median ${summary.medianIntervalMs.toFixed(2)} ms (${summary.medianFps.toFixed(1)} FPS)`
      );
    }
    if (!summary.sufficientSample) {
      summaryParts.push("P95, P99, and stability withheld");
    } else if (summary.p99IntervalMs === null) {
      summaryParts.push("P99 withheld");
    }
    setText("resultSummary", `${summaryParts.join(" · ")}.`);
    setText("readoutCaption", summary.acceptedCount ? "Measured browser frame cadence" : "Refresh rate");
    drawGraph(summary.acceptedIntervals);
  }

  function formatDiagnostics(summary, pauses) {
    const p95 = summary.p95IntervalMs === null
      ? `P95 — (needs ${Stats.MIN_ACCEPTED_SAMPLES} accepted)`
      : `P95 ${summary.p95IntervalMs.toFixed(2)} ms`;
    const p99 = summary.p99IntervalMs === null
      ? `P99 — (needs ${Stats.MIN_P99_SAMPLES} accepted)`
      : `P99 ${summary.p99IntervalMs.toFixed(2)} ms`;
    const gaps = summary.excludedGapCount
      ? `${summary.excludedGapCount} long gap${summary.excludedGapCount === 1 ? "" : "s"} · ${formatDuration(summary.excludedGapDurationMs)} excluded · longest ${formatDuration(summary.longestExcludedGapMs)}`
      : "0 long gaps · 0 ms excluded";
    const coverage = summary.usableCoveragePercent === null
      ? "coverage —"
      : `coverage ${summary.usableCoveragePercent.toFixed(1)}%`;
    const pause = pauses && pauses.count
      ? ` · ${pauses.count} hidden pause${pauses.count === 1 ? "" : "s"} · ${formatDuration(pauses.durationMs)}`
      : "";
    return `${p95} · ${p99} · ${summary.acceptedCount} accepted · ${gaps} · ${coverage}${pause}`;
  }

  function renderLive(run, now) {
    if (now - lastGraphDraw < RENDER_INTERVAL_MS) return;
    lastGraphDraw = now;
    const accepted = run.acceptedIntervals;
    if (accepted.length) {
      const recent = accepted.slice(-31);
      const recentMedian = Stats.median(recent);
      if (recentMedian !== null) setText("currentHz", (1000 / recentMedian).toFixed(1));
      setText("liveFps", (1000 / accepted[accepted.length - 1]).toFixed(1));
      setText("sampleCount", `${accepted.length.toLocaleString()} samples`);
    }
    drawGraph(accepted);

    const elapsed = Measurement.getElapsedMs(run, now);
    const noteParts = [
      `Sampling ${(elapsed / 1000).toFixed(1)} / ${(run.durationMs / 1000).toFixed(0)} s`,
      "keep this tab visible"
    ];
    if (run.excludedGapCount) {
      noteParts.push(`${run.excludedGapCount} long gap${run.excludedGapCount === 1 ? "" : "s"} excluded`);
    }
    if (run.hiddenPauses.count) {
      noteParts.push(`${run.hiddenPauses.count} hidden pause${run.hiddenPauses.count === 1 ? "" : "s"}`);
    }
    setText("rateNote", noteParts.join(" · "));
  }

  // ---------------------------------------------------------------------------
  // Frame graph
  // ---------------------------------------------------------------------------

  function drawGraph(values) {
    if (!frameContext) return;
    const box = frameCanvas.getBoundingClientRect();
    if (!box.width || !box.height) return;
    const ratio = window.devicePixelRatio || 1;
    const pixelWidth = Math.round(box.width * ratio);
    const pixelHeight = Math.round(box.height * ratio);
    if (frameCanvas.width !== pixelWidth || frameCanvas.height !== pixelHeight) {
      frameCanvas.width = pixelWidth;
      frameCanvas.height = pixelHeight;
    }
    frameContext.setTransform(ratio, 0, 0, ratio, 0, 0);
    const width = box.width;
    const height = box.height;
    frameContext.clearRect(0, 0, width, height);
    frameContext.strokeStyle = "rgba(166,188,190,.09)";
    frameContext.lineWidth = 1;
    for (let row = 1; row < 4; row++) {
      const y = Math.round(height * row / 4) + 0.5;
      frameContext.beginPath();
      frameContext.moveTo(0, y);
      frameContext.lineTo(width, y);
      frameContext.stroke();
    }

    const recent = Array.isArray(values) ? values.slice(-MAX_GRAPH_POINTS) : [];
    if (!recent.length) return;
    const typical = Stats.median(recent);
    if (typical === null) return;
    const maximum = Math.max(30, typical * 2.1, ...recent);
    const yFor = (value) => height - Math.min(value, maximum) / maximum * (height - 8) - 4;
    frameContext.setLineDash([3, 5]);
    frameContext.strokeStyle = "rgba(244,179,94,.58)";
    frameContext.beginPath();
    frameContext.moveTo(0, yFor(typical));
    frameContext.lineTo(width, yFor(typical));
    frameContext.stroke();
    frameContext.setLineDash([]);

    // Split the trace into three paths so abnormal intervals are identifiable
    // without a separate stroke call per sample.
    const paths = [new Path2D(), new Path2D(), new Path2D()];
    recent.forEach((value, index) => {
      if (index === 0) return;
      const prior = recent[index - 1];
      const level = Math.max(value, prior) > typical * 2.5 ? 2 : Math.max(value, prior) > typical * 1.5 ? 1 : 0;
      const x0 = (index - 1) * width / Math.max(1, recent.length - 1);
      const x1 = index * width / Math.max(1, recent.length - 1);
      paths[level].moveTo(x0, yFor(prior));
      paths[level].lineTo(x1, yFor(value));
    });
    frameContext.lineWidth = 2;
    frameContext.lineJoin = "round";
    frameContext.lineCap = "round";
    ["#76d8ca", "#f4b35e", "#ed796c"].forEach((color, index) => {
      frameContext.strokeStyle = color;
      frameContext.stroke(paths[index]);
    });
    frameContext.fillStyle = "#d9fff5";
    frameContext.beginPath();
    frameContext.arc(width - 1, yFor(recent[recent.length - 1]), 3, 0, Math.PI * 2);
    frameContext.fill();
  }

  // ---------------------------------------------------------------------------
  // Mode controls
  // ---------------------------------------------------------------------------

  function modeDurationSeconds(mode) {
    return Math.round(mode.durationMs / 1000);
  }

  function setMode(modeId) {
    if (isRunning()) return;
    const mode = Measurement.getMode(modeId);
    currentMode = mode.id;

    modeButtons.forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.mode === currentMode));
    });
    setText(
      "modeDescription",
      `${mode.label} samples ${modeDurationSeconds(mode)} seconds of active time. ${mode.tradeOff}`
    );
    const sampleWindow = $("sampleWindowValue");
    if (sampleWindow) {
      const small = document.createElement("small");
      small.textContent = "seconds";
      sampleWindow.replaceChildren(
        document.createTextNode(`${modeDurationSeconds(mode)} `),
        small
      );
    }
    labRunButtons.forEach((button) => {
      const card = button.closest(".lab-card");
      card?.setAttribute("data-selected", String(button.dataset.labMode === currentMode));
    });
  }

  function updateModeControls() {
    const running = isRunning();
    modeButtons.forEach((button) => {
      button.disabled = running;
    });
    labRunButtons.forEach((button) => {
      button.disabled = running;
    });
  }

  function buildLabModes() {
    const host = $("labModes");
    if (!host) return;
    host.replaceChildren();
    labRunButtons = [];
    Measurement.MODE_ORDER.forEach((modeId) => {
      const mode = Measurement.TEST_MODES[modeId];
      const card = document.createElement("article");
      card.className = "lab-card";
      card.dataset.selected = String(mode.id === currentMode);

      const title = document.createElement("h3");
      title.textContent = mode.label;
      const duration = document.createElement("span");
      duration.className = "lab-duration";
      duration.textContent = `${modeDurationSeconds(mode)} s active window`;
      const description = document.createElement("p");
      description.textContent = mode.description;
      const tradeOff = document.createElement("p");
      tradeOff.className = "lab-tradeoff";
      tradeOff.textContent = mode.tradeOff;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "secondary-button";
      button.dataset.labMode = mode.id;
      button.textContent = `Use ${mode.label}`;
      button.addEventListener("click", () => {
        if (isRunning()) return;
        setMode(mode.id);
        navigateTo("test");
      });

      card.append(title, duration, description, tradeOff, button);
      host.append(card);
      labRunButtons.push(button);
    });
    updateModeControls();
  }

  // ---------------------------------------------------------------------------
  // Insights
  // ---------------------------------------------------------------------------

  function renderInsights(result) {
    const panel = $("insightPanel");
    const list = $("insightList");
    if (!panel || !list) return;

    const candidates = [];
    sessionCache.forEach((record) => {
      const derived = Comparison.deriveSessionSummary(record);
      if (!derived) return;
      const view = Comparison.sessionView(record);
      candidates.push({
        summary: derived.summary,
        label: view.label,
        mode: record.mode || null,
        durationMs: Number.isFinite(record.durationMs) ? record.durationMs : null,
        statisticsVersion: view.statisticsVersion,
        statisticsVersionConflict: view.statisticsVersionConflict
      });
    });

    const current = {
      summary: result.summary,
      mode: result.mode,
      durationMs: result.elapsedMs,
      statisticsVersion: result.summary.statisticsVersion
    };
    const selection = Insights.selectPreviousSession(current, candidates);
    let previous = selection ? selection.previous : null;
    if (previous && selection.compatible && selection.skippedCount > 0) {
      previous = {
        ...previous,
        label: `${previous.label || "Saved session"} · ${selection.skippedCount} newer saved session${selection.skippedCount === 1 ? " was" : "s were"} not comparable`
      };
    }

    const insights = Insights.buildInsights(result.summary, {
      mode: result.mode,
      durationMs: result.elapsedMs,
      modeLabel: result.modeLabel,
      statisticsVersion: result.summary.statisticsVersion,
      hiddenPauses: result.hiddenPauses,
      previous,
      droppedObservations: result.droppedObservations
    });
    result.insights = insights;

    setText("insightHeadline", insights.headline);
    setText("insightLimitations", insights.limitations.join(" "));
    list.replaceChildren();
    insights.findings.forEach((finding) => {
      const item = document.createElement("li");
      item.className = `insight-item ${finding.severity}`;
      const title = document.createElement("h4");
      title.textContent = finding.title;
      const evidence = document.createElement("p");
      evidence.className = "insight-evidence";
      evidence.textContent = finding.evidence;
      const explanation = document.createElement("p");
      explanation.textContent = finding.explanation;
      item.append(title, evidence, explanation);
      if (finding.recommendation) {
        const recommendation = document.createElement("p");
        recommendation.className = "insight-recommendation";
        recommendation.textContent = `Suggestion: ${finding.recommendation}`;
        item.append(recommendation);
      }
      const confidence = document.createElement("span");
      confidence.className = "insight-confidence";
      confidence.textContent = `${finding.confidence} confidence`;
      item.append(confidence);
      list.append(item);
    });
    panel.hidden = false;
  }

  // ---------------------------------------------------------------------------
  // Local history
  // ---------------------------------------------------------------------------

  function setHistoryStatus(message, isError = false) {
    const status = $("historyStatus");
    if (!status) return;
    status.textContent = message || "";
    status.classList.toggle("error", Boolean(isError));
  }

  function setSaveStatus(message, isError = false) {
    const status = $("saveStatus");
    if (!status) return;
    status.textContent = message || "";
    status.classList.toggle("error", Boolean(isError));
  }

  function refreshHistory() {
    const storage = getStorage();
    const loaded = Storage.loadSessions(storage);
    storageAvailable = loaded.available === true;
    sessionCache = loaded.available ? loaded.sessions : [];
    storageLoadErrors = Array.isArray(loaded.errors) ? loaded.errors : [];

    const knownIds = new Set(sessionCache.map((record) => record.id));
    selectedForExport = new Set([...selectedForExport].filter((id) => knownIds.has(id)));
    compareSelected = new Set(
      [...compareSelected]
        .filter((id) => knownIds.has(id))
        .slice(0, Comparison.MAX_COMPARE_SESSIONS)
    );
    if (detailSessionId && !knownIds.has(detailSessionId)) detailSessionId = null;

    const state = $("historyStorageState");
    if (state) {
      if (!storageAvailable) {
        state.textContent = "Storage unavailable";
      } else {
        const quarantined = storageLoadErrors.filter((error) => error.quarantined).length;
        const retained = storageLoadErrors.filter((error) => error.retained).length;
        const parts = [`${sessionCache.length} saved`];
        if (quarantined) parts.push(`${quarantined} set aside`);
        if (retained) parts.push(`${retained} unreadable`);
        state.textContent = parts.join(" · ");
      }
    }

    if (!storageAvailable) {
      setHistoryStatus("Browser local storage is unavailable. Results can still be exported from the Test view.", true);
    } else if (storageLoadErrors.length) {
      const quarantined = storageLoadErrors.filter((error) => error.quarantined).length;
      const retained = storageLoadErrors.filter((error) => error.retained).length;
      const parts = [];
      if (quarantined) {
        parts.push(`${quarantined} unreadable record${quarantined === 1 ? " was" : "s were"} moved to quarantine.`);
      }
      if (retained) {
        parts.push(`${retained} unreadable record${retained === 1 ? " was" : "s were"} kept in place because it could not be copied to quarantine; no data was deleted.`);
      }
      if (!quarantined && !retained) {
        parts.push(`${storageLoadErrors.length} saved record${storageLoadErrors.length === 1 ? "" : "s"} needed attention.`);
      }
      parts.push("Other sessions are unaffected.");
      setHistoryStatus(parts.join(" "), true);
    }

    renderHistory();
    renderCompareSelector();
    renderCompare();
    updateHistoryCount();
    updateSaveAvailability();
  }

  function updateHistoryCount() {
    const count = $("historyCount");
    if (!count) return;
    count.textContent = String(sessionCache.length);
    count.hidden = sessionCache.length === 0;
  }

  function renderHistory() {
    const host = $("historyList");
    if (!host) return;
    host.replaceChildren();

    const exportSelectedButton = $("exportSelected");
    if (exportSelectedButton) exportSelectedButton.disabled = selectedForExport.size === 0;
    const clearButton = $("clearHistory");
    if (clearButton) clearButton.disabled = sessionCache.length === 0;

    if (!storageAvailable) {
      host.append(emptyState(
        "Local storage is unavailable",
        "This browser blocked localStorage for this page. Measurements still work; use Export JSON on the Test view to keep a copy."
      ));
      renderHistoryDetail();
      return;
    }

    if (sessionCache.length === 0) {
      host.append(emptyState(
        "No saved sessions",
        "Run a measurement, then choose Save session to store it locally in this browser. Nothing is uploaded."
      ));
      renderHistoryDetail();
      return;
    }

    sessionCache.forEach((record) => host.append(buildSessionCard(record)));
    renderHistoryDetail();
  }

  function emptyState(title, message) {
    const box = document.createElement("div");
    box.className = "empty-state";
    const heading = document.createElement("strong");
    heading.textContent = title;
    const copy = document.createElement("p");
    copy.textContent = message;
    box.append(heading, copy);
    return box;
  }

  function buildSessionCard(record) {
    const view = Comparison.sessionView(record);
    const card = document.createElement("article");
    card.className = "session-card";

    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = selectedForExport.has(record.id);
    check.setAttribute("aria-label", `Select ${view.label} for export`);
    check.addEventListener("change", () => {
      if (check.checked) selectedForExport.add(record.id);
      else selectedForExport.delete(record.id);
      const button = $("exportSelected");
      if (button) button.disabled = selectedForExport.size === 0;
    });

    const main = document.createElement("div");
    main.className = "session-main";
    const date = document.createElement("div");
    date.className = "session-date";
    date.textContent = Comparison.formatSavedAt(record.savedAt);
    const title = document.createElement("h3");
    title.className = "session-title";
    title.textContent = view.modeLabel;
    const meta = document.createElement("div");
    meta.className = "session-meta";
    meta.append(
      metaItem("Median", formatNumber(view.summary?.medianIntervalMs, 2), " ms"),
      metaItem("Median FPS", formatNumber(view.summary?.medianFps, 1)),
      metaItem("Accepted", view.summary ? view.summary.acceptedCount.toLocaleString() : "—"),
      metaItem("Active", formatDuration(record.durationMs)),
      metaItem("Source", view.source === "recomputed" ? "raw intervals" : "raw unavailable")
    );
    main.append(date, title, meta);

    const actions = document.createElement("div");
    actions.className = "session-actions";
    actions.append(
      actionButton("View", () => {
        detailSessionId = detailSessionId === record.id ? null : record.id;
        renderHistoryDetail();
      }),
      actionButton("Compare", () => addComparisonSelection(record.id)),
      actionButton("Export", () => exportRecords([record], `refreshtest-session-${record.id}.json`)),
      actionButton("Delete", () => deleteRecord(record), "danger-button")
    );

    card.append(check, main, actions);
    return card;
  }

  function addComparisonSelection(id) {
    if (!compareSelected.has(id) && compareSelected.size >= Comparison.MAX_COMPARE_SESSIONS) {
      const message = `Up to ${Comparison.MAX_COMPARE_SESSIONS} sessions can be compared at once. Deselect one before adding another.`;
      if (currentView === "history") setHistoryStatus(message, true);
      else setCompareStatus(message, true);
      return;
    }
    compareSelected.add(id);
    navigateTo("compare");
  }

  function metaItem(label, value, suffix = "") {
    const item = document.createElement("span");
    item.textContent = `${label} `;
    const strong = document.createElement("b");
    strong.textContent = `${value}${suffix}`;
    item.append(strong);
    return item;
  }

  function actionButton(label, handler, className = "secondary-button") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = label;
    button.addEventListener("click", handler);
    return button;
  }

  function renderHistoryDetail() {
    const host = $("historyDetail");
    if (!host) return;
    host.replaceChildren();
    if (!detailSessionId) {
      host.hidden = true;
      return;
    }
    const record = sessionCache.find((candidate) => candidate.id === detailSessionId);
    if (!record) {
      host.hidden = true;
      return;
    }
    host.hidden = false;

    const view = Comparison.sessionView(record);
    const derived = Comparison.deriveSessionSummary(record);
    const summary = derived ? derived.summary : record.summary;

    const head = document.createElement("div");
    head.className = "detail-head";
    const heading = document.createElement("div");
    const title = document.createElement("h3");
    title.textContent = `${view.modeLabel} · ${Comparison.formatSavedAt(record.savedAt)}`;
    const note = document.createElement("p");
    note.textContent = derived && derived.source === "recomputed"
      ? "Metrics recomputed from the stored raw intervals with the current statistics version."
      : "Raw intervals are unavailable. The stored summary is shown for reference but is not used for comparison.";
    heading.append(title, note);

    const actions = document.createElement("div");
    actions.className = "detail-actions";
    actions.append(
      actionButton("Compare", () => addComparisonSelection(record.id)),
      actionButton("Export", () => exportRecords([record], `refreshtest-session-${record.id}.json`)),
      actionButton("Delete", () => deleteRecord(record), "danger-button")
    );
    head.append(heading, actions);

    const rows = [
      ["Saved", Comparison.formatSavedAt(record.savedAt), "Local browser time is displayed in UTC."],
      ["Mode", record.modeLabel || record.mode, "Measurement window used for this session."],
      ["Active duration", formatDuration(record.durationMs), "Hidden-tab pauses are excluded."],
      ["Accepted intervals", summary ? summary.acceptedCount.toLocaleString() : "—", "Intervals at or below 250 ms."],
      ["Median interval", summary ? `${formatNumber(summary.medianIntervalMs, 2)} ms` : "—", "P50, nearest-rank definition."],
      ["Median FPS", summary ? formatNumber(summary.medianFps, 1) : "—", "1000 divided by the median interval."],
      ["P95 interval", summary ? `${formatNumber(summary.p95IntervalMs, 2)} ms` : "—", "Requires 30 accepted intervals."],
      ["P99 interval", summary ? `${formatNumber(summary.p99IntervalMs, 2)} ms` : "—", "Requires 100 accepted intervals."],
      ["Population σ", summary ? `${formatNumber(summary.standardDeviationMs, 2)} ms` : "—", "Denominator n."],
      ["Coefficient of variation", summary ? formatPercentValue(summary.coefficientOfVariation) : "—", "Population σ divided by the mean."],
      ["Stability", summary ? `${formatNumber(summary.stabilityPercent, 1)}% · ${summary.stabilityClassification}` : "—", "Share within ±5% of the median."],
      ["Usable coverage", summary ? `${formatNumber(summary.usableCoveragePercent, 1)}%` : "—", "Accepted interval time versus excluded gaps."],
      ["Long gaps", summary ? summary.excludedGapCount.toLocaleString() : "—", "Intervals above 250 ms, excluded from cadence."],
      ["Hidden pauses", record.hiddenPauses ? `${record.hiddenPauses.count} · ${formatDuration(record.hiddenPauses.durationMs)}` : "—", "Visibility pauses are not frame intervals."],
      ["Browser", record.environment?.browser || "—", "Browser-reported at save time."],
      ["Operating system", record.environment?.os || "—", "Browser-reported at save time."]
    ];

    const scroll = document.createElement("div");
    scroll.className = "table-scroll";
    const table = document.createElement("table");
    table.className = "data-table";
    const caption = document.createElement("caption");
    caption.textContent = "Saved session detail";
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    ["Metric", "Value", "Definition"].forEach((label) => {
      const th = document.createElement("th");
      th.scope = "col";
      th.textContent = label;
      headRow.append(th);
    });
    thead.append(headRow);
    const tbody = document.createElement("tbody");
    rows.forEach(([label, value, definition]) => {
      const row = document.createElement("tr");
      const th = document.createElement("th");
      th.scope = "row";
      th.textContent = label;
      const td = document.createElement("td");
      td.textContent = value;
      const noteCell = document.createElement("td");
      noteCell.textContent = definition;
      row.append(th, td, noteCell);
      tbody.append(row);
    });
    table.append(caption, thead, tbody);
    scroll.append(table);
    host.append(head, scroll);
  }

  function deleteRecord(record) {
    if (!window.confirm("Delete this saved session? This cannot be undone.")) return;
    const result = Storage.deleteSession(getStorage(), record.id);
    if (!result.ok) {
      setHistoryStatus(result.message || "The session could not be deleted.", true);
      refreshHistory();
      return;
    }
    if (detailSessionId === record.id) detailSessionId = null;
    selectedForExport.delete(record.id);
    compareSelected.delete(record.id);
    refreshHistory();
    setHistoryStatus("Session deleted from local history.");
  }

  function clearHistory() {
    if (!sessionCache.length) return;
    if (!window.confirm(`Delete all ${sessionCache.length} saved session${sessionCache.length === 1 ? "" : "s"} from this browser? This cannot be undone.`)) return;
    const result = Storage.clearAllSessions(getStorage());
    selectedForExport.clear();
    compareSelected.clear();
    detailSessionId = null;
    refreshHistory();
    if (result.ok) {
      setHistoryStatus(`Cleared ${result.removed} saved session${result.removed === 1 ? "" : "s"}.`);
    } else {
      setHistoryStatus(
        result.errors && result.errors.length
          ? `Removed ${result.removed} sessions, but some records could not be deleted.`
          : result.message || "History could not be cleared.",
        true
      );
    }
  }

  function exportRecords(records, filename) {
    const result = Storage.exportSessions(records);
    if (!result.ok) {
      setHistoryStatus(result.message || "The sessions could not be exported.", true);
      return;
    }
    downloadText(result.json, filename || defaultExportName());
    setHistoryStatus(`Exported ${result.sessionCount} session${result.sessionCount === 1 ? "" : "s"} as JSON.`);
  }

  function exportSelectedSessions() {
    const records = sessionCache.filter((record) => selectedForExport.has(record.id));
    if (!records.length) return;
    exportRecords(records, `refreshtest-sessions-${fileStamp()}.json`);
  }

  function handleImport(event) {
    const input = event.currentTarget;
    const file = input.files && input.files[0];
    input.value = "";
    if (!file) return;
    if (file.size > Storage.MAX_IMPORT_BYTES) {
      setHistoryStatus(
        `That file is ${(file.size / (1024 * 1024)).toFixed(1)} MB. Imports are limited to ${(Storage.MAX_IMPORT_BYTES / (1024 * 1024)).toFixed(1)} MB.`,
        true
      );
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => setHistoryStatus("The selected file could not be read.", true);
    reader.onload = () => {
      const text = typeof reader.result === "string" ? reader.result : "";
      const parsed = Storage.parseImport(text);
      if (!parsed.ok) {
        setHistoryStatus(parsed.message || "No valid sessions were found in the import.", true);
        return;
      }

      const merged = Storage.mergeImported(sessionCache, parsed.sessions);
      const failures = [];
      let saved = 0;
      merged.added.forEach((record) => {
        const result = Storage.saveSession(getStorage(), record);
        if (result.ok) saved++;
        else failures.push(result.message || "A session could not be saved.");
      });
      refreshHistory();

      const skipped = parsed.skipped + merged.skipped.length;
      const parts = [`Imported ${saved} session${saved === 1 ? "" : "s"}.`];
      if (skipped) parts.push(`${skipped} skipped (invalid, duplicate, or over the history limit).`);
      if (failures.length) parts.push(failures[0]);
      setHistoryStatus(parts.join(" "), failures.length > 0 || saved === 0);
    };
    reader.readAsText(file, "UTF-8");
  }

  function updateSaveAvailability() {
    const button = $("saveSession");
    const exportButton = $("exportResult");
    if (exportButton) exportButton.disabled = !lastResult;
    if (!button) return;
    if (lastResult && lastResult.savedId) {
      button.disabled = true;
      button.textContent = "Saved";
    } else {
      button.disabled = !lastResult || !storageAvailable;
      button.textContent = "Save session";
    }
    if (!storageAvailable) {
      setSaveStatus(
        lastResult
          ? "Browser local storage is unavailable. This result can be exported but not saved to history."
          : "Browser local storage is unavailable. Results can still be exported from this view.",
        true
      );
    }
  }

  function saveCurrentResult() {
    if (!lastResult || lastResult.savedId) return;
    const built = buildRecordFromResult(lastResult);
    if (!built.ok) {
      setSaveStatus(built.errors?.[0]?.message || "This result could not be prepared for saving.", true);
      return;
    }
    // savedAt records when the session is actually committed to history. A
    // record first built for an export is re-stamped at save time; exported
    // copies of an already-saved session keep the saved timestamp.
    const recordToSave = { ...built.record, savedAt: new Date().toISOString() };
    const result = Storage.saveSession(getStorage(), recordToSave);
    if (!result.ok) {
      if (result.code === "DUPLICATE_ID") {
        lastResult.sessionRecord = recordToSave;
        lastResult.savedId = recordToSave.id;
        refreshHistory();
        setSaveStatus("This measurement is already in local history. It was not saved twice.");
        updateSaveAvailability();
        return;
      }
      setSaveStatus(result.message || "The session could not be saved.", true);
      refreshHistory();
      return;
    }
    lastResult.sessionRecord = result.record;
    lastResult.savedId = result.record.id;
    refreshHistory();
    setSaveStatus(`Saved locally to this browser at ${Comparison.formatSavedAt(result.record.savedAt)}.`);
    updateSaveAvailability();
  }

  function exportCurrentResult() {
    if (!lastResult) return;
    const built = buildRecordFromResult(lastResult);
    if (!built.ok) {
      setSaveStatus(built.errors?.[0]?.message || "This result could not be prepared for export.", true);
      return;
    }
    const exported = Storage.exportSessions([built.record]);
    if (!exported.ok) {
      setSaveStatus(exported.message || "The result could not be exported.", true);
      return;
    }
    downloadText(exported.json, `refreshtest-result-${fileStamp()}.json`);
    setSaveStatus("Exported result JSON. This does not add the result to history.");
  }

  function buildRecordFromResult(result) {
    // Build once per measurement so saving, exporting, and re-exporting share
    // one stable id. savedAt is the first commit/export time; saveCurrentResult
    // re-stamps it when an export-only record is later saved to history.
    if (result.sessionRecord) {
      return { ok: true, record: result.sessionRecord };
    }
    const startedDate = new Date(result.wallClockStartedAt);
    const startedAt = Number.isFinite(startedDate.getTime())
      ? startedDate.toISOString()
      : undefined;
    const built = Storage.buildSessionRecord({
      id: Storage.createSessionId(),
      savedAt: Date.now(),
      startedAt,
      mode: result.mode,
      modeLabel: result.modeLabel,
      durationMs: result.elapsedMs,
      sampleWindowMs: result.durationMs,
      observations: result.observations,
      summary: result.summary,
      hiddenPauses: result.hiddenPauses,
      diagnostics: result.diagnostics,
      environment: result.environment
    });
    if (built.ok) result.sessionRecord = built.record;
    return built;
  }

  // ---------------------------------------------------------------------------
  // Comparison
  // ---------------------------------------------------------------------------

  function renderCompareSelector() {
    const host = $("compareSelector");
    if (!host) return;
    host.replaceChildren();

    if (!sessionCache.length) {
      host.append(emptyState(
        "No saved sessions to compare",
        "Save at least two measurements, then return here to compare their absolute values and descriptive differences."
      ));
      updateCompareCount();
      return;
    }

    sessionCache.forEach((record) => {
      const view = Comparison.sessionView(record);
      const label = document.createElement("label");
      label.className = "compare-option";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = record.id;
      input.checked = compareSelected.has(record.id);
      input.disabled = !input.checked && compareSelected.size >= Comparison.MAX_COMPARE_SESSIONS;
      const span = document.createElement("span");
      const strong = document.createElement("strong");
      strong.textContent = view.label;
      const small = document.createElement("small");
      small.textContent = `${view.summary ? view.summary.acceptedCount.toLocaleString() : "—"} accepted · median ${formatNumber(view.summary?.medianIntervalMs, 2)} ms · ${formatDuration(record.durationMs)}`;
      span.append(strong, small);
      input.addEventListener("change", () => {
        if (input.checked) {
          if (compareSelected.size >= Comparison.MAX_COMPARE_SESSIONS) {
            input.checked = false;
            setCompareStatus(`Up to ${Comparison.MAX_COMPARE_SESSIONS} sessions can be compared at once.`, true);
            return;
          }
          compareSelected.add(record.id);
        } else {
          compareSelected.delete(record.id);
        }
        // Update existing controls instead of rebuilding the list, so keyboard
        // focus stays on the checkbox the user just changed.
        host.querySelectorAll('input[type="checkbox"]').forEach((candidate) => {
          candidate.disabled = !candidate.checked && compareSelected.size >= Comparison.MAX_COMPARE_SESSIONS;
        });
        setCompareStatus("");
        updateCompareCount();
        renderCompare();
      });
      label.append(input, span);
      host.append(label);
    });
    updateCompareCount();
  }

  function updateCompareCount() {
    const count = $("compareCount");
    if (count) count.textContent = `${compareSelected.size} selected`;
  }

  function setCompareStatus(message, isError = false) {
    const status = $("compareStatus");
    if (!status) return;
    status.textContent = message || "";
    status.classList.toggle("error", Boolean(isError));
  }

  function renderCompare() {
    const host = $("compareResults");
    if (!host) return;
    host.classList.add("compare-results");
    host.replaceChildren();
    updateCompareCount();

    const records = sessionCache.filter((record) => compareSelected.has(record.id));
    if (records.length < Comparison.MIN_SESSIONS) {
      if (sessionCache.length && records.length === 0) {
        setCompareStatus("Select at least two saved sessions to compare.");
      } else if (sessionCache.length) {
        setCompareStatus(`Select one more session (${records.length} selected).`);
      } else {
        setCompareStatus("");
      }
      return;
    }

    const comparison = Comparison.compareSessions(records);
    if (!comparison.ok) {
      setCompareStatus(comparison.message, true);
      return;
    }
    setCompareStatus(`Comparing ${comparison.sessions.length} sessions.`);

    if (comparison.warnings.length) {
      const warnings = document.createElement("ul");
      warnings.className = "warning-list";
      comparison.warnings.forEach((warning) => {
        const item = document.createElement("li");
        item.className = `warning-item ${warning.severity}`;
        const title = document.createElement("strong");
        title.textContent = warning.title;
        const message = document.createElement("p");
        message.textContent = warning.message;
        item.append(title, message);
        warnings.append(item);
      });
      host.append(warnings);
    }

    const chart = document.createElement("canvas");
    chart.className = "compare-chart";
    chart.setAttribute("role", "img");
    chart.setAttribute("aria-label", "Grouped bar chart of median frame interval in milliseconds for each selected session.");
    host.append(chart);
    const chartCaption = document.createElement("p");
    chartCaption.className = "chart-caption";
    chartCaption.textContent = "Median frame interval by session · lower is a shorter typical interval. Session order matches the table.";
    host.append(chartCaption);
    requestAnimationFrame(() => drawComparisonChart(chart, comparison.sessions));

    host.append(buildComparisonTable(comparison));

    comparison.notes.forEach((note) => {
      const paragraph = document.createElement("p");
      paragraph.className = "chart-caption";
      paragraph.textContent = note;
      host.append(paragraph);
    });
  }

  function buildComparisonTable(comparison) {
    const scroll = document.createElement("div");
    scroll.className = "table-scroll";
    const table = document.createElement("table");
    table.className = "data-table compare-table";
    const caption = document.createElement("caption");
    caption.textContent = `Absolute values with descriptive differences from the earliest selected session (${comparison.sessions[0].label}).`;
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    const metricHead = document.createElement("th");
    metricHead.scope = "col";
    metricHead.textContent = "Metric";
    headRow.append(metricHead);
    comparison.sessions.forEach((session, index) => {
      const th = document.createElement("th");
      th.scope = "col";
      th.textContent = `S${index + 1} · ${session.shortLabel}`;
      const note = document.createElement("span");
      note.className = "metric-note";
      note.textContent = `${session.modeLabel} · ${session.source === "recomputed" ? "recomputed" : "snapshot"}`;
      th.append(note);
      headRow.append(th);
    });
    thead.append(headRow);

    const tbody = document.createElement("tbody");
    comparison.rows.forEach((row) => {
      const tr = document.createElement("tr");
      const th = document.createElement("th");
      th.scope = "row";
      th.textContent = row.label;
      if (row.note) {
        const note = document.createElement("span");
        note.className = "metric-note";
        note.textContent = row.note;
        th.append(note);
      }
      tr.append(th);

      row.values.forEach((value, index) => {
        const td = document.createElement("td");
        if (value === null) {
          const unavailable = document.createElement("span");
          unavailable.className = "unavailable";
          unavailable.textContent = "—";
          td.append(unavailable);
        } else {
          const strong = document.createElement("strong");
          strong.textContent = formatMetricValue(value, row);
          td.append(strong);
        }
        if (index === 0) {
          const baseline = document.createElement("span");
          baseline.className = "delta baseline";
          baseline.textContent = "baseline";
          td.append(baseline);
        } else {
          const delta = row.deltas[index];
          if (delta) {
            const span = document.createElement("span");
            span.className = "delta";
            if (delta.absolute < 0) span.classList.add("negative");
            span.textContent = formatDelta(delta, row);
            td.append(span);
          }
        }
        tr.append(td);
      });
      tbody.append(tr);
    });

    table.append(caption, thead, tbody);
    scroll.append(table);
    return scroll;
  }

  function formatMetricValue(value, row) {
    const digits = Number.isFinite(row.digits) ? row.digits : 1;
    const number = value.toFixed(digits);
    return row.unit === "count" ? number : `${number} ${row.unit}`;
  }

  function formatDelta(delta, row) {
    const digits = Number.isFinite(row.digits) ? row.digits : 1;
    const sign = delta.absolute > 0 ? "+" : "";
    const absolute = `${sign}${delta.absolute.toFixed(digits)}`;
    const withUnit = row.unit === "count" ? absolute : `${absolute} ${row.unit}`;
    if (delta.percent === null) return withUnit;
    return `${withUnit} (${delta.percent > 0 ? "+" : ""}${delta.percent.toFixed(1)}%)`;
  }

  // ---------------------------------------------------------------------------
  // Advanced lab
  // ---------------------------------------------------------------------------

  function renderLabEmpty() {
    const distributionBody = $("distributionBody");
    const metricsBody = $("labMetricsBody");
    const distributionEmpty = $("distributionEmpty");
    const metricsEmpty = $("labMetricsEmpty");
    if (distributionBody) distributionBody.hidden = true;
    if (metricsBody) metricsBody.hidden = true;
    if (distributionEmpty) distributionEmpty.hidden = false;
    if (metricsEmpty) metricsEmpty.hidden = false;
    setText("distributionMeta", "No result");
    setText("distributionCaption", "");
    const exportButton = $("exportReport");
    if (exportButton) exportButton.disabled = true;
  }

  function renderLabResult(result) {
    const summary = result.summary;
    const accepted = summary.acceptedIntervals;
    const distributionBody = $("distributionBody");
    const distributionEmpty = $("distributionEmpty");
    const metricsBody = $("labMetricsBody");
    const metricsEmpty = $("labMetricsEmpty");
    const distributionMeta = $("distributionMeta");
    const exportButton = $("exportReport");

    if (distributionEmpty) distributionEmpty.hidden = true;
    if (metricsEmpty) metricsEmpty.hidden = true;
    if (distributionBody) distributionBody.hidden = false;
    if (metricsBody) metricsBody.hidden = false;
    if (exportButton) exportButton.disabled = false;
    if (distributionMeta) {
      distributionMeta.textContent = `${result.modeLabel} · ${(result.elapsedMs / 1000).toFixed(1)} s · ${accepted.length.toLocaleString()} accepted`;
    }

    const canvas = $("distributionCanvas");
    if (canvas) {
      requestAnimationFrame(() => drawHistogram(canvas, accepted, summary));
    }
    const caption = $("distributionCaption");
    if (caption) {
      if (!accepted.length) {
        caption.textContent = "No accepted intervals were available, so no distribution can be drawn. Long gaps are excluded from this chart.";
      } else {
        const histogram = Stats.buildHistogram(accepted, { binCount: 18 });
        const extras = [];
        if (histogram.underflowCount) extras.push(`${histogram.underflowCount} below range`);
        if (histogram.overflowCount) extras.push(`${histogram.overflowCount} above range`);
        caption.textContent = `${histogram.sampleCount.toLocaleString()} accepted intervals in ${histogram.binCount} bins of ${histogram.binWidth.toFixed(2)} ms, from ${histogram.min.toFixed(2)} to ${histogram.max.toFixed(2)} ms${extras.length ? ` · ${extras.join(" · ")}` : ""}. Hidden-tab time and long callback gaps are not included.`;
      }
    }

    const metrics = $("labMetrics");
    if (metrics) {
      metrics.replaceChildren();
      labMetricRows(result).forEach(([label, value, definition, unavailable]) => {
        const row = document.createElement("tr");
        const th = document.createElement("th");
        th.scope = "row";
        th.textContent = label;
        const td = document.createElement("td");
        if (unavailable) {
          const span = document.createElement("span");
          span.className = "unavailable";
          span.textContent = value;
          td.append(span);
        } else {
          td.textContent = value;
        }
        const note = document.createElement("td");
        note.textContent = definition;
        row.append(th, td, note);
        metrics.append(row);
      });
    }
  }

  function labMetricRows(result) {
    const summary = result.summary;
    const hidden = result.hiddenPauses;
    const unavailable = (value) => value === null || value === undefined;
    return [
      ["Measurement mode", `${result.modeLabel} (${result.modeShortLabel})`, "All modes share one lifecycle and statistics pipeline.", false],
      ["Active duration", `${(result.elapsedMs / 1000).toFixed(1)} s`, "Hidden-tab pauses excluded.", false],
      ["Median interval (P50)", `${formatNumber(summary.p50IntervalMs, 2)} ms`, "Nearest-rank median of accepted intervals.", unavailable(summary.p50IntervalMs)],
      ["P95 interval", `${formatNumber(summary.p95IntervalMs, 2)} ms`, `Available with ${Stats.MIN_ACCEPTED_SAMPLES}+ accepted intervals.`, unavailable(summary.p95IntervalMs)],
      ["P99 interval", `${formatNumber(summary.p99IntervalMs, 2)} ms`, `Available with ${Stats.MIN_P99_SAMPLES}+ accepted intervals.`, unavailable(summary.p99IntervalMs)],
      ["Mean interval", `${formatNumber(summary.meanIntervalMs, 2)} ms`, "Kahan-compensated arithmetic mean.", unavailable(summary.meanIntervalMs)],
      ["Min / max interval", `${formatNumber(summary.minIntervalMs, 2)} / ${formatNumber(summary.maxIntervalMs, 2)} ms`, "Extremes among accepted intervals.", unavailable(summary.minIntervalMs) || unavailable(summary.maxIntervalMs)],
      ["Population σ", `${formatNumber(summary.standardDeviationMs, 2)} ms`, "Population standard deviation, denominator n.", unavailable(summary.standardDeviationMs)],
      ["Coefficient of variation", formatPercentValue(summary.coefficientOfVariation), "Population σ divided by the mean; dimensionless spread.", unavailable(summary.coefficientOfVariation)],
      ["Average FPS", formatNumber(summary.averageFps, 1), "1000 divided by the mean accepted interval.", unavailable(summary.averageFps)],
      ["Median FPS", formatNumber(summary.medianFps, 1), "1000 divided by the median accepted interval.", unavailable(summary.medianFps)],
      ["Stability", `${formatNumber(summary.stabilityPercent, 1)}% · ${summary.stabilityClassification}`, "Share of accepted intervals within ±5% of the median.", unavailable(summary.stabilityPercent)],
      ["Usable coverage", `${formatNumber(summary.usableCoveragePercent, 1)}%`, "Accepted interval time divided by accepted plus excluded-gap time.", unavailable(summary.usableCoveragePercent)],
      ["Accepted intervals", summary.acceptedCount.toLocaleString(), "Finite intervals greater than 0 and at most 250 ms.", false],
      ["Long gaps", summary.excludedGapCount.toLocaleString(), "Finite intervals above 250 ms; excluded from cadence.", false],
      ["Excluded gap time", formatDuration(summary.excludedGapDurationMs), "Total duration of excluded long gaps.", false],
      ["Longest excluded gap", formatDuration(summary.longestExcludedGapMs), "Largest single excluded callback gap.", false],
      ["Hidden pauses", `${hidden.count} · ${formatDuration(hidden.durationMs)}`, "Tab-visibility pauses; excluded from active time.", false],
      ["Statistics version", String(summary.statisticsVersion), "Definitions are versioned for historical comparisons.", false],
      ["Raw observations", result.observations.length.toLocaleString(), "Retained callback intervals used for this result.", false]
    ];
  }

  function exportDiagnosticReport() {
    if (!lastResult) return;
    const report = {
      format: "refreshtest-diagnostic-report",
      schemaVersion: 1,
      app: "RefreshTest V2",
      exportedAt: new Date().toISOString(),
      disclaimer: Storage.EXPORT_DISCLAIMER,
      measurement: {
        mode: lastResult.mode,
        modeLabel: lastResult.modeLabel,
        durationMs: lastResult.durationMs,
        activeElapsedMs: lastResult.elapsedMs,
        startedAt: new Date(lastResult.wallClockStartedAt).toISOString(),
        hiddenPauses: lastResult.hiddenPauses,
        diagnostics: lastResult.diagnostics,
        environment: lastResult.environment,
        observations: lastResult.observations
      },
      summary: Storage.snapshotSummary(lastResult.summary),
      insights: lastResult.insights
        ? {
            headline: lastResult.insights.headline,
            findings: lastResult.insights.findings,
            limitations: lastResult.insights.limitations,
            thresholds: lastResult.insights.thresholds
          }
        : null
    };
    downloadText(JSON.stringify(report, null, 2), `refreshtest-report-${fileStamp()}.json`);
    setSaveStatus("Exported diagnostic report JSON.");
  }

  // ---------------------------------------------------------------------------
  // Charts
  // ---------------------------------------------------------------------------

  function prepareCanvas(canvas, cssHeight) {
    if (!canvas) return null;
    const box = canvas.getBoundingClientRect();
    const width = box.width || canvas.parentElement?.clientWidth || 0;
    if (!width) return null;
    const height = cssHeight || box.height || 220;
    const ratio = window.devicePixelRatio || 1;
    const pixelWidth = Math.round(width * ratio);
    const pixelHeight = Math.round(height * ratio);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    return { context, width, height };
  }

  function drawComparisonChart(canvas, sessions) {
    const prepared = prepareCanvas(canvas, canvas.getBoundingClientRect().height || 240);
    if (!prepared) return;
    const { context, width, height } = prepared;
    const values = sessions.map((session) => session.summary?.medianIntervalMs ?? null);

    context.fillStyle = "#e2ece7";
    context.font = "600 12px ui-sans-serif, system-ui, sans-serif";
    context.fillText("Median frame interval (ms)", 16, 20);

    if (!values.some((value) => Number.isFinite(value))) {
      context.fillStyle = "#75847f";
      context.font = "11px ui-monospace, monospace";
      context.fillText("No median interval values are available.", 16, 48);
      return;
    }

    const left = 48;
    const right = 16;
    const top = 42;
    const bottom = 36;
    const plotWidth = width - left - right;
    const plotHeight = height - top - bottom;
    const maximum = Math.max(...values.filter(Number.isFinite), 1) * 1.15;

    context.strokeStyle = "rgba(166,188,190,.16)";
    context.fillStyle = "#687570";
    context.font = "9px ui-monospace, monospace";
    context.lineWidth = 1;
    for (let tick = 0; tick <= 4; tick++) {
      const value = maximum * tick / 4;
      const y = top + plotHeight - value / maximum * plotHeight;
      context.beginPath();
      context.moveTo(left, y + 0.5);
      context.lineTo(width - right, y + 0.5);
      context.stroke();
      context.fillText(`${value.toFixed(1)}`, 4, y + 3);
    }

    const slot = plotWidth / Math.max(1, values.length);
    const barWidth = Math.min(46, slot * 0.52);
    values.forEach((value, index) => {
      const center = left + slot * index + slot / 2;
      if (Number.isFinite(value)) {
        const barHeight = Math.max(2, value / maximum * plotHeight);
        const y = top + plotHeight - barHeight;
        context.fillStyle = CHART_COLORS[index % CHART_COLORS.length];
        context.fillRect(center - barWidth / 2, y, barWidth, barHeight);
        context.fillStyle = "#dfeae5";
        context.font = "10px ui-monospace, monospace";
        const label = value.toFixed(2);
        context.fillText(label, center - context.measureText(label).width / 2, y - 5);
      }
      context.fillStyle = "#75847f";
      context.font = "9px ui-monospace, monospace";
      const name = `S${index + 1}`;
      context.fillText(name, center - context.measureText(name).width / 2, height - 12);
    });

    context.strokeStyle = "rgba(166,188,190,.3)";
    context.beginPath();
    context.moveTo(left, top + plotHeight + 0.5);
    context.lineTo(width - right, top + plotHeight + 0.5);
    context.stroke();
  }

  function drawHistogram(canvas, accepted, summary) {
    const prepared = prepareCanvas(canvas, canvas.getBoundingClientRect().height || 220);
    if (!prepared) return;
    const { context, width, height } = prepared;
    if (!accepted.length) {
      context.fillStyle = "#75847f";
      context.font = "11px ui-monospace, monospace";
      context.fillText("No accepted intervals to plot.", 16, 32);
      return;
    }
    const histogram = Stats.buildHistogram(accepted, { binCount: 18 });
    if (!histogram || histogram.sampleCount === 0) return;

    const left = 46;
    const right = 16;
    const top = 26;
    const bottom = 38;
    const plotWidth = width - left - right;
    const plotHeight = height - top - bottom;
    const maximumCount = Math.max(1, ...histogram.bins.map((bin) => bin.count));

    context.strokeStyle = "rgba(166,188,190,.14)";
    context.fillStyle = "#687570";
    context.font = "9px ui-monospace, monospace";
    context.lineWidth = 1;
    for (let tick = 0; tick <= 4; tick++) {
      const count = maximumCount * tick / 4;
      const y = top + plotHeight - count / maximumCount * plotHeight;
      context.beginPath();
      context.moveTo(left, y + 0.5);
      context.lineTo(width - right, y + 0.5);
      context.stroke();
      context.fillText(String(Math.round(count)), 4, y + 3);
    }

    const slot = plotWidth / histogram.bins.length;
    const barWidth = Math.max(1, slot * 0.86);
    histogram.bins.forEach((bin, index) => {
      const barHeight = bin.count / maximumCount * plotHeight;
      const x = left + slot * index + (slot - barWidth) / 2;
      const y = top + plotHeight - barHeight;
      context.fillStyle = "#76d8ca";
      if (bin.count > 0) context.fillRect(x, y, barWidth, Math.max(1, barHeight));
    });

    if (Number.isFinite(summary.medianIntervalMs)) {
      const medianX = left + (summary.medianIntervalMs - histogram.min) / Math.max(1e-9, histogram.max - histogram.min) * plotWidth;
      context.setLineDash([4, 4]);
      context.strokeStyle = "rgba(244,179,94,.8)";
      context.beginPath();
      context.moveTo(medianX, top);
      context.lineTo(medianX, top + plotHeight);
      context.stroke();
      context.setLineDash([]);
      context.fillStyle = "#f4b35e";
      context.font = "9px ui-monospace, monospace";
      context.fillText("median", Math.min(medianX + 4, width - right - 44), top + 10);
    }

    context.fillStyle = "#75847f";
    context.font = "9px ui-monospace, monospace";
    context.fillText(`${histogram.min.toFixed(2)} ms`, left, height - 16);
    const endLabel = `${histogram.max.toFixed(2)} ms`;
    context.fillText(endLabel, width - right - context.measureText(endLabel).width, height - 16);
    const countLabel = `${histogram.sampleCount.toLocaleString()} accepted intervals`;
    context.fillText(countLabel, left + (plotWidth - context.measureText(countLabel).width) / 2, height - 2);
    context.strokeStyle = "rgba(166,188,190,.3)";
    context.beginPath();
    context.moveTo(left, top + plotHeight + 0.5);
    context.lineTo(width - right, top + plotHeight + 0.5);
    context.stroke();
  }

  // ---------------------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------------------

  function routeFromHash() {
    const value = window.location.hash.replace(/^#\/?/, "");
    return VIEWS.includes(value) ? value : null;
  }

  function navigate(view, options = {}) {
    const target = VIEWS.includes(view) ? view : "test";

    // Leaving the Test view cancels an active run instead of allowing a hidden
    // measurement to continue and later present itself as complete.
    if (target !== "test" && isRunning()) cancelMeasurement("navigation");

    clearTimeout(pendingCompareResize);
    pendingCompareResize = 0;
    currentView = target;
    viewElements.forEach((element) => {
      element.hidden = element.dataset.view !== target;
    });
    navLinks.forEach((link) => {
      if (link.dataset.viewLink === target) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });
    document.title = VIEW_TITLES[target] || VIEW_TITLES.test;

    cancelAnimationFrame(motionFrame);
    motionFrame = 0;
    if (target === "test") {
      startMotion();
      drawGraph(summaryForGraph());
    } else if (target === "history") {
      renderHistory();
      renderHistoryDetail();
    } else if (target === "compare") {
      renderCompareSelector();
      renderCompare();
    } else if (target === "lab") {
      if (lastResult) renderLabResult(lastResult);
      else renderLabEmpty();
    }

    if (options.updateHash !== false && window.location.hash !== `#${target}`) {
      window.location.hash = `#${target}`;
    }

    if (options.focus) {
      const heading = document.querySelector(`[data-view="${target}"] h1`);
      if (heading) heading.focus({ preventScroll: true });
    }
    if (options.scroll !== false) window.scrollTo(0, 0);
  }

  function navigateTo(view) {
    if (window.location.hash === `#${view}`) navigate(view, { focus: true });
    else window.location.hash = `#${view}`;
  }

  function summaryForGraph() {
    if (lastResult) return lastResult.summary.acceptedIntervals;
    if (activeRun) return activeRun.acceptedIntervals;
    return [];
  }

  // ---------------------------------------------------------------------------
  // Motion and downloads
  // ---------------------------------------------------------------------------

  function setMotionSpeed(value) {
    if (![1, 2, 4].includes(value)) return;
    motionSpeed = value;
    setText("speedLabel", `Speed · ${value}×`);
    speedButtons.forEach((control) => {
      control.setAttribute("aria-pressed", String(Number(control.dataset.speed) === value));
    });
  }

  function startMotion() {
    cancelAnimationFrame(motionFrame);
    motionFrame = 0;
    if (reduceMotion.matches || document.hidden || currentView !== "test" || !motion || !track) return;
    motionFrame = requestAnimationFrame(animateMotion);
  }

  function animateMotion(timestamp) {
    motionFrame = 0;
    if (document.hidden || reduceMotion.matches || currentView !== "test" || !motion || !track) return;
    const travel = Math.max(0, track.clientWidth - motion.clientWidth - 8);
    if (travel > 0) {
      const phase = (timestamp % (4000 / motionSpeed)) / (4000 / motionSpeed);
      const progress = (1 - Math.cos(phase * Math.PI * 2)) / 2;
      motion.style.transform = `translate3d(${4 + progress * travel}px,0,0)`;
    }
    motionFrame = requestAnimationFrame(animateMotion);
  }

  function fileStamp() {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, "0");
    return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  }

  function defaultExportName() {
    return `refreshtest-sessions-${fileStamp()}.json`;
  }

  function downloadText(text, filename) {
    const blob = new Blob([text], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = "noopener";
    anchor.hidden = true;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---------------------------------------------------------------------------
  // Events and initialization
  // ---------------------------------------------------------------------------

  if (runButton) {
    runButton.addEventListener("click", () => {
      if (isRunning()) cancelMeasurement();
      else startMeasurement();
    });
  }
  speedButtons.forEach((control) => {
    control.addEventListener("click", () => setMotionSpeed(Number(control.dataset.speed)));
  });
  modeButtons.forEach((button) => {
    button.addEventListener("click", () => setMode(button.dataset.mode));
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      cancelAnimationFrame(motionFrame);
      motionFrame = 0;
      if (isRunning() && !activeRun.paused) {
        if (Measurement.pauseRun(activeRun, performance.now())) {
          cancelScheduledFrame();
          measureToken++;
          setStatus("PAUSED", "active");
          setText("rateNote", "Tab hidden · sampling paused to avoid throttled callbacks");
        }
      }
      return;
    }

    startMotion();
    if (isRunning() && activeRun.paused) {
      const resumed = Measurement.resumeRun(activeRun, performance.now());
      if (resumed) {
        activeRun.measureToken = ++measureToken;
        setStatus("SAMPLING...", "active");
        setText("rateNote", "Sampling resumed · hidden time excluded");
        scheduleMeasurementFrame();
      }
    }
  });

  window.addEventListener("resize", () => {
    updateEnvironment();
    if (currentView === "test") drawGraph(summaryForGraph());
    if (currentView === "lab" && lastResult) {
      const canvas = $("distributionCanvas");
      if (canvas) requestAnimationFrame(() => drawHistogram(canvas, lastResult.summary.acceptedIntervals, lastResult.summary));
    }
    if (currentView === "compare") {
      clearTimeout(pendingCompareResize);
      pendingCompareResize = window.setTimeout(() => renderCompare(), 120);
    }
  });

  if (frameCanvas && "ResizeObserver" in window) {
    new ResizeObserver(() => drawGraph(summaryForGraph())).observe(frameCanvas);
  }

  if (reduceMotion.addEventListener) {
    reduceMotion.addEventListener("change", () => {
      cancelAnimationFrame(motionFrame);
      motionFrame = 0;
      if (!reduceMotion.matches) startMotion();
    });
  }

  window.addEventListener("hashchange", () => {
    const route = routeFromHash();
    if (route) navigate(route, { focus: true, updateHash: false });
  });

  const saveButton = $("saveSession");
  if (saveButton) saveButton.addEventListener("click", saveCurrentResult);
  const exportButton = $("exportResult");
  if (exportButton) exportButton.addEventListener("click", exportCurrentResult);
  const exportReportButton = $("exportReport");
  if (exportReportButton) exportReportButton.addEventListener("click", exportDiagnosticReport);
  const importInput = $("importFile");
  if (importInput) importInput.addEventListener("change", handleImport);
  const exportSelectedButton = $("exportSelected");
  if (exportSelectedButton) exportSelectedButton.addEventListener("click", exportSelectedSessions);
  const clearButton = $("clearHistory");
  if (clearButton) clearButton.addEventListener("click", clearHistory);

  buildLabModes();
  setMode(currentMode);
  resetStatistics();
  renderLabEmpty();
  updateEnvironment();
  refreshHistory();
  updateSaveAvailability();
  navigate(routeFromHash() || "test", { focus: false, updateHash: false, scroll: false });
  startMotion();
})();
