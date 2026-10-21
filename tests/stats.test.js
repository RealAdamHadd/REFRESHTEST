"use strict";

/**
 * RefreshTest statistics tests.
 *
 * Run with: node --test tests/stats.test.js
 *
 * These tests use synthetic intervals and the Node.js built-in test runner.
 * They do not use the DOM, timers, animation callbacks, or real display data.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const Stats = require("../stats.js");

const ROOT = path.join(__dirname, "..");

function repeat(value, count) {
  return Array.from({ length: count }, () => value);
}

function approx(actual, expected, epsilon = 1e-9, message) {
  assert.equal(typeof actual, "number", message);
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    message || `expected ${actual} to be within ${epsilon} of ${expected}`
  );
}

test("60 Hz-like accepted intervals produce the expected cadence", () => {
  const result = Stats.computeStatistics(repeat(16.67, 60));

  assert.equal(result.acceptedCount, 60);
  assert.equal(result.excludedGapCount, 0);
  assert.equal(result.invalidCount, 0);
  approx(result.meanIntervalMs, 16.67);
  approx(result.medianIntervalMs, 16.67);
  approx(result.averageFps, 1000 / 16.67);
  approx(result.medianFps, 1000 / 16.67);
  approx(result.standardDeviationMs, 0);
  approx(result.stabilityPercent, 100);
  assert.equal(result.stabilityClassification, "STABLE");
  approx(result.p95IntervalMs, 16.67);
  assert.equal(result.sufficientSample, true);
});

test("120 Hz-like accepted intervals produce the expected cadence", () => {
  const result = Stats.computeStatistics(repeat(8.33, 120));

  assert.equal(result.acceptedCount, 120);
  approx(result.meanIntervalMs, 8.33);
  approx(result.medianIntervalMs, 8.33);
  approx(result.averageFps, 1000 / 8.33);
  approx(result.standardDeviationMs, 0);
  approx(result.stabilityPercent, 100);
  assert.equal(result.stabilityClassification, "STABLE");
  assert.equal(result.p95IntervalMs, 8.33);
});

test("an uneven dataset keeps mean and median distinct", () => {
  const observations = repeat(10, 29).concat([100]);
  const result = Stats.computeStatistics(observations);

  assert.equal(result.acceptedCount, 30);
  approx(result.meanIntervalMs, 13);
  approx(result.medianIntervalMs, 10);
  approx(result.averageFps, 1000 / 13);
  approx(result.medianFps, 1000 / 10);
  assert.notEqual(result.averageFps, result.medianFps);
});

test("median handles odd, even, and empty collections without mutation", () => {
  const odd = [3, 1, 2];
  const even = [4, 1, 3, 2];

  assert.equal(Stats.median(odd), 2);
  assert.equal(Stats.median(even), 2.5);
  assert.equal(Stats.median([]), null);
  assert.deepEqual(odd, [3, 1, 2]);
  assert.deepEqual(even, [4, 1, 3, 2]);
});

test("P95 uses nearest rank without interpolation", () => {
  const oneToHundred = Array.from({ length: 100 }, (_, index) => index + 1);
  const oneToTwenty = Array.from({ length: 20 }, (_, index) => index + 1);

  assert.equal(Stats.nearestRankPercentile(oneToHundred, 0.95), 95);
  assert.equal(Stats.nearestRankPercentile(oneToTwenty, 0.95), 19);
  assert.equal(Stats.nearestRankPercentile([30, 10, 20], 0.95), 30);
  assert.equal(Stats.nearestRankPercentile([], 0.95), null);

  const result = Stats.computeStatistics(oneToThirty());
  assert.equal(result.acceptedCount, 30);
  assert.equal(result.p95IntervalMs, 29);
});

test("population standard deviation matches a hand calculation", () => {
  const values = [2, 4, 4, 4, 5, 5, 7, 9];
  const result = Stats.computeStatistics(values);

  // Mean 5; squared deviations total 32; population variance 32 / 8 = 4.
  approx(result.meanIntervalMs, 5);
  approx(result.standardDeviationMs, 2);
  approx(Stats.populationStandardDeviation(values), 2);
});

test("stability uses an inclusive +/-5% median tolerance", () => {
  const atBoundary = repeat(10, 29).concat([10.5]);
  const outsideBoundary = repeat(10, 29).concat([10.5000001]);

  assert.equal(Stats.median(atBoundary), 10);
  assert.equal(Stats.computeStabilityPercent(atBoundary), 100);
  approx(Stats.computeStabilityPercent(outsideBoundary), 29 / 30 * 100);
});

test("stability classification preserves the 95% and 80% boundaries", () => {
  assert.equal(Stats.classifyStability(95), "STABLE");
  assert.equal(Stats.classifyStability(94.999), "VARIABLE");
  assert.equal(Stats.classifyStability(80), "VARIABLE");
  assert.equal(Stats.classifyStability(79.999), "UNSTABLE");
  assert.equal(Stats.classifyStability(null), "INSUFFICIENT");

  const exactlyNinetyFive = Stats.computeStatistics(repeat(10, 57).concat(repeat(20, 3)));
  assert.equal(exactlyNinetyFive.acceptedCount, 60);
  approx(exactlyNinetyFive.stabilityPercent, 95);
  assert.equal(exactlyNinetyFive.stabilityClassification, "STABLE");

  const exactlyEighty = Stats.computeStatistics(repeat(10, 24).concat(repeat(20, 6)));
  approx(exactlyEighty.stabilityPercent, 80);
  assert.equal(exactlyEighty.stabilityClassification, "VARIABLE");

  const belowEighty = Stats.computeStatistics(repeat(10, 23).concat(repeat(20, 7)));
  approx(belowEighty.stabilityPercent, 23 / 30 * 100);
  assert.equal(belowEighty.stabilityClassification, "UNSTABLE");
});

test("empty observations return explicit unavailable statistics", () => {
  const result = Stats.computeStatistics([]);

  assert.equal(result.acceptedCount, 0);
  assert.equal(result.excludedGapCount, 0);
  assert.equal(result.invalidCount, 0);
  assert.equal(result.acceptedDurationMs, 0);
  assert.equal(result.excludedGapDurationMs, 0);
  assert.equal(result.longestExcludedGapMs, 0);
  assert.equal(result.meanIntervalMs, null);
  assert.equal(result.medianIntervalMs, null);
  assert.equal(result.minIntervalMs, null);
  assert.equal(result.maxIntervalMs, null);
  assert.equal(result.standardDeviationMs, null);
  assert.equal(result.p95IntervalMs, null);
  assert.equal(result.stabilityPercent, null);
  assert.equal(result.stabilityClassification, "INSUFFICIENT");
  assert.equal(result.usableCoveragePercent, null);
  assert.equal(result.averageFps, null);
  assert.equal(result.medianFps, null);
  assert.equal(result.minimumFps, null);
  assert.equal(result.maximumFps, null);
  assert.equal(result.lastIntervalFps, null);
  assert.equal(result.sufficientSample, false);
});

test("a single accepted interval is valid but insufficient for P95 and stability", () => {
  const result = Stats.computeStatistics([16.67]);

  assert.equal(result.acceptedCount, 1);
  approx(result.meanIntervalMs, 16.67);
  approx(result.medianIntervalMs, 16.67);
  approx(result.minIntervalMs, 16.67);
  approx(result.maxIntervalMs, 16.67);
  approx(result.standardDeviationMs, 0);
  approx(result.averageFps, 1000 / 16.67);
  assert.equal(result.p95IntervalMs, null);
  assert.equal(result.stabilityPercent, null);
  assert.equal(result.stabilityClassification, "INSUFFICIENT");
  assert.equal(result.usableCoveragePercent, 100);
  assert.equal(result.sufficientSample, false);
});

test("zero and negative observations are invalid, not long gaps", () => {
  const result = Stats.computeStatistics([0, -1, -16.67]);

  assert.equal(result.acceptedCount, 0);
  assert.equal(result.excludedGapCount, 0);
  assert.equal(result.invalidCount, 3);
  assert.equal(result.excludedGapDurationMs, 0);
  assert.deepEqual(result.invalidObservations, [0, -1, -16.67]);
});

test("NaN and infinities are invalid observations", () => {
  const result = Stats.computeStatistics([NaN, Infinity, -Infinity]);

  assert.equal(result.acceptedCount, 0);
  assert.equal(result.excludedGapCount, 0);
  assert.equal(result.invalidCount, 3);
  assert.equal(result.acceptedDurationMs, 0);
});

test("mixed valid, invalid, and long-gap observations are classified separately", () => {
  const observations = [16.67, 0, 16.67, NaN, -Infinity, 400, 250, 250.01];
  const result = Stats.computeStatistics(observations);

  assert.equal(result.acceptedCount, 3);
  assert.equal(result.invalidCount, 3);
  assert.equal(result.excludedGapCount, 2);
  assert.deepEqual(result.acceptedIntervals, [16.67, 16.67, 250]);
  assert.deepEqual(result.excludedGaps, [400, 250.01]);
  approx(result.acceptedDurationMs, 283.34);
  approx(result.excludedGapDurationMs, 650.01);
  approx(result.longestExcludedGapMs, 400);
  approx(result.usableCoveragePercent, 100 * 283.34 / (283.34 + 650.01));
});

test("very large finite intervals are long gaps and cannot distort accepted cadence", () => {
  const result = Stats.computeStatistics([Number.MAX_VALUE, 16.67, 8.33]);

  assert.equal(result.acceptedCount, 2);
  assert.equal(result.excludedGapCount, 1);
  assert.equal(result.invalidCount, 0);
  assert.equal(result.excludedGapDurationMs, Number.MAX_VALUE);
  assert.ok(Number.isFinite(result.excludedGapDurationMs));
  approx(result.meanIntervalMs, (16.67 + 8.33) / 2);
  approx(result.medianIntervalMs, (16.67 + 8.33) / 2);
  assert.ok(Number.isFinite(result.usableCoveragePercent));

  assert.equal(Stats.computeStatistics([250]).acceptedCount, 1);
  assert.equal(Stats.computeStatistics([250.0001]).excludedGapCount, 1);
});

test("computing statistics does not mutate the caller's observations", () => {
  const observations = [16.67, 8.33, 400, NaN, 0];
  const snapshot = observations.slice();

  Stats.computeStatistics(observations);
  Stats.median([3, 1, 2]);

  assert.deepEqual(observations, snapshot);
});

test("accepted intervals and a 400 ms gap produce correct accounting", () => {
  const accepted = repeat(16.67, 30);
  const result = Stats.computeStatistics(accepted.concat([400]));

  assert.equal(result.acceptedCount, 30);
  assert.equal(result.excludedGapCount, 1);
  approx(result.acceptedDurationMs, 30 * 16.67);
  approx(result.excludedGapDurationMs, 400);
  approx(result.longestExcludedGapMs, 400);
  approx(result.usableCoveragePercent, 100 * 30 * 16.67 / (30 * 16.67 + 400));
  assert.equal(result.sufficientSample, true);
  assert.notEqual(result.p95IntervalMs, null);
  assert.notEqual(result.stabilityPercent, null);
});

test("gap count, total duration, and longest gap come from the same classification", () => {
  const result = Stats.computeStatistics([16, 300, 16, 400, 500]);

  assert.equal(result.acceptedCount, 2);
  assert.equal(result.excludedGapCount, 3);
  approx(result.acceptedDurationMs, 32);
  approx(result.excludedGapDurationMs, 1200);
  approx(result.longestExcludedGapMs, 500);
  approx(result.usableCoveragePercent, 100 * 32 / (32 + 1200));
});

test("coverage uses accepted duration divided by accepted plus excluded gap duration", () => {
  const result = Stats.computeStatistics([10, 20, 300]);

  assert.equal(result.acceptedCount, 2);
  assert.equal(result.excludedGapCount, 1);
  approx(result.acceptedDurationMs, 30);
  approx(result.excludedGapDurationMs, 300);
  approx(result.usableCoveragePercent, 100 * 30 / 330);
});

test("a dataset with no excluded gaps has full interval coverage", () => {
  const result = Stats.computeStatistics(repeat(16.67, 30));

  assert.equal(result.excludedGapCount, 0);
  assert.equal(result.excludedGapDurationMs, 0);
  assert.equal(result.longestExcludedGapMs, 0);
  assert.equal(result.usableCoveragePercent, 100);
});

test("a dataset containing only long gaps has zero usable coverage", () => {
  const result = Stats.computeStatistics([300, 400]);

  assert.equal(result.acceptedCount, 0);
  assert.equal(result.excludedGapCount, 2);
  approx(result.excludedGapDurationMs, 700);
  approx(result.longestExcludedGapMs, 400);
  assert.equal(result.usableCoveragePercent, 0);
  assert.equal(result.averageFps, null);
  assert.equal(result.p95IntervalMs, null);
  assert.equal(result.stabilityPercent, null);
  assert.equal(result.sufficientSample, false);
});

test("hidden-tab pause accounting is separate from long-gap accounting", () => {
  let pauses = Stats.addHiddenPause(Stats.EMPTY_HIDDEN_PAUSE_ACCOUNTING, 1500);
  pauses = Stats.addHiddenPause(pauses, 500);

  assert.deepEqual(pauses, { count: 2, durationMs: 2000 });

  const result = Stats.computeStatistics(repeat(16.67, 30));
  assert.equal(result.excludedGapCount, 0);
  assert.equal(result.excludedGapDurationMs, 0);
  assert.equal(result.usableCoveragePercent, 100);
  assert.deepEqual(pauses, { count: 2, durationMs: 2000 });

  assert.deepEqual(Stats.addHiddenPause(pauses, -20), pauses);
  assert.deepEqual(Stats.addHiddenPause(pauses, NaN), pauses);
  assert.deepEqual(
    Stats.addHiddenPause(Stats.EMPTY_HIDDEN_PAUSE_ACCOUNTING, 0),
    { count: 1, durationMs: 0 }
  );
});

test("fewer than 30 accepted intervals are insufficient", () => {
  const result = Stats.computeStatistics(repeat(16.67, 29));

  assert.equal(result.acceptedCount, 29);
  assert.equal(result.sufficientSample, false);
  assert.equal(result.p95IntervalMs, null);
  assert.equal(result.stabilityPercent, null);
  assert.equal(result.stabilityClassification, "INSUFFICIENT");
  assert.ok(Number.isFinite(result.averageFps));
});

test("exactly 30 accepted intervals are sufficient", () => {
  const result = Stats.computeStatistics(repeat(16.67, 30));

  assert.equal(result.acceptedCount, 30);
  assert.equal(result.sufficientSample, true);
  assert.equal(result.p95IntervalMs, 16.67);
  assert.equal(result.stabilityPercent, 100);
  assert.equal(result.stabilityClassification, "STABLE");
});

test("more than 30 accepted intervals remain sufficient", () => {
  const result = Stats.computeStatistics(repeat(16.67, 31));

  assert.equal(result.acceptedCount, 31);
  assert.equal(result.sufficientSample, true);
  assert.equal(result.p95IntervalMs, 16.67);
  assert.equal(result.stabilityPercent, 100);
});

test("the first eligible sample count produces valid P95 and stability", () => {
  const result = Stats.computeStatistics(repeat(16, 15).concat(repeat(17, 15)));

  assert.equal(result.acceptedCount, 30);
  assert.equal(result.sufficientSample, true);
  assert.equal(result.p95IntervalMs, 17);
  assert.equal(result.stabilityPercent, 100);
  assert.equal(result.stabilityClassification, "STABLE");
});

test("average FPS is 1000 divided by the accepted arithmetic mean", () => {
  const observations = repeat(8.33, 39).concat([16.67]);
  const mean = observations.reduce((sum, value) => sum + value, 0) / observations.length;
  const result = Stats.computeStatistics(observations);

  approx(result.meanIntervalMs, mean);
  approx(result.averageFps, 1000 / mean);
  approx(result.medianFps, 1000 / 8.33);
  assert.ok(Math.abs(result.averageFps - result.medianFps) > 1);
});

test("derived statistics stay finite for supported valid input", () => {
  const result = Stats.computeStatistics(repeat(16.67, 60));
  const finiteFields = [
    "acceptedDurationMs",
    "excludedGapDurationMs",
    "meanIntervalMs",
    "medianIntervalMs",
    "minIntervalMs",
    "maxIntervalMs",
    "standardDeviationMs",
    "p95IntervalMs",
    "stabilityPercent",
    "usableCoveragePercent",
    "averageFps",
    "medianFps",
    "minimumFps",
    "maximumFps",
    "lastIntervalFps"
  ];

  for (const field of finiteFields) {
    assert.ok(Number.isFinite(result[field]), `${field} should be finite`);
  }
});

test("reordering observations does not change order-independent statistics", () => {
  const observations = repeat(16.67, 15)
    .concat(repeat(17, 15))
    .concat([300, 400, NaN]);
  const reversed = observations.slice().reverse();
  const first = Stats.computeStatistics(observations);
  const second = Stats.computeStatistics(reversed);
  const fields = [
    "acceptedCount",
    "excludedGapCount",
    "invalidCount",
    "acceptedDurationMs",
    "excludedGapDurationMs",
    "longestExcludedGapMs",
    "usableCoveragePercent",
    "meanIntervalMs",
    "medianIntervalMs",
    "minIntervalMs",
    "maxIntervalMs",
    "standardDeviationMs",
    "p95IntervalMs",
    "stabilityPercent",
    "stabilityClassification",
    "averageFps",
    "medianFps",
    "minimumFps",
    "maximumFps"
  ];

  for (const field of fields) {
    assert.deepEqual(second[field], first[field], `${field} should be order-independent`);
  }
});

test("invalid observations cannot inflate the accepted sample count", () => {
  const result = Stats.computeStatistics([0, -1, NaN, Infinity, -Infinity, 16.67, 16.67, 251, 400]);

  assert.equal(result.acceptedCount, 2);
  assert.equal(result.invalidCount, 5);
  assert.equal(result.excludedGapCount, 2);
  assert.deepEqual(result.acceptedIntervals, [16.67, 16.67]);
  assert.equal(result.sufficientSample, false);
});

test("the browser integration consumes the tested module without duplicate formulas", () => {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const script = fs.readFileSync(path.join(ROOT, "script.js"), "utf8");
  const statsSource = fs.readFileSync(path.join(ROOT, "stats.js"), "utf8");

  const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((match) => match[1]);
  assert.deepEqual(scripts, [
    "stats.js",
    "measurement.js",
    "insights.js",
    "storage.js",
    "comparison.js",
    "script.js"
  ]);
  assert.doesNotMatch(html, /type=["']module["']/);
  assert.match(script, /const Stats = window\.RefreshTestStats;/);
  assert.match(script, /const Measurement = window\.RefreshTestMeasurement;/);
  assert.match(script, /const Insights = window\.RefreshTestInsights;/);
  assert.match(script, /const Storage = window\.RefreshTestStorage;/);
  assert.match(script, /const Comparison = window\.RefreshTestComparison;/);
  assert.match(script, /Stats\.computeStatistics\(/);
  assert.match(script, /Stats\.buildHistogram\(/);
  assert.match(script, /Stats\.median\(/);
  assert.match(script, /Measurement\.createRun\(/);
  assert.match(script, /Measurement\.recordFrame\(/);
  assert.match(script, /Measurement\.pauseRun\(/);
  assert.match(script, /Measurement\.resumeRun\(/);
  assert.match(script, /Measurement\.cancelRun\(/);
  assert.match(script, /Insights\.buildInsights\(/);
  assert.match(script, /Insights\.selectPreviousSession\(/);
  assert.match(script, /Storage\.loadSessions\(/);
  assert.match(script, /Storage\.saveSession\(/);
  assert.match(script, /Storage\.exportSessions\(/);
  assert.match(script, /Storage\.parseImport\(/);
  assert.match(script, /Comparison\.compareSessions\(/);
  assert.match(script, /Comparison\.deriveSessionSummary\(/);
  // Lifecycle and identity guards that are exercised in the real-browser check.
  assert.match(script, /if \(target !== "test" && isRunning\(\)\) cancelMeasurement\("navigation"\)/);
  assert.match(script, /run\.measureToken !== measureToken/);
  assert.match(script, /if \(result\.sessionRecord\)/);
  assert.match(script, /reader\.readAsText\(file, "UTF-8"\)/);
  assert.doesNotMatch(script, /function median\s*\(/);
  assert.doesNotMatch(script, /function minMax\s*\(/);
  assert.doesNotMatch(script, /Math\.sqrt\(variance/);

  // Imported and stored values must never be rendered as markup.
  assert.doesNotMatch(script, /\.innerHTML\b/);
  assert.doesNotMatch(script, /\.outerHTML\b/);
  assert.doesNotMatch(script, /insertAdjacentHTML\s*\(/);
  assert.doesNotMatch(script, /document\.write\s*\(/);
  assert.doesNotMatch(script, /\beval\s*\(/);
  assert.doesNotMatch(script, /new Function\s*\(/);

  const sandbox = { window: {} };
  vm.runInNewContext(statsSource, sandbox, { filename: "stats.js" });
  assert.equal(typeof sandbox.window.RefreshTestStats.computeStatistics, "function");
  assert.equal(typeof sandbox.window.RefreshTestStats.classifyObservation, "function");
  assert.equal(typeof sandbox.window.RefreshTestStats.addHiddenPause, "function");
});

test("every static DOM id used by script.js exists in index.html", () => {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const script = fs.readFileSync(path.join(ROOT, "script.js"), "utf8");
  const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
  const referenced = new Set();
  const pattern = /\b(?:setText|setMetric|setMetricParts)\("([^"]+)"|\$\("([^"]+)"/g;
  let match;
  while ((match = pattern.exec(script)) !== null) referenced.add(match[1] || match[2]);

  const missing = [...referenced].filter((id) => !htmlIds.has(id));
  assert.deepEqual(missing, []);
  assert.ok(referenced.size > 40);
});

test("test-only files and internal planning notes are excluded from the static deployment", () => {
  const assetsIgnore = fs.readFileSync(path.join(ROOT, ".assetsignore"), "utf8");
  assert.match(assetsIgnore, /^tests\/$/m);
  assert.match(assetsIgnore, /^node_modules\/$/m);
  assert.match(assetsIgnore, /^\.wrangler\/$/m);
  assert.match(assetsIgnore, /^package\*\.json$/m);
  assert.match(assetsIgnore, /^IMPLEMENTATION_PLAN\.md$/m);
  assert.match(assetsIgnore, /^CHANGELOG\.md$/m);
  assert.match(assetsIgnore, /^wrangler\.jsonc$/m);
  assert.match(assetsIgnore, /^\.git\/$/m);
  assert.match(assetsIgnore, /^\.assetsignore$/m);
});

function oneToThirty() {
  return Array.from({ length: 30 }, (_, index) => index + 1);
}
