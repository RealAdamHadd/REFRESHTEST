"use strict";

/**
 * Pure measurement lifecycle tests. These exercise the same run object used by
 * the browser integration, but they do not schedule RAF or touch the DOM.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const Measurement = require("../measurement.js");

function create(overrides = {}) {
  return Measurement.createRun({
    id: "run-1",
    mode: "standard",
    startedAt: 1000,
    ...overrides
  });
}

test("test modes document distinct active windows and keep eight seconds as default", () => {
  assert.equal(Measurement.DEFAULT_MODE, "standard");
  assert.equal(Measurement.DEFAULT_DURATION_MS, 8000);
  assert.deepEqual(
    Measurement.MODE_ORDER.map((id) => Measurement.TEST_MODES[id].durationMs),
    [3000, 8000, 20000, 30000]
  );

  for (const id of Measurement.MODE_ORDER) {
    const mode = Measurement.TEST_MODES[id];
    assert.equal(mode.id, id);
    assert.ok(mode.durationMs > 0);
    assert.ok(mode.description.length > 0);
    assert.ok(mode.tradeOff.length > 0);
  }

  assert.equal(Measurement.getMode("unknown").id, "standard");
});

test("a new run starts empty and running", () => {
  const run = create();
  assert.equal(run.state, Measurement.RUN_STATE.RUNNING);
  assert.equal(run.paused, false);
  assert.equal(run.durationMs, 8000);
  assert.equal(run.observations.length, 0);
  assert.equal(run.acceptedCount, 0);
  assert.deepEqual(run.hiddenPauses, { count: 0, durationMs: 0 });
  assert.equal(Measurement.isLive(run), true);
});

test("recordFrame does not create an interval for the first callback", () => {
  const run = create();
  const first = Measurement.recordFrame(run, 1016, 1016);
  assert.equal(first.ok, true);
  assert.equal(first.recorded, false);
  assert.equal(run.observations.length, 0);
  assert.equal(run.lastFrameTimestamp, 1016);

  const second = Measurement.recordFrame(run, 1032.67, 1032.67);
  assert.equal(second.recorded, true);
  assert.equal(second.kind, "accepted");
  assert.ok(Math.abs(second.delta - 16.67) < 1e-9);
  assert.equal(run.acceptedCount, 1);
  assert.equal(run.observations.length, 1);
});

test("long gaps and invalid intervals update separate counters", () => {
  const run = create();
  Measurement.recordFrame(run, 0, 0);
  Measurement.recordFrame(run, 400, 400);
  Measurement.recordFrame(run, 400, 400); // zero delta
  Measurement.recordFrame(run, 416, 416);

  assert.equal(run.acceptedCount, 1);
  assert.equal(run.excludedGapCount, 1);
  assert.equal(run.excludedGapDurationMs, 400);
  assert.equal(run.longestExcludedGapMs, 400);
  assert.equal(run.invalidCount, 1);
  assert.deepEqual(run.observations, [400, 0, 16]);
});

test("a run completes only after its active window", () => {
  const run = create({ durationMs: 32 });
  Measurement.recordFrame(run, 1000, 1000);
  const early = Measurement.recordFrame(run, 1016, 1016);
  assert.equal(early.complete, false);
  const due = Measurement.recordFrame(run, 1032, 1032);
  assert.equal(due.complete, true);

  const elapsed = Measurement.completeRun(run, 1032);
  assert.equal(elapsed, 32);
  assert.equal(run.state, Measurement.RUN_STATE.COMPLETED);
  assert.equal(Measurement.isLive(run), false);

  const after = Measurement.recordFrame(run, 1048, 1048);
  assert.equal(after.ok, false);
  assert.equal(after.reason, "not-running");
  assert.equal(run.acceptedCount, 2);
});

test("completion clamps to the first callback at or beyond the window", () => {
  const run = create({ durationMs: 20 });
  Measurement.recordFrame(run, 1000, 1000);
  const result = Measurement.recordFrame(run, 1040, 1040);
  assert.equal(result.complete, true);
  assert.equal(result.elapsedMs, 40);
});

test("pause and resume exclude hidden time and reset the frame timestamp", () => {
  const run = create({ durationMs: 8000 });
  Measurement.recordFrame(run, 1000, 1000);
  Measurement.recordFrame(run, 1016, 1016);

  assert.equal(Measurement.pauseRun(run, 1050), true);
  assert.equal(Measurement.pauseRun(run, 1060), false);
  assert.equal(Measurement.recordFrame(run, 1200, 1200).reason, "paused");
  assert.equal(Measurement.getElapsedMs(run, 1200), 50);

  const resumed = Measurement.resumeRun(run, 1200);
  assert.equal(resumed.hiddenDurationMs, 150);
  assert.deepEqual(run.hiddenPauses, { count: 1, durationMs: 150 });
  assert.equal(run.lastFrameTimestamp, null);
  assert.equal(Measurement.resumeRun(run, 1210), null);

  const afterResume = Measurement.recordFrame(run, 1216, 1216);
  assert.equal(afterResume.recorded, false);
  const next = Measurement.recordFrame(run, 1232, 1232);
  assert.equal(next.recorded, true);
  assert.equal(next.delta, 16);
  assert.equal(Measurement.getElapsedMs(run, 1232), 82);
  assert.deepEqual(run.observations, [16, 16]);
});

test("completion after a hidden pause uses active time, not wall-clock time", () => {
  const run = create({ durationMs: 100 });
  Measurement.recordFrame(run, 1000, 1000);
  Measurement.recordFrame(run, 1016, 1016);
  Measurement.pauseRun(run, 1020);
  Measurement.resumeRun(run, 5020);

  const resumedFrame = Measurement.recordFrame(run, 5020, 5020);
  assert.equal(resumedFrame.recorded, false);
  const next = Measurement.recordFrame(run, 5036, 5036);
  assert.equal(next.recorded, true);
  assert.equal(next.elapsedMs, 36);
  assert.equal(next.complete, false);

  const last = Measurement.recordFrame(run, 5116, 5116);
  assert.equal(last.elapsedMs, 116);
  assert.equal(last.complete, true);
  assert.equal(Measurement.completeRun(run, 5116), 116);
  assert.equal(run.state, Measurement.RUN_STATE.COMPLETED);
});

test("repeated visibility pauses cannot double-count hidden duration", () => {
  const run = create();
  Measurement.pauseRun(run, 1000);
  Measurement.pauseRun(run, 1100);
  Measurement.resumeRun(run, 1300);
  Measurement.pauseRun(run, 1400);
  Measurement.resumeRun(run, 1450);

  assert.equal(run.hiddenPauses.count, 2);
  assert.equal(run.hiddenPauses.durationMs, 350);
  assert.equal(Measurement.getElapsedMs(run, 1450), 100);
});

test("starting hidden pauses from the start timestamp without counting hidden time", () => {
  const run = create({ startedAt: 2000 });
  assert.equal(Measurement.pauseRun(run, 2000), true);
  Measurement.resumeRun(run, 2400);
  assert.deepEqual(run.hiddenPauses, { count: 1, durationMs: 400 });
  assert.equal(Measurement.getElapsedMs(run, 2400), 0);
  Measurement.recordFrame(run, 2400, 2400);
  Measurement.recordFrame(run, 2416, 2416);
  assert.equal(Measurement.getElapsedMs(run, 2416), 16);
});

test("cancel ends the run and is never mistaken for completion", () => {
  const run = create({ durationMs: 8000 });
  Measurement.recordFrame(run, 1000, 1000);
  Measurement.recordFrame(run, 1016, 1016);
  const elapsed = Measurement.cancelRun(run, 1100);
  assert.equal(elapsed, 100);
  assert.equal(run.state, Measurement.RUN_STATE.CANCELLED);
  assert.equal(run.acceptedCount, 1);

  assert.equal(Measurement.completeRun(run, 1200), null);
  assert.equal(Measurement.cancelRun(run, 1200), null);
  assert.equal(Measurement.recordFrame(run, 1116, 1116).ok, false);
});

test("stopped runs cannot resume or accept frames", () => {
  const run = create();
  Measurement.pauseRun(run, 1100);
  Measurement.cancelRun(run, 1200);
  assert.equal(Measurement.resumeRun(run, 1300), null);
  assert.equal(Measurement.recordFrame(run, 1316, 1316).ok, false);
});

test("a new run cannot inherit observations from an earlier run", () => {
  const first = create({ id: "first" });
  Measurement.recordFrame(first, 0, 0);
  Measurement.recordFrame(first, 16, 16);
  Measurement.completeRun(first, 16);

  const second = create({ id: "second", startedAt: 5000 });
  assert.deepEqual(second.observations, []);
  assert.equal(second.acceptedCount, 0);
  Measurement.recordFrame(second, 5000, 5000);
  assert.equal(second.observations.length, 0);
  assert.equal(first.observations.length, 1);
});

test("bounded retention reports dropped observations instead of silently truncating", () => {
  const run = create({ maxObservations: 3 });
  Measurement.recordFrame(run, 0, 0);
  Measurement.recordFrame(run, 10, 10);
  Measurement.recordFrame(run, 30, 30);
  Measurement.recordFrame(run, 60, 60);
  Measurement.recordFrame(run, 100, 100);
  Measurement.recordFrame(run, 150, 150);

  assert.equal(run.observations.length, 3);
  assert.equal(run.acceptedCount, 3);
  assert.equal(run.droppedObservations, 2);
  assert.deepEqual(run.observations, [10, 20, 30]);
});

test("invalid timestamps are rejected without changing run state", () => {
  const run = create();
  Measurement.recordFrame(run, 1000, 1000);
  const invalid = Measurement.recordFrame(run, NaN, 1020);
  assert.equal(invalid.ok, false);
  assert.equal(invalid.reason, "invalid-timestamp");
  assert.equal(run.lastFrameTimestamp, 1000);
  assert.equal(Measurement.recordFrame(run, 1016, Infinity).ok, false);
});

test("duration overrides are bounded by caller input but still explicit", () => {
  const shortcut = create({ mode: "diagnostics", durationMs: 100 });
  assert.equal(shortcut.mode, "diagnostics");
  assert.equal(shortcut.durationMs, 100);
  assert.equal(shortcut.modeConfig.durationMs, 30000);
});
