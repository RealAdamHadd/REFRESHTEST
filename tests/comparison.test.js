"use strict";

/**
 * Pure comparison tests. Sessions are built with the real storage schema and
 * statistics module; no DOM or browser APIs are used.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const Stats = require("../stats.js");
const Storage = require("../storage.js");
const Comparison = require("../comparison.js");
const Insights = require("../insights.js");

function repeat(value, count) {
  return Array.from({ length: count }, () => value);
}

function makeRecord(options = {}) {
  const values = options.values || repeat(16.67, 60);
  const result = Storage.buildSessionRecord({
    id: options.id || "rt-test",
    savedAt: options.savedAt || "2026-10-21T10:00:00.000Z",
    startedAt: "2026-10-21T09:59:52.000Z",
    mode: options.mode || "standard",
    modeLabel: options.modeLabel || "Standard",
    durationMs: options.durationMs === undefined ? 8000 : options.durationMs,
    sampleWindowMs: options.sampleWindowMs || 8000,
    summary: Stats.computeStatistics(values),
    observations: values,
    hiddenPauses: options.hiddenPauses || { count: 0, durationMs: 0 },
    diagnostics: { invalidCount: 0, droppedObservations: 0 },
    environment: { browser: "Chrome", os: "Windows", devicePixelRatio: 1 }
  });
  assert.equal(result.ok, true, result.errors ? JSON.stringify(result.errors) : "build failed");
  return result.record;
}

function row(result, key) {
  return result.rows.find((candidate) => candidate.key === key);
}

test("empty and single-session comparisons return useful states", () => {
  const empty = Comparison.compareSessions([]);
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, "empty");
  assert.match(empty.message, /No saved sessions/);

  const single = Comparison.compareSessions([makeRecord()]);
  assert.equal(single.ok, false);
  assert.equal(single.reason, "need-two");
  assert.match(single.message, /at least 2/);
});

test("compatible sessions produce absolute values and deltas from the earliest baseline", () => {
  const later = makeRecord({
    id: "rt-later",
    savedAt: "2026-10-21T11:00:00.000Z",
    values: repeat(8.33, 120)
  });
  const earlier = makeRecord({
    id: "rt-earlier",
    savedAt: "2026-10-21T10:00:00.000Z",
    values: repeat(16.67, 60)
  });

  const result = Comparison.compareSessions([later, earlier]);
  assert.equal(result.ok, true);
  assert.equal(result.baselineId, "rt-earlier");
  assert.deepEqual(result.sessions.map((session) => session.id), ["rt-earlier", "rt-later"]);

  const median = row(result, "medianIntervalMs");
  assert.equal(median.values[0], 16.67);
  assert.equal(median.values[1], 8.33);
  assert.equal(median.deltas[1].direction, "decrease");
  assert.ok(median.deltas[1].absolute < 0);
  assert.ok(median.deltas[1].percent < 0);
  assert.equal(median.deltas[0], null);

  assert.equal(row(result, "acceptedCount").values[0], 60);
  assert.equal(row(result, "acceptedCount").values[1], 120);
  assert.equal(row(result, "durationMs").values[0], 8);
  assert.equal(row(result, "durationMs").values[1], 8);
});

test("comparison recomputes historical metrics from raw observations", () => {
  const record = makeRecord({ values: repeat(16.67, 60) });
  record.summary.medianIntervalMs = 999;
  record.summary.averageFps = 1;

  const derived = Comparison.deriveSessionSummary(record);
  assert.equal(derived.source, "recomputed");
  assert.equal(derived.summary.medianIntervalMs, 16.67);

  const comparison = Comparison.compareSessions([
    record,
    makeRecord({ id: "rt-other", savedAt: "2026-10-21T11:00:00.000Z", values: repeat(8.33, 60) })
  ]);
  assert.equal(row(comparison, "medianIntervalMs").values[0], 16.67);
  assert.notEqual(row(comparison, "medianIntervalMs").values[0], 999);
});

test("sessions without raw observations report unavailable metrics instead of a summary fallback", () => {
  const first = makeRecord({ id: "rt-no-raw", values: repeat(16.67, 60) });
  delete first.observations;
  const second = makeRecord({
    id: "rt-raw",
    savedAt: "2026-10-21T11:00:00.000Z",
    values: repeat(8.33, 60)
  });

  const result = Comparison.compareSessions([first, second]);
  assert.equal(result.ok, true);
  assert.equal(result.sessions[0].source, "unavailable");
  assert.equal(row(result, "medianIntervalMs").values[0], null);
  assert.equal(row(result, "medianIntervalMs").availableCount, 1);
  assert.ok(result.warnings.some((warning) => warning.code === "missing-raw-intervals"));
});

test("missing metrics remain unavailable rather than becoming zero", () => {
  const small = makeRecord({
    id: "rt-small",
    savedAt: "2026-10-21T10:00:00.000Z",
    values: repeat(16.67, 29)
  });
  const large = makeRecord({
    id: "rt-large",
    savedAt: "2026-10-21T11:00:00.000Z",
    values: repeat(8.33, 120)
  });

  const result = Comparison.compareSessions([small, large]);
  const p95 = row(result, "p95IntervalMs");
  assert.equal(p95.values[0], null);
  assert.equal(p95.values[1], 8.33);
  assert.equal(p95.availableCount, 1);
  assert.equal(p95.comparable, false);
  assert.ok(result.warnings.some((warning) => warning.code === "limited-sample"));

  const p99 = row(result, "p99IntervalMs");
  assert.equal(p99.values[0], null);
  assert.notEqual(p99.values[1], null);
});

test("different test modes and durations are explained as compatibility warnings", () => {
  const quick = makeRecord({
    id: "rt-quick",
    mode: "quick",
    modeLabel: "Quick",
    durationMs: 3000,
    sampleWindowMs: 3000,
    savedAt: "2026-10-21T10:00:00.000Z",
    values: repeat(16.67, 30)
  });
  const standard = makeRecord({
    id: "rt-standard",
    mode: "standard",
    modeLabel: "Standard",
    durationMs: 8000,
    sampleWindowMs: 8000,
    savedAt: "2026-10-21T11:00:00.000Z",
    values: repeat(16.67, 60)
  });

  const result = Comparison.compareSessions([quick, standard]);
  assert.ok(result.warnings.some((warning) => warning.code === "mode-mismatch"));
  assert.ok(result.warnings.some((warning) => warning.code === "duration-mismatch"));
  assert.ok(result.warnings.some((warning) => warning.code === "sample-size-spread") === false);
});

test("historical threshold settings do not produce a misleading comparison warning", () => {
  const first = makeRecord({ id: "rt-a", values: repeat(16.67, 30) });
  const second = makeRecord({
    id: "rt-b",
    savedAt: "2026-10-21T11:00:00.000Z",
    values: repeat(16.67, 30)
  });
  second.settings.maxAcceptedIntervalMs = 500;

  const result = Comparison.compareSessions([first, second]);
  assert.ok(!result.warnings.some((warning) => warning.code === "threshold-mismatch"));
  assert.equal(row(result, "usableCoveragePercent").comparable, true);
  assert.equal(row(result, "excludedGapCount").comparable, true);
  assert.equal(row(result, "medianIntervalMs").comparable, true);
});

test("statistics-version differences and hidden pauses are disclosed", () => {
  const first = makeRecord({
    id: "rt-a",
    values: repeat(16.67, 60),
    hiddenPauses: { count: 1, durationMs: 1200 }
  });
  const second = makeRecord({
    id: "rt-b",
    savedAt: "2026-10-21T11:00:00.000Z",
    values: repeat(16.67, 60)
  });
  second.settings.statsVersion = 1;

  const result = Comparison.compareSessions([first, second]);
  assert.ok(result.warnings.some((warning) => warning.code === "statistics-version-mismatch"));
  assert.ok(result.warnings.some((warning) => warning.code === "hidden-pauses"));
});

test("very different sample counts are noted without normalizing values", () => {
  const result = Comparison.compareSessions([
    makeRecord({ id: "rt-small", values: repeat(16.67, 30), savedAt: "2026-10-21T10:00:00.000Z" }),
    makeRecord({ id: "rt-large", values: repeat(16.67, 600), savedAt: "2026-10-21T11:00:00.000Z" })
  ]);

  assert.ok(result.warnings.some((warning) => warning.code === "sample-size-spread"));
  assert.equal(row(result, "acceptedCount").values[0], 30);
  assert.equal(row(result, "acceptedCount").values[1], 600);
});

test("comparison is deterministic, non-mutating, and always includes the causation note", () => {
  const first = makeRecord({ id: "rt-a", values: repeat(16, 60) });
  const second = makeRecord({ id: "rt-b", savedAt: "2026-10-21T11:00:00.000Z", values: repeat(17, 60) });
  const snapshot = JSON.parse(JSON.stringify([first, second]));

  const one = Comparison.compareSessions([first, second]);
  const two = Comparison.compareSessions([first, second]);
  assert.deepEqual(one, two);
  assert.deepEqual([first, second], snapshot);
  assert.ok(one.notes.some((note) => /do not establish causation/.test(note)));
  assert.match(Comparison.COMPARISON_NOTE, /not direct physical panel measurements/);
});

test("computeDelta reports direction, absolute change, and percent change", () => {
  assert.deepEqual(Comparison.computeDelta(10, 8), {
    absolute: 2,
    percent: 25,
    direction: "increase"
  });
  assert.deepEqual(Comparison.computeDelta(6, 8), {
    absolute: -2,
    percent: -25,
    direction: "decrease"
  });
  assert.deepEqual(Comparison.computeDelta(8, 8), {
    absolute: 0,
    percent: 0,
    direction: "unchanged"
  });
  assert.equal(Comparison.computeDelta(8, 0).percent, null);
  assert.equal(Comparison.computeDelta(null, 8), null);
});

test("session labels are stable and expose mode plus UTC save time", () => {
  const record = makeRecord({ modeLabel: "Extended", savedAt: "2026-10-21T12:34:00.000Z" });
  const view = Comparison.sessionView(record);
  assert.equal(view.shortLabel, "2026-10-21 12:34 UTC");
  assert.match(view.label, /Extended/);
  assert.equal(Comparison.formatSavedAt("not-a-date"), "Unknown date");
});

test("the statistics-version compatibility matrix has one explicit policy", () => {
  assert.deepEqual(Stats.checkStatisticsCompatibility(2, 2), {
    compatible: true,
    status: "current",
    left: 2,
    right: 2
  });
  assert.equal(Stats.checkStatisticsCompatibility(1, 1).compatible, true);
  assert.equal(Stats.checkStatisticsCompatibility(1, 1).status, "older");
  assert.equal(Stats.checkStatisticsCompatibility(1, 2).status, "mismatch");
  assert.equal(Stats.checkStatisticsCompatibility(null, 2).status, "unknown");
  assert.equal(Stats.checkStatisticsCompatibility(3, 3).status, "future");
  assert.equal(Stats.checkStatisticsCompatibility(3, 2).compatible, false);
});

test("unknown and future statistics versions withhold descriptive deltas", () => {
  const known = makeRecord({ id: "rt-known", values: repeat(16.67, 60) });
  const unknown = JSON.parse(JSON.stringify(known));
  unknown.id = "rt-unknown";
  unknown.savedAt = "2026-10-21T11:00:00.000Z";
  delete unknown.summary.statisticsVersion;
  delete unknown.settings.statsVersion;

  const unknownResult = Comparison.compareSessions([known, unknown]);
  assert.equal(unknownResult.versionCompatible, false);
  assert.ok(unknownResult.warnings.some((warning) => warning.code === "statistics-version-unknown"));
  assert.equal(row(unknownResult, "medianIntervalMs").deltas[1], null);
  assert.ok(unknownResult.notes.some((note) => /Descriptive differences are withheld/.test(note)));

  const future = JSON.parse(JSON.stringify(known));
  future.id = "rt-future";
  future.savedAt = "2026-10-21T11:00:00.000Z";
  future.summary.statisticsVersion = 3;
  future.settings.statsVersion = 3;
  const futureResult = Comparison.compareSessions([known, future]);
  assert.equal(futureResult.versionCompatible, false);
  assert.ok(futureResult.warnings.some((warning) => warning.code === "statistics-version-future"));
  assert.equal(row(futureResult, "medianIntervalMs").deltas[1], null);
});

test("conflicting version fields are treated as unknown, not silently resolved", () => {
  const first = makeRecord({ id: "rt-a", values: repeat(16.67, 60) });
  const second = makeRecord({ id: "rt-b", savedAt: "2026-10-21T11:00:00.000Z", values: repeat(16.67, 60) });
  second.settings.statsVersion = 1;

  const result = Comparison.compareSessions([first, second]);
  assert.equal(result.versionCompatible, false);
  assert.ok(result.warnings.some((warning) => warning.code === "statistics-version-mismatch"));
  assert.equal(row(result, "medianIntervalMs").deltas[1], null);
});

test("two sessions recorded with the same earlier version remain comparable", () => {
  const first = makeRecord({ id: "rt-a", values: repeat(16.67, 60) });
  const second = makeRecord({ id: "rt-b", savedAt: "2026-10-21T11:00:00.000Z", values: repeat(16.67, 60) });
  for (const record of [first, second]) {
    record.summary.statisticsVersion = 1;
    record.settings.statsVersion = 1;
  }

  const result = Comparison.compareSessions([first, second]);
  assert.equal(result.versionCompatible, true);
  assert.ok(result.warnings.some((warning) => warning.code === "statistics-version-older"));
  assert.equal(row(result, "medianIntervalMs").deltas[1].direction, "unchanged");
  assert.equal(Stats.checkStatisticsCompatibility(
    result.sessions[0].statisticsVersion,
    result.sessions[1].statisticsVersion
  ).compatible, true);
});

test("Compare and Insights agree on every statistics-version compatibility state", () => {
  const currentVersion = Stats.STATISTICS_VERSION;
  const olderVersion = Math.max(1, currentVersion - 1);
  const futureVersion = currentVersion + 1;

  function applyVersion(record, version) {
    if (version === "conflict") {
      record.summary.statisticsVersion = currentVersion;
      record.settings.statsVersion = olderVersion;
      return;
    }
    if (version === null) {
      delete record.summary.statisticsVersion;
      delete record.settings.statsVersion;
      return;
    }
    record.summary.statisticsVersion = version;
    record.settings.statsVersion = version;
  }

  function context(record) {
    const view = Comparison.sessionView(record);
    return {
      summary: view.summary,
      label: view.label,
      mode: view.mode,
      durationMs: view.durationMs,
      statisticsVersion: view.statisticsVersion,
      statisticsVersionConflict: view.statisticsVersionConflict
    };
  }

  const scenarios = [
    { name: "current/current", current: currentVersion, candidate: currentVersion, warning: null },
    { name: "equal older/older", current: olderVersion, candidate: olderVersion, warning: "statistics-version-older" },
    { name: "current/older", current: currentVersion, candidate: olderVersion, warning: "statistics-version-mismatch" },
    { name: "current/unknown", current: currentVersion, candidate: null, warning: "statistics-version-unknown" },
    { name: "unknown/unknown", current: null, candidate: null, warning: "statistics-version-unknown" },
    { name: "future/future", current: futureVersion, candidate: futureVersion, warning: "statistics-version-future" },
    { name: "current/future", current: currentVersion, candidate: futureVersion, warning: "statistics-version-future" },
    { name: "conflicting fields", current: currentVersion, candidate: "conflict", warning: "statistics-version-mismatch" }
  ];

  for (const scenario of scenarios) {
    const currentRecord = makeRecord({ id: "rt-current", values: repeat(16.67, 60) });
    const candidateRecord = makeRecord({
      id: "rt-candidate",
      savedAt: "2026-10-21T11:00:00.000Z",
      values: repeat(16.67, 60)
    });
    applyVersion(currentRecord, scenario.current);
    applyVersion(candidateRecord, scenario.candidate);

    const comparison = Comparison.compareSessions([currentRecord, candidateRecord]);
    const currentContext = context(currentRecord);
    const candidateContext = context(candidateRecord);
    const insight = Insights.checkSessionCompatibility(currentContext, candidateContext);
    const selection = Insights.selectPreviousSession(currentContext, [candidateContext]);

    assert.equal(comparison.versionCompatible, insight.compatible, scenario.name);
    assert.equal(selection.compatible, insight.compatible, scenario.name);
    assert.equal(comparison.versionCompatible, Stats.checkStatisticsCompatibility(
      currentContext.statisticsVersion,
      candidateContext.statisticsVersion
    ).compatible, scenario.name);

    const versionWarnings = comparison.warnings
      .map((warning) => warning.code)
      .filter((code) => code.startsWith("statistics-version-"));
    if (scenario.warning === null) {
      assert.deepEqual(versionWarnings, [], scenario.name);
      assert.notEqual(row(comparison, "medianIntervalMs").deltas[1], null, scenario.name);
    } else {
      assert.ok(versionWarnings.includes(scenario.warning), `${scenario.name}: ${versionWarnings.join(",")}`);
      assert.equal(row(comparison, "medianIntervalMs").deltas[1] === null, !insight.compatible, scenario.name);
      assert.equal(insight.reasons.length > 0, !insight.compatible, scenario.name);
    }
  }
});
