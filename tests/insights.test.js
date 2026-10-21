"use strict";

/**
 * Deterministic insight-rule tests. All inputs are synthetic summaries from the
 * real statistics module; no DOM, timers, or network are involved.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const Stats = require("../stats.js");
const Insights = require("../insights.js");

function repeat(value, count) {
  return Array.from({ length: count }, () => value);
}

function summary(values) {
  return Stats.computeStatistics(values);
}

function ids(result) {
  return result.findings.map((item) => item.id);
}

test("a stable 60 Hz-like run reports low variation and measured cadence", () => {
  const result = Insights.buildInsights(summary(repeat(16.67, 120)), {
    durationMs: 2000,
    modeLabel: "Standard",
    hiddenPauses: { count: 0, durationMs: 0 }
  });

  assert.ok(ids(result).includes("variation-low"));
  assert.ok(ids(result).includes("cadence-baseline"));
  assert.ok(!ids(result).includes("sample-sufficiency"));
  assert.equal(result.headline, "Frame timing was consistent in this sample");
  assert.match(result.findings.find((item) => item.id === "variation-low").evidence, /stability 100\.0%/);

  for (const item of result.findings) {
    assert.equal(typeof item.id, "string");
    assert.ok(["info", "notice", "warning"].includes(item.severity));
    assert.ok(item.title.length > 0);
    assert.ok(item.evidence.length > 0);
    assert.ok(item.explanation.length > 0);
    assert.ok(["measured", "limited", "insufficient"].includes(item.confidence));
    assert.equal(typeof item.metrics, "object");
  }
});

test("no accepted intervals produce an explicit insufficient-data finding", () => {
  const result = Insights.buildInsights(summary([300, 400, NaN]), {
    hiddenPauses: { count: 1, durationMs: 2500 }
  });

  assert.equal(result.findings[0].id, "no-accepted-intervals");
  assert.equal(result.findings[0].severity, "warning");
  assert.equal(result.findings[0].confidence, "insufficient");
  assert.match(result.headline, /No usable frame intervals/);
  assert.ok(ids(result).includes("hidden-pauses"));
});

test("fewer than 30 accepted intervals withhold variation conclusions", () => {
  const result = Insights.buildInsights(summary(repeat(16.67, 29)), { durationMs: 500 });

  assert.ok(ids(result).includes("sample-sufficiency"));
  assert.ok(!ids(result).includes("variation-low"));
  assert.equal(result.headline, "Limited sample: interpret with caution");
  const finding = result.findings.find((item) => item.id === "sample-sufficiency");
  assert.match(finding.evidence, /minimum 30/);
  assert.match(finding.evidence, /P95 and stability withheld/);
});

test("P99 is explained as unavailable below 100 accepted intervals", () => {
  const result = Insights.buildInsights(summary(repeat(16.67, 99)), {});
  assert.ok(ids(result).includes("p99-unavailable"));
  assert.ok(ids(result).includes("variation-low"));
  assert.match(result.findings.find((item) => item.id === "p99-unavailable").evidence, /requires 100/);
});

test("moderate and high variation use documented thresholds", () => {
  assert.equal(Insights.classifyVariation(0.02), "LOW");
  assert.equal(Insights.classifyVariation(0.0200001), "MODERATE");
  assert.equal(Insights.classifyVariation(0.05), "MODERATE");
  assert.equal(Insights.classifyVariation(0.0500001), "HIGH");
  assert.equal(Insights.classifyVariation(null), null);
  assert.equal(Insights.classifyVariation(-0.1), null);

  const moderate = Insights.buildInsights(summary(repeat(16, 80).concat(repeat(18, 20))), {});
  assert.ok(ids(moderate).includes("variation-moderate"));
  assert.equal(moderate.findings.find((item) => item.id === "variation-moderate").severity, "notice");

  const high = Insights.buildInsights(summary(repeat(8, 50).concat(repeat(30, 50))), {});
  assert.ok(ids(high).includes("variation-high"));
  assert.equal(high.findings.find((item) => item.id === "variation-high").severity, "warning");
});

test("long gaps and low coverage are reported separately from accepted cadence", () => {
  const result = Insights.buildInsights(summary(repeat(16.67, 30).concat([400, 600])), {});
  const gap = result.findings.find((item) => item.id === "long-gaps-excluded");
  const coverage = result.findings.find((item) => item.id === "low-coverage");

  assert.ok(gap);
  assert.ok(coverage);
  assert.match(gap.evidence, /2 long gaps/);
  assert.match(gap.evidence, /longest 600 ms/);
  assert.match(gap.explanation, /do not pull the cadence estimate upward/);
  assert.match(coverage.evidence, /coverage/);
  assert.ok(result.findings.some((item) => item.id === "cadence-baseline"));
});

test("hidden pauses are not described as long callback gaps", () => {
  const result = Insights.buildInsights(summary(repeat(16.67, 60)), {
    hiddenPauses: { count: 2, durationMs: 4200 }
  });

  assert.ok(ids(result).includes("hidden-pauses"));
  assert.ok(!ids(result).includes("long-gaps-excluded"));
  const pause = result.findings.find((item) => item.id === "hidden-pauses");
  assert.match(pause.evidence, /2 hidden pauses/);
  assert.match(pause.explanation, /timestamps were reset/);
});

test("upper-tail intervals are flagged when P95 exceeds 1.5x the median", () => {
  const result = Insights.buildInsights(summary(repeat(10, 28).concat([20, 20])), {});
  const tail = result.findings.find((item) => item.id === "interval-tail");

  assert.ok(tail);
  assert.match(tail.evidence, /P95 20\.00 ms/);
  assert.match(tail.evidence, /2\.00× median/);
  assert.equal(tail.severity, "notice");
});

test("low browser cadence is framed as an observation, not a hardware diagnosis", () => {
  const result = Insights.buildInsights(summary(repeat(30, 60)), {});
  const low = result.findings.find((item) => item.id === "low-cadence");

  assert.ok(low);
  assert.match(low.title, /below a common 60 Hz cadence/);
  assert.match(low.explanation, /cannot determine which factor applies/);
  assert.equal(low.confidence, "limited");
});

test("a previous saved session produces a descriptive, non-causal difference", () => {
  const current = summary(repeat(16.67, 60));
  const previous = {
    summary: summary(repeat(8.33, 60)),
    label: "saved 2026-10-20",
    mode: "standard",
    durationMs: 8000,
    statisticsVersion: Stats.STATISTICS_VERSION
  };
  const result = Insights.buildInsights(current, {
    previous,
    mode: "standard",
    durationMs: 8000,
    statisticsVersion: Stats.STATISTICS_VERSION,
    modeLabel: "Standard"
  });
  const difference = result.findings.find((item) => item.id === "session-difference");

  assert.ok(difference);
  assert.match(difference.title, /differed/);
  assert.match(difference.evidence, /8\.33 → 16\.67 ms/);
  assert.match(difference.evidence, /saved 2026-10-20/);
  assert.match(difference.explanation, /cannot determine/);
  assert.match(difference.explanation, /came from/);
  assert.equal(difference.confidence, "limited");
});

test("a near-identical previous session is described as similar", () => {
  const current = summary(repeat(16.67, 60));
  const previous = {
    summary: summary(repeat(16.68, 60)),
    mode: "standard",
    durationMs: 8000,
    statisticsVersion: Stats.STATISTICS_VERSION
  };
  const result = Insights.buildInsights(current, {
    previous,
    mode: "standard",
    durationMs: 8000,
    statisticsVersion: Stats.STATISTICS_VERSION
  });
  const difference = result.findings.find((item) => item.id === "session-difference");

  assert.ok(difference);
  assert.match(difference.title, /similar/);
  assert.equal(difference.severity, "info");
});

test("previous-session differences require compatible mode, duration, statistics, and sample size", () => {
  const current = summary(repeat(16.67, 60));
  const baseContext = {
    mode: "standard",
    durationMs: 8000,
    statisticsVersion: Stats.STATISTICS_VERSION
  };
  const previous = {
    summary: summary(repeat(16.67, 60)),
    label: "saved baseline",
    mode: "standard",
    durationMs: 8000,
    statisticsVersion: Stats.STATISTICS_VERSION
  };

  const compatible = Insights.buildInsights(current, { ...baseContext, previous });
  assert.ok(compatible.findings.some((item) => item.id === "session-difference"));
  assert.ok(!compatible.findings.some((item) => item.id === "session-comparison-unavailable"));

  const cases = [
    { change: { mode: "quick" }, reason: /Different measurement modes/ },
    { change: { durationMs: 3000 }, reason: /Active durations differ by more than 20%/ },
    { change: { statisticsVersion: 1 }, reason: /Different statistics versions/ },
    { change: { summary: summary(repeat(16.67, 29)) }, reason: /fewer than 30 accepted intervals/ },
    { change: { mode: null }, reason: /mode was not recorded/ }
  ];

  for (const { change, reason } of cases) {
    const result = Insights.buildInsights(current, {
      ...baseContext,
      previous: { ...previous, ...change }
    });
    const unavailable = result.findings.find((item) => item.id === "session-comparison-unavailable");
    assert.ok(unavailable, JSON.stringify(change));
    assert.match(unavailable.evidence, reason);
    assert.ok(!result.findings.some((item) => item.id === "session-difference"));
    assert.equal(unavailable.confidence, "insufficient");
  }

  const missingCurrentMetadata = Insights.buildInsights(current, {
    previous
  });
  const unavailable = missingCurrentMetadata.findings.find((item) => item.id === "session-comparison-unavailable");
  assert.ok(unavailable);
  assert.match(unavailable.evidence, /mode was not recorded/);
  assert.equal(Insights.checkSessionCompatibility({ summary: current }, previous).compatible, false);
});

test("variation and stability cannot produce contradictory conclusions", () => {
  const outlierHeavy = summary(repeat(16.7, 94).concat(repeat(18.036, 6)));
  assert.equal(outlierHeavy.stabilityClassification, "VARIABLE");
  assert.ok(outlierHeavy.coefficientOfVariation <= Insights.THRESHOLDS.LOW_VARIATION_CV);

  const result = Insights.buildInsights(outlierHeavy, {
    mode: "standard",
    durationMs: 8000,
    statisticsVersion: Stats.STATISTICS_VERSION
  });
  assert.ok(!result.findings.some((item) => item.id === "variation-low"));
  const variation = result.findings.find((item) => item.id === "variation-moderate");
  assert.ok(variation);
  assert.match(variation.explanation, /measure different properties|more cautious/);
  assert.equal(variation.metrics.variationByCoefficient, "LOW");
  assert.equal(variation.metrics.variationByStability, "MODERATE");
  assert.equal(variation.metrics.combinedVariation, "MODERATE");

  const stableButOutlying = summary(repeat(10, 57).concat(repeat(20, 3)));
  assert.equal(stableButOutlying.stabilityClassification, "STABLE");
  assert.ok(stableButOutlying.coefficientOfVariation > Insights.THRESHOLDS.MODERATE_VARIATION_CV);
  const high = Insights.buildInsights(stableButOutlying, {});
  const highVariation = high.findings.find((item) => item.id === "variation-high");
  assert.ok(highVariation);
  assert.match(highVariation.explanation, /different properties|more cautious/);
  assert.doesNotMatch(high.headline, /consistent/i);
});

test("reconciled variation uses the more cautious band at boundaries", () => {
  assert.equal(Insights.reconcileVariation(0.02, "STABLE"), "LOW");
  assert.equal(Insights.reconcileVariation(0.0200001, "STABLE"), "MODERATE");
  assert.equal(Insights.reconcileVariation(0.05, "VARIABLE"), "MODERATE");
  assert.equal(Insights.reconcileVariation(0.0500001, "STABLE"), "HIGH");
  assert.equal(Insights.reconcileVariation(0.01, "VARIABLE"), "MODERATE");
  assert.equal(Insights.reconcileVariation(0.01, "UNSTABLE"), "HIGH");
  assert.equal(Insights.reconcileVariation(null, "STABLE"), "LOW");
  assert.equal(Insights.reconcileVariation(0.01, null), "LOW");
  assert.equal(Insights.reconcileVariation(null, null), null);
});

test("dropped observations and invalid observations are disclosed", () => {
  const result = Insights.buildInsights(summary([16, 16, 400, 0, NaN]), {
    droppedObservations: 5
  });

  assert.ok(ids(result).includes("retention-limit"));
  assert.ok(ids(result).includes("invalid-observations"));
});

test("insight output is deterministic and does not mutate inputs", () => {
  const values = repeat(16, 80).concat(repeat(18, 20), [400]);
  const data = summary(values);
  const context = {
    durationMs: 8000,
    hiddenPauses: { count: 1, durationMs: 200 },
    previous: { summary: summary(repeat(16, 60)) }
  };
  const summarySnapshot = JSON.parse(JSON.stringify(data));
  const first = Insights.buildInsights(data, context);
  const second = Insights.buildInsights(data, context);

  assert.deepEqual(first, second);
  assert.deepEqual(data, summarySnapshot);
  assert.equal(Object.isFrozen(first.findings), true);
  assert.ok(first.findings.length > 0);
});

test("documented thresholds match the stats module sample gates", () => {
  assert.equal(Insights.THRESHOLDS.MIN_ACCEPTED_SAMPLES, Stats.MIN_ACCEPTED_SAMPLES);
  assert.equal(Insights.THRESHOLDS.MIN_P99_SAMPLES, Stats.MIN_P99_SAMPLES);
  assert.equal(Insights.THRESHOLDS.LOW_COVERAGE_PERCENT, 95);
  assert.equal(Insights.THRESHOLDS.P95_TAIL_RATIO, 1.5);
  assert.equal(Insights.THRESHOLDS.P99_TAIL_RATIO, 2);
});

test("limitations are explicit and findings avoid unsupported hardware claims", () => {
  const result = Insights.buildInsights(summary(repeat(16.67, 120)), {});
  const text = [
    ...result.limitations,
    ...result.findings.flatMap((item) => [item.title, item.evidence, item.explanation, item.recommendation || ""])
  ].join(" ");

  assert.match(text, /not direct physical display refresh rate/);
  assert.match(text, /do not establish causation/);
  assert.doesNotMatch(text, /faulty monitor/i);
  assert.doesNotMatch(text, /exact refresh rate is/i);
  assert.doesNotMatch(text, /diagnose (?:a|the) GPU/i);
  assert.doesNotMatch(text, /confidence interval is/i);
});

test("the newest compatible saved session is selected for previous-session findings", () => {
  const current = {
    summary: summary(repeat(16.67, 60)),
    mode: "standard",
    durationMs: 8000,
    statisticsVersion: Stats.STATISTICS_VERSION
  };
  const incompatibleNewest = {
    summary: summary(repeat(8.33, 60)),
    label: "newest",
    mode: "standard",
    durationMs: 8000,
    statisticsVersion: 1
  };
  const compatibleOlder = {
    summary: summary(repeat(16.68, 60)),
    label: "older compatible",
    mode: "standard",
    durationMs: 8000,
    statisticsVersion: Stats.STATISTICS_VERSION
  };

  const selection = Insights.selectPreviousSession(current, [incompatibleNewest, compatibleOlder]);
  assert.equal(selection.compatible, true);
  assert.equal(selection.previous.label, "older compatible");
  assert.equal(selection.skippedCount, 1);

  const result = Insights.buildInsights(current.summary, {
    ...current,
    previous: selection.previous,
    modeLabel: "Standard"
  });
  const difference = result.findings.find((item) => item.id === "session-difference");
  assert.ok(difference);
  assert.match(difference.evidence, /older compatible/);
});

test("when no saved session is compatible the newest one explains why", () => {
  const current = {
    summary: summary(repeat(16.67, 60)),
    mode: "standard",
    durationMs: 8000,
    statisticsVersion: Stats.STATISTICS_VERSION
  };
  const olderVersion = {
    summary: summary(repeat(16.67, 60)),
    label: "older version",
    mode: "standard",
    durationMs: 8000,
    statisticsVersion: 1
  };

  const selection = Insights.selectPreviousSession(current, [olderVersion]);
  assert.equal(selection.compatible, false);
  assert.equal(selection.previous.label, "older version");
  assert.ok(selection.reasons.some((reason) => /Different statistics versions/.test(reason)));

  const result = Insights.buildInsights(current.summary, {
    ...current,
    previous: selection.previous
  });
  const unavailable = result.findings.find((item) => item.id === "session-comparison-unavailable");
  assert.ok(unavailable);
  assert.match(unavailable.evidence, /Different statistics versions/);
  assert.ok(!result.findings.some((item) => item.id === "session-difference"));
});

test("missing and future statistics versions are explicit compatibility reasons", () => {
  const current = {
    summary: summary(repeat(16.67, 60)),
    mode: "standard",
    durationMs: 8000,
    statisticsVersion: Stats.STATISTICS_VERSION
  };
  const missing = Insights.checkSessionCompatibility(current, {
    summary: summary(repeat(16.67, 60)),
    mode: "standard",
    durationMs: 8000,
    statisticsVersion: null
  });
  assert.equal(missing.compatible, false);
  assert.ok(missing.reasons.some((reason) => /not recorded/.test(reason)));

  const future = Insights.checkSessionCompatibility(current, {
    summary: summary(repeat(16.67, 60)),
    mode: "standard",
    durationMs: 8000,
    statisticsVersion: 3
  });
  assert.equal(future.compatible, false);
  assert.ok(future.reasons.some((reason) => /newer statistics version/.test(reason)));

  const conflict = Insights.checkSessionCompatibility(current, {
    summary: summary(repeat(16.67, 60)),
    mode: "standard",
    durationMs: 8000,
    statisticsVersion: null,
    statisticsVersionConflict: true
  });
  assert.equal(conflict.compatible, false);
  assert.ok(conflict.reasons.some((reason) => /fields disagree/.test(reason)));
});
