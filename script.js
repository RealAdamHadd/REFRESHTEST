(() => {
  const $ = (id) => document.getElementById(id);
  const canvas = $("frameGraph");
  const context = canvas.getContext("2d");
  const runButton = $("startTest");
  const motion = $("motionObject");
  const track = document.querySelector(".motion-track");
  const speedButtons = [...document.querySelectorAll("[data-speed]")];
  const frameIntervals = [];
  const SAMPLE_MS = 8000;
  const MAX_INTERVAL_MS = 250;
  const MAX_SAMPLES = 12000;
  let testing = false;
  let startTime = 0;
  let elapsedBeforePause = 0;
  let previousFrameTimestamp = null;
  let pausedAt = null;
  let discardedGaps = 0;
  let measureFrame = 0;
  let motionFrame = 0;
  let lastGraphDraw = 0;
  let motionSpeed = 1;

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

  function updateEnvironment() {
    const ratio = window.devicePixelRatio || 1;
    $("resolution").textContent = `${screen.width} × ${screen.height}`;
    $("viewport").textContent = `${innerWidth} × ${innerHeight} CSS px`;
    $("pixelRatio").textContent = `${ratio.toFixed(2)}×`;
    $("browser").textContent = getBrowser();
    $("operatingSystem").textContent = getOperatingSystem();
    drawGraph();
  }

  function setMetricParts(id, parts) {
    const output = $(id);
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

  function median(values) {
    if (!values.length) return 0;
    const ordered = [...values].sort((a, b) => a - b);
    const mid = Math.floor(ordered.length / 2);
    return ordered.length % 2 ? ordered[mid] : (ordered[mid - 1] + ordered[mid]) / 2;
  }

  function drawGraph() {
    if (!context) return;
    const box = canvas.getBoundingClientRect();
    if (!box.width || !box.height) return;
    const ratio = window.devicePixelRatio || 1;
    const pixelWidth = Math.round(box.width * ratio);
    const pixelHeight = Math.round(box.height * ratio);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    const width = box.width;
    const height = box.height;
    context.clearRect(0, 0, width, height);
    context.strokeStyle = "rgba(166,188,190,.09)";
    context.lineWidth = 1;
    for (let row = 1; row < 4; row++) {
      const y = Math.round(height * row / 4) + 0.5;
      context.beginPath();
      context.moveTo(0, y);
      context.lineTo(width, y);
      context.stroke();
    }

    const values = frameIntervals.slice(-120);
    if (!values.length) return;
    const typical = median(values);
    const maximum = Math.max(30, typical * 2.1, ...values);
    const yFor = (value) => height - Math.min(value, maximum) / maximum * (height - 8) - 4;
    context.setLineDash([3, 5]);
    context.strokeStyle = "rgba(244,179,94,.58)";
    context.beginPath();
    context.moveTo(0, yFor(typical));
    context.lineTo(width, yFor(typical));
    context.stroke();
    context.setLineDash([]);

    // Split the trace into three paths so abnormal intervals are identifiable without a stroke per sample.
    const paths = [new Path2D(), new Path2D(), new Path2D()];
    values.forEach((value, index) => {
      if (index === 0) return;
      const prior = values[index - 1];
      const level = Math.max(value, prior) > typical * 2.5 ? 2 : Math.max(value, prior) > typical * 1.5 ? 1 : 0;
      const x0 = (index - 1) * width / Math.max(1, values.length - 1);
      const x1 = index * width / Math.max(1, values.length - 1);
      paths[level].moveTo(x0, yFor(prior));
      paths[level].lineTo(x1, yFor(value));
    });
    context.lineWidth = 2;
    context.lineJoin = "round";
    context.lineCap = "round";
    ["#76d8ca", "#f4b35e", "#ed796c"].forEach((color, index) => {
      context.strokeStyle = color;
      context.stroke(paths[index]);
    });
    context.fillStyle = "#d9fff5";
    context.beginPath();
    context.arc(width - 1, yFor(values[values.length - 1]), 3, 0, Math.PI * 2);
    context.fill();
  }

  function setStatus(text, mode = "") {
    $("statusText").textContent = text;
    $("statusDot").className = `state-dot ${mode}`;
  }

  function setRunButton(text, disabled = false) {
    runButton.disabled = disabled;
    runButton.querySelector("span:nth-child(2)").textContent = text;
  }

  function resetStatistics() {
    $("currentHz").textContent = "—";
    $("liveFps").textContent = "—";
    $("avgFps").textContent = "—";
    $("minFps").textContent = "—";
    $("maxFps").textContent = "—";
    setMetricParts("avgFrameTime", [{ text: "— " }, { text: "ms", small: true }]);
    setMetricParts("minMaxFrameTime", [{ text: "— " }, { text: "/", small: true }, { text: " — " }, { text: "ms", small: true }]);
    setMetricParts("variation", [{ text: "— " }, { text: "ms", small: true }]);
    setMetricParts("stability", [{ text: "—" }, { text: "%", small: true }]);
    $("stabilityLabel").textContent = "STABLE";
    $("framesTested").textContent = "—";
    setMetricParts("testDuration", [{ text: "— " }, { text: "s", small: true }]);
    $("sampleCount").textContent = "0 samples";
  }

  function renderLive(timestamp) {
    if (frameIntervals.length < 2) return;
    const recent = frameIntervals.slice(-31);
    $("currentHz").textContent = (1000 / median(recent)).toFixed(1);
    $("liveFps").textContent = (1000 / frameIntervals[frameIntervals.length - 1]).toFixed(1);
    $("sampleCount").textContent = `${frameIntervals.length.toLocaleString()} samples`;
    if (timestamp - lastGraphDraw >= 33) {
      lastGraphDraw = timestamp;
      drawGraph();
    }
  }

  function measure(frameTimestamp) {
    if (!testing || document.hidden) return;
    const now = performance.now();
    if (previousFrameTimestamp !== null) {
      const delta = frameTimestamp - previousFrameTimestamp;
      if (delta > 0 && delta <= MAX_INTERVAL_MS && frameIntervals.length < MAX_SAMPLES) {
        frameIntervals.push(delta);
        renderLive(now);
      } else if (delta > MAX_INTERVAL_MS) {
        discardedGaps++;
        $("rateNote").textContent = `${discardedGaps} long callback gap${discardedGaps === 1 ? "" : "s"} excluded from cadence`;
      }
    }
    previousFrameTimestamp = frameTimestamp;
    const elapsed = elapsedBeforePause + now - startTime;
    if (elapsed >= SAMPLE_MS) analyze(elapsed);
    else measureFrame = requestAnimationFrame(measure);
  }

  function startTest() {
    if (testing) return;
    frameIntervals.length = 0;
    discardedGaps = 0;
    previousFrameTimestamp = null;
    elapsedBeforePause = 0;
    pausedAt = null;
    lastGraphDraw = 0;
    resetStatistics();
    drawGraph();
    testing = true;
    startTime = performance.now();
    $("readoutCaption").textContent = "Live refresh rate";
    $("rateNote").textContent = "Sampling browser animation callbacks…";
    setRunButton("Sampling…", true);
    document.body.classList.add("measuring");
    setStatus("SAMPLING...", "active");
    measureFrame = requestAnimationFrame(measure);
  }

  function analyze(elapsed) {
    if (!testing) return;
    testing = false;
    cancelAnimationFrame(measureFrame);
    document.body.classList.remove("measuring");
    setStatus("ANALYZING...", "active");
    $("readoutCaption").textContent = "Calculating cadence";
    $("rateNote").textContent = "Summarizing measured frame intervals…";
    window.setTimeout(() => finish(elapsed), 220);
  }

  function finish(elapsed) {
    if (!frameIntervals.length) {
      $("rateNote").textContent = "No usable frame intervals captured. Keep this tab visible and run again.";
      $("readoutCaption").textContent = "REFRESH RATE";
      setStatus("READY");
      setRunButton("Run measurement");
      return;
    }
    const mean = frameIntervals.reduce((sum, value) => sum + value, 0) / frameIntervals.length;
    const typical = median(frameIntervals);
    const variance = frameIntervals.reduce((sum, value) => sum + (value - mean) ** 2, 0) / frameIntervals.length;
    const deviation = Math.sqrt(variance);
    const tolerance = Math.max(1, typical * 0.05);
    const stability = frameIntervals.filter((value) => Math.abs(value - typical) <= tolerance).length / frameIntervals.length * 100;
    const rates = frameIntervals.map((value) => 1000 / value);
    const minFrame = Math.min(...frameIntervals);
    const maxFrame = Math.max(...frameIntervals);
    $("currentHz").textContent = (1000 / typical).toFixed(1);
    $("liveFps").textContent = (1000 / frameIntervals[frameIntervals.length - 1]).toFixed(1);
    $("readoutCaption").textContent = "Measured browser frame cadence";
    $("avgFps").textContent = (1000 / mean).toFixed(1);
    $("minFps").textContent = Math.min(...rates).toFixed(1);
    $("maxFps").textContent = Math.max(...rates).toFixed(1);
    setMetricParts("avgFrameTime", [{ text: `${mean.toFixed(2)} ` }, { text: "ms", small: true }]);
    setMetricParts("minMaxFrameTime", [{ text: `${minFrame.toFixed(2)} ` }, { text: "/", small: true }, { text: ` ${maxFrame.toFixed(2)} ` }, { text: "ms", small: true }]);
    setMetricParts("variation", [{ text: `${deviation.toFixed(2)} ` }, { text: "ms", small: true }]);
    setMetricParts("stability", [{ text: stability.toFixed(1) }, { text: "%", small: true }]);
    $("stabilityLabel").textContent = stability >= 95 ? "STABLE" : stability >= 80 ? "VARIABLE" : "UNSTABLE";
    $("framesTested").textContent = frameIntervals.length.toLocaleString();
    setMetricParts("testDuration", [{ text: `${(elapsed / 1000).toFixed(1)} ` }, { text: "s", small: true }]);
    $("sampleCount").textContent = `${frameIntervals.length.toLocaleString()} samples`;
    $("rateNote").textContent = `${discardedGaps} long gap${discardedGaps === 1 ? "" : "s"} excluded · cadence uses median interval`;
    setStatus("SAMPLE COMPLETE", "complete");
    setRunButton("Run again");
    drawGraph();
  }

  function setMotionSpeed(value) {
    if (![1, 2, 4].includes(value)) return;
    motionSpeed = value;
    $("speedLabel").textContent = `Speed · ${value}×`;
    speedButtons.forEach((control) => control.setAttribute("aria-pressed", String(Number(control.dataset.speed) === value)));
  }

  function animateMotion(timestamp) {
    motionFrame = 0;
    if (document.hidden) return;
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const phase = (timestamp % (4000 / motionSpeed)) / (4000 / motionSpeed);
      const progress = (1 - Math.cos(phase * Math.PI * 2)) / 2;
      const maxX = Math.max(0, track.clientWidth - motion.clientWidth - 8);
      motion.style.transform = `translate3d(${4 + progress * maxX}px,0,0)`;
    }
    motionFrame = requestAnimationFrame(animateMotion);
  }

  runButton.addEventListener("click", startTest);
  speedButtons.forEach((control) => control.addEventListener("click", () => setMotionSpeed(Number(control.dataset.speed))));
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      cancelAnimationFrame(motionFrame);
      if (testing) {
        cancelAnimationFrame(measureFrame);
        pausedAt = performance.now();
        $("rateNote").textContent = "Tab hidden · sampling paused to avoid throttled callbacks";
      }
      return;
    }
    motionFrame = requestAnimationFrame(animateMotion);
    if (testing && pausedAt !== null) {
      elapsedBeforePause += pausedAt - startTime;
      startTime = performance.now();
      pausedAt = null;
      previousFrameTimestamp = null;
      $("rateNote").textContent = "Sampling resumed · hidden time excluded";
      measureFrame = requestAnimationFrame(measure);
    }
  });
  window.addEventListener("resize", updateEnvironment);
  if ("ResizeObserver" in window) new ResizeObserver(drawGraph).observe(canvas);
  updateEnvironment();
  resetStatistics();
  motionFrame = requestAnimationFrame(animateMotion);
})();
