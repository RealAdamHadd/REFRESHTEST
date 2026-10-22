"use strict";

/**
 * Extended statistics contracts added in the V2 platform upgrade.
 * Run with: node --test tests/stats.extended.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const Stats = require("../stats.js");

function increasing(count) {
  return Array.from({ length: count }, (_, index) => index + 1);
}

function approx(actual, expected, epsilon = 1e-9, message) {
  assert.equal(typeof actual, "number", message);
  assert.ok(Math.abs(actual - expected) <= epsilon, message || `${actual} != ${expected}`);
}

test("P50 is the median and is available from one accepted interval", () => {
  const single = Stats.computeStatistics([16.67]);
  assert.equal(single.p50IntervalMs, 16.67);
  assert.equal(single.medianIntervalMs, single.p50IntervalMs);

  const even = Stats.computeStatistics([10, 20]);
  assert.equal(even.p50IntervalMs, 15);
});

test("P99 is withheld below 100 accepted intervals and available at 100", () => {
  const below = Stats.computeStatistics(increasing(99));
  assert.equal(below.acceptedCount, 99);
  assert.equal(below.p99IntervalMs, null);
  assert.equal(below.minimumP99Samples, 100);

  const atBoundary = Stats.computeStatistics(increasing(100));
  assert.equal(atBoundary.acceptedCount, 100);
  assert.equal(atBoundary.p99IntervalMs, 99);
  assert.equal(atBoundary.p95IntervalMs, 95);
  assert.equal(atBoundary.p50IntervalMs, 50.5);
});

test("nearest-rank P99 uses the same deterministic rank rule", () => {
  assert.equal(Stats.nearestRankPercentile(increasing(100), 0.99), 99);
  assert.equal(Stats.nearestRankPercentile(increasing(200), 0.99), 198);
  assert.equal(Stats.nearestRankPercentile([7], 0.99), 7);
  assert.equal(Stats.nearestRankPercentile(increasing(10), 0.99), 10);
  assert.equal(Stats.nearestRankPercentile(increasing(10), 1), 10);
});

test("coefficient of variation is population deviation divided by mean", () => {
  const values = [2, 4, 4, 4, 5, 5, 7, 9];
  approx(Stats.coefficientOfVariation(values), 0.4);
  assert.equal(Stats.coefficientOfVariation([]), null);
  assert.equal(Stats.coefficientOfVariation([0]), null);
  assert.equal(Stats.coefficientOfVariation([-1, -2]), null);
  approx(Stats.computeStatistics(values).coefficientOfVariation, 0.4);
});

test("statistics output carries the definition version", () => {
  const result = Stats.computeStatistics([16.67]);
  assert.equal(result.statisticsVersion, Stats.STATISTICS_VERSION);
  assert.equal(typeof Stats.STATISTICS_VERSION, "number");
});

test("histogram handles empty and invalid input explicitly", () => {
  const empty = Stats.buildHistogram([]);
  assert.deepEqual(empty.bins, []);
  assert.equal(empty.sampleCount, 0);
  assert.equal(empty.invalidCount, 0);
  assert.equal(empty.min, null);
  assert.equal(empty.max, null);

  const invalid = Stats.buildHistogram([NaN, Infinity, -Infinity, 0, -1]);
  assert.deepEqual(invalid.bins, []);
  assert.equal(invalid.sampleCount, 0);
  assert.equal(invalid.invalidCount, 5);
  assert.equal(Stats.buildHistogram(null).sampleCount, 0);
});

test("histogram bins are deterministic and preserve half-open boundaries", () => {
  const histogram = Stats.buildHistogram([1, 2, 3, 4, 5], { binCount: 2, min: 1, max: 5 });
  assert.equal(histogram.binCount, 2);
  assert.equal(histogram.sampleCount, 5);
  assert.equal(histogram.binWidth, 2);
  assert.equal(histogram.bins[0].count, 2); // 1, 2
  assert.equal(histogram.bins[1].count, 3); // 3, 4, and inclusive upper bound 5
  assert.equal(histogram.underflowCount, 0);
  assert.equal(histogram.overflowCount, 0);

  const repeated = Stats.buildHistogram([1, 2, 3, 4, 5], { binCount: 2, min: 1, max: 5 });
  assert.deepEqual(repeated, histogram);
});

test("histogram counts values outside an explicit domain as underflow or overflow", () => {
  const histogram = Stats.buildHistogram([1, 2, 3, 6, 9], { binCount: 2, min: 2, max: 6 });
  assert.equal(histogram.sampleCount, 5);
  assert.equal(histogram.underflowCount, 1);
  assert.equal(histogram.overflowCount, 1);
  assert.equal(histogram.bins[0].count, 2); // 2, 3
  assert.equal(histogram.bins[1].count, 1); // inclusive upper bound 6
});

test("histogram clamps bin counts and handles a degenerate domain", () => {
  const oneBin = Stats.buildHistogram([16.67, 16.67], { binCount: 0, min: 0, max: 20 });
  assert.equal(oneBin.binCount, 1);
  assert.equal(oneBin.bins[0].count, 2);

  const many = Stats.buildHistogram([16], { binCount: 1000, min: 0, max: 20 });
  assert.equal(many.binCount, 100);

  const flat = Stats.buildHistogram([16], { min: 16, max: 16 });
  assert.ok(flat.max > flat.min);
  assert.equal(flat.sampleCount, 1);
});

test("histogram does not mutate the source array", () => {
  const values = [16.67, 8.33, 16.67, 0];
  const snapshot = values.slice();
  Stats.buildHistogram(values, { binCount: 4, min: 0, max: 20 });
  assert.deepEqual(values, snapshot);
});

test("summary accepted intervals feed the histogram without reclassification", () => {
  const result = Stats.computeStatistics([16, 16, 16, 400, NaN]);
  const histogram = Stats.buildHistogram(result.acceptedIntervals, { binCount: 3, min: 0, max: 30 });
  assert.equal(histogram.sampleCount, 3);
  assert.equal(histogram.invalidCount, 0);
  assert.equal(histogram.bins.reduce((sum, bin) => sum + bin.count, 0), 3);
});
