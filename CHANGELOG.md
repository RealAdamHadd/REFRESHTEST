# Changelog

All notable changes to **RefreshTest** are documented in this file.

RefreshTest is a browser tool that **estimates** display refresh cadence from `requestAnimationFrame` (animation callback) timing. It does not read a panel's physical hardware refresh rate, and it cannot measure pixel response time. This changelog records engineering changes to the measurement logic and UI behavior only.

## Finalization audit — correctness and release readiness

### Fixed

1. **Timestamp normalization is total and explicit.**
   `storage.js` now rejects malformed, non-finite, and out-of-range dates without throwing. `startedAt` remains the immutable measurement start, while `savedAt` is re-stamped when an export-only result is actually committed to local history. Repeated exports of a saved session keep one stable record.

2. **One statistics-version policy for Compare and Insights.**
   `summary.statisticsVersion` is authoritative; `settings.statsVersion` is retained as a legacy mirror. Missing versions stay unknown, conflicting fields are reported instead of silently resolved, and a future version is not treated as current. Current/current and equal older/older pairs are comparable; missing, conflicting, mismatched, and future versions withhold descriptive deltas while keeping sessions viewable.

3. **Corrupt-session quarantine is repeatable and bounded.**
   Each unreadable payload receives a unique quarantine key, quarantine is capped at 10 payloads, and a failed quarantine write leaves the original session in place. The History status now distinguishes “moved to quarantine” from “kept in place,” and a corrupt record retained after a failed write no longer consumes a valid session slot.

4. **Insights selects usable history.**
   When the newest saved session is incompatible, Insights compares against the newest compatible session and labels the result when newer sessions were skipped. If none is compatible, the newest readable session explains why no difference is shown.

5. **Deployment exclusions cover development-only files.**
   `.assetsignore` excludes `tests/`, `node_modules/`, `.wrangler/`, package manifests and lockfiles, planning notes, the changelog, and Wrangler configuration while leaving every runtime asset available.

### Verification

- `node --test`: **130 passing tests**, including timestamp extremes, the full statistics-version policy matrix, repeated corruption, forced quarantine failure, bounded quarantine, session capacity, import validation, Compare/Insights agreement, and script-level save/cancel/history status checks through a deterministic DOM shim.
- Previously performed real headless Edge checks (not re-run by the Node suite): module loading, a 3-second quick run (180 samples), save/history, navigation cancellation, corrupt-session quarantine messaging, valid/duplicate/malformed import, markup rendered as text, Compare withholding deltas for mismatched versions, and Insights selecting an older compatible session.
- Wrangler **4.151.3** `deploy --dry-run --outdir` succeeded against a temporary copy. Debug output showed `tests/`, `node_modules/`, `.wrangler/`, package files, documentation, and configuration ignored, while all eight required runtime assets remained eligible.
- The local `wrangler dev` server could not be started in this non-interactive environment (`write EOF`), so live asset serving was not exercised. This is a tooling limitation, not a deployment result.

## Engineering Batch 1 — Statistical integrity and diagnostics

### Added

1. **Pure statistics module (`stats.js`).**
   Observation classification, median, population standard deviation, nearest-rank P95, stability, coverage, and hidden-tab pause accounting now live in one dependency-free classic script. It exposes `window.RefreshTestStats` in the browser and a guarded CommonJS export for Node tests.

2. **Deterministic test suite (`tests/stats.test.js`).**
   The suite uses only Node built-ins and synthetic arrays. Run it with:

   ```sh
   node --test tests/stats.test.js
   ```

3. **Compact diagnostics line.**
   The existing stability note now also reports P95 interval (when at least 30 accepted intervals exist), accepted interval count, excluded long-gap count/duration/longest gap, usable interval coverage, and hidden-tab pause count/duration when relevant.

4. **Separate hidden-tab pause accounting.**
   Pause events and accumulated hidden duration are tracked independently from long callback gaps. Repeated hide/show transitions are guarded against duplicate accumulation.

### Changed

1. **The browser consumes the tested module.**
   `script.js` no longer contains local median/min/max or duplicate variance/stability calculations. Final metrics are derived from `RefreshTestStats.computeStatistics` over the retained raw observations.

2. **Minimum sample sufficiency.**
   P95 and stability are unavailable below 30 accepted intervals. The result is marked `INSUFFICIENT`, the stability percentage is not shown, and the default `STABLE` label was replaced with `NO DATA` / `INSUFFICIENT`.

3. **Metric labels clarify accepted-interval semantics.**
   Average FPS is labeled as `1000 / mean interval`; min/max FPS identify the longest/shortest accepted interval; frame variation is labeled population σ; test duration notes that hidden time is excluded.

4. **Deployment hygiene.**
   `.assetsignore` excludes the `tests/` directory from the Wrangler static asset upload. The documented Wrangler mechanism (`.assetsignore` in the asset directory, same syntax as `.gitignore`) was used; no Wrangler configuration change was needed.

### Validation performed

- `node --check stats.js`
- `node --check script.js`
- `node --check tests/stats.test.js`
- `node --test tests/stats.test.js` — 31 tests passed.
- A temporary synthetic DOM/`requestAnimationFrame` harness (not committed) loaded the real `stats.js` and `script.js` and exercised stable, long-gap, hidden-pause, and insufficient-sample runs. All assertions passed. This is not a browser test.
- `git diff --check`
- Full diff review confirmed no CSS, canvas geometry, color, typography, layout, or 3×3 metric-grid structural changes.

### Limitations

- Tests cover arithmetic and accounting, not live browser scheduling, visibility transitions, or real display cadence.
- Hidden-pause duration is measured between `visibilitychange` dispatches with `performance.now()`. Browsers may dispatch those events slightly after the visual transition, so the reported duration is an estimate, not a hardware-timed measurement.
- At the time of Engineering Batch 1, no automated browser/visual-regression baseline was available; visual parity was checked by source diff. Later headless Edge checks are recorded above and are not a pixel-diff baseline.
- Coverage is an interval-time estimate based on animation callbacks, not a count of every physical display frame.

## Latest Update — Phase 1: Measurement hardening

### Changed

1. **Refresh stability now uses a median-based ±5% tolerance.**
   The stability figure is the share of accepted frame intervals within ±5% of the measured median interval. Previously a 1 ms floor silently widened the tolerance on high-refresh displays (roughly ±14% at 144 Hz and ±24% at 240 Hz), which inflated the reported stability. The computation now matches its existing on-screen label exactly; the label text was not changed.

2. **The rate note now reports excluded long gaps in more detail.**
   When callback intervals longer than the exclusion threshold are dropped from the cadence estimate, the existing rate note reports both the **number** of excluded gaps and the **longest** excluded gap (in milliseconds), during sampling and in the final summary. No new UI element was added and no existing label changed.

3. **Live readout and graph rendering are throttled; sampling is not.**
   Screen text updates (`currentHz`, `liveFps`, `sampleCount`) and the canvas chart are now refreshed at roughly 100 ms intervals instead of once per animation frame, reducing unnecessary per-frame DOM and drawing work. Frame **sampling remains unthrottled** — every accepted interval is still recorded — so measurement accuracy is unaffected. The final summary values are still written authoritatively when a test completes.

4. **Resilience guards added.**
   The canvas/2D-context initialization, the `ResizeObserver` attachment, and the metric-writing helper now tolerate a missing element or unavailable context instead of throwing. This is defensive hardening; it does not change behavior when everything is present.

5. **Safer min/max calculation.**
   Minimum and maximum interval values are computed with a single-pass helper rather than spreading the sample array into `Math.min`/`Math.max`. This avoids the call-stack limits those spread calls can hit on large arrays, while producing identical results.

6. **Design intentionally preserved.**
   The existing visual design, HTML structure, CSS, on-screen labels, and decorative motion animation were deliberately left unchanged. This update modifies measurement logic and text content only.

### Validation performed

- `node --check script.js` — no syntax errors.
- `git diff --check` — no whitespace or conflict issues.
- An **external, temporary test harness** (not committed) that runs the real `script.js` under a mocked DOM/`requestAnimationFrame` environment against **synthetic** frame intervals. It verified:
  - stability calculation at 60 Hz, 144 Hz, and 240 Hz (confirming the previous floor inflated high-refresh results, now corrected);
  - frame-rate and frame-time metrics against independent reference math;
  - throttled readout versus unthrottled sampling;
  - long-gap reporting (count and longest value) and correct counter reset between sessions;
  - min/max equivalence against `Math.min`/`Math.max` over randomized arrays.
- Diff inspection confirmed that only `script.js` changed in application code; `index.html`, `style.css`, `.gitignore`, and `wrangler.jsonc` are identical to the `baseline-v0` commit.

### Limitations of this validation

- The automated checks use **synthetic intervals**, not a real display or GPU pipeline. They confirm the arithmetic and state logic, not real-world cadence.
- **Manual browser verification** (visual parity, live run, tab-visibility pause/resume, window resize, reduced-motion, console cleanliness) was performed by hand and is not captured as an automated regression test.
- Cross-browser coverage is limited: only Microsoft Edge was available in the development environment.
- Visual parity is established by the absence of any HTML/CSS/label change in the diff; no pixel-diff screenshot baseline is in place yet.
- RefreshTest continues to **estimate** browser frame cadence. It does not measure or report the display's exact hardware refresh rate.

## V2 Platform Upgrade — Sessions, insights, comparison, and lab

### Added

1. **Pure measurement lifecycle module (`measurement.js`).**
   Run state (`running`, `completed`, `cancelled`), pause/resume accounting, bounded observation retention, and four explicit modes now live in one dependency-free classic script. Standard remains the 8-second default; Quick (3 s), Extended (20 s), and Diagnostics (30 s) are optional. No mode can overlap another run or inherit observations from a previous run.

2. **Deterministic insight engine (`insights.js`).**
   Rule-based findings cover insufficient samples, low/moderate/high variation, excluded long gaps, low coverage, upper-tail intervals, hidden pauses, low cadence, previous-session differences, and retention limits. Thresholds are fixed in code, evidence is shown for each finding, and the limitations state that browser timing cannot diagnose hardware or establish causation.

3. **Local session history (`storage.js`).**
   Versioned schema v1 records are stored one key per session with a separate index. Saves are explicit only. Unavailable storage, quota/index failures, duplicate ids, corrupt records, and the 50-session limit are reported without deleting unaffected sessions. Import files are size-limited, schema-validated, and merged without overwriting existing ids.

4. **Cross-session comparison (`comparison.js`).**
   Two to six sessions are compared using absolute values and descriptive deltas from the earliest selected session. Historical metrics are recomputed from stored raw intervals when available; saved summaries are a clearly labelled fallback. Mode, duration, statistics-version, threshold, sample-size, and hidden-pause differences produce explicit compatibility warnings. Missing values remain unavailable rather than becoming zero.

5. **History, Compare, and Lab views.**
   Hash navigation (`#test`, `#history`, `#compare`, `#lab`) exposes a local session list with detail/export/delete/clear actions, a comparison table and grouped median-interval chart, a test-mode selector, an accepted-interval histogram, a detailed metrics table, and diagnostic report export.

6. **New statistical outputs.**
   P50, P99, coefficient of variation, and a deterministic histogram join the existing P95/stability/coverage outputs. P99 requires 100 accepted intervals; P95 and stability keep the 30-interval gate.

7. **Export/import round-trip.**
   Individual results, selected sessions, and diagnostic reports export as JSON via Blob downloads. Imported and stored values are rendered with `textContent`; `script.js` contains no `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval`, or `new Function`.

### Changed

1. **One authoritative pipeline.**
   Every mode uses `Measurement.createRun` / `recordFrame` / `completeRun` and `Stats.computeStatistics`; the UI does not maintain a second statistics path.

2. **Safe cancellation and visibility handling.**
   The run button becomes **Cancel measurement** during a run. Cancellation stops the pending animation frame, marks the run cancelled, clears the result/insight/lab panels, and cannot save or display partial data as complete. Hidden-tab time pauses sampling and is excluded from active duration.

3. **Explicit result lifecycle.**
   Starting a new run clears the previous in-memory result. Completed runs expose Save and Export; cancelled or unstarted runs do not. Save is disabled when local storage is unavailable, with an explanatory message.

4. **Accessibility and responsive layout.**
   Views use `hidden`, `aria-current`, live status regions, labelled controls, keyboard-reachable navigation, visible focus states, and programmatic heading focus without a distracting outline. New panels, tables, mode cards, charts, and toolbars adapt at 850 px, 560 px, and 370 px. `prefers-reduced-motion` stops the decorative motion loop.

5. **Deployment exclusion.**
   `.assetsignore` now also excludes `IMPLEMENTATION_PLAN.md`; `tests/` remains excluded.

### Validation performed

- `node --check` on `stats.js`, `measurement.js`, `insights.js`, `storage.js`, `comparison.js`, and `script.js` — no syntax errors.
- `node --test` — **105 tests passed** (statistics, lifecycle, insights, storage, comparison, integration contracts, and a static DOM-id contract).
- `git diff --check` — no whitespace or conflict errors.
- Real Microsoft Edge run under `file://` through the DevTools protocol, with zero console exceptions:
  - all six modules loaded in order;
  - hash navigation to all four views;
  - Quick mode selected, run completed, and 180–181 accepted intervals reported at about 59.9 FPS;
  - insights rendered with evidence and limitations;
  - lab histogram and 20 metric rows rendered;
  - cancel stopped a run with **CANCELLED**, no result, and Save disabled;
  - first and second sessions saved to `localStorage`; history count, detail table, and comparison table/chart rendered;
  - selected-session export and diagnostic report download produced JSON files;
  - a valid import added one session; an invalid import was rejected with the existing history intact;
  - reload preserved three sessions under `file://`;
  - mobile layout at 390 px had no horizontal overflow and no heading focus outline.
- Screenshots were captured for desktop Test/Compare/History/Lab/Insights and mobile Test/Insights.

### Limitations

- Browser animation-callback cadence is still not a direct panel measurement. Insights and comparisons are descriptive and do not establish causation or hardware faults.
- Real-browser verification used Microsoft Edge only; Firefox and Safari were not available.
- `file://` localStorage behavior is browser-dependent. It worked in the tested Edge profile, but some browsers may block or isolate storage for local files; the UI degrades to export-only.
- Wrangler CLI validation could not be run: the npm/npx PowerShell shims are blocked by execution policy and no Wrangler install is available. `.assetsignore` was inspected instead.
- No automated pixel-diff/visual-regression baseline is in place; layout was checked with live screenshots at desktop and mobile widths.
- The stylesheet's Google Fonts `@import` remains the only external request and is non-essential; all measurement, storage, comparison, and insight functionality works without it.
- No commit, push, or deployment was performed.

## Post-implementation fixes - 2026-10-21

### Fixed

1. **Measurement lifecycle on navigation.**
   Leaving the Test view during an active run now cancels that run before the view changes. The cancellation reports why it happened, clears the partial result, and leaves Save/Export disabled. Animation-frame callbacks are guarded by a per-run token, including across hidden-tab pauses, so a stale callback cannot record into a later run or schedule a second loop. The comparison resize timer is cleared on navigation.

2. **Previous-session compatibility.**
   A new result is compared with the newest saved session only when both have the same measurement mode, active durations within 20%, the same statistics version, and at least 30 accepted intervals. Otherwise the insight panel explains each reason the comparison is unavailable instead of presenting unrelated runs as a change.

3. **Stability and coefficient of variation.**
   The two spread measures are mapped to common LOW/MODERATE/HIGH bands and the more cautious band is used. When they disagree, the finding explains that coefficient of variation reflects overall spread (including outliers) while stability counts intervals within ±5% of the median. This prevents a low-CV sample with a variable stability result from being called consistent. Boundary and outlier-heavy tests were added.

4. **Stable session identity.**
   A measurement now caches one session record for its lifetime. Save, export, and re-export reuse the same id, so the same measurement is not duplicated by history or import. Re-importing its exported JSON is rejected as a duplicate. Saving an export-only result re-stamps `savedAt` when it is committed to history, and later exports keep that saved timestamp.

5. **Consistent export/import limits.**
   Export and import share a 32 MB `MAX_TRANSFER_BYTES` limit (`MAX_IMPORT_BYTES` and `MAX_EXPORT_BYTES` are aliases). Export computes the actual serialized size and returns `EXPORT_TOO_LARGE` with the actual and allowed sizes rather than truncating data. Import reports the file size and limit explicitly. A test verifies an export produced by the app can be imported again, and that both directions reject oversized input.

6. **Corrupt history records.**
   Unreadable stored records are copied to a `refreshtest.corrupt.v1.<id>` quarantine key and removed from the active index, so they no longer occupy one of the 50 history slots. If quarantine cannot be written, the original is left in place. Clear-all removes quarantine keys too.

7. **Smaller correctness fixes.**
   The unreachable summary-only comparison fallback and the misleading `threshold-mismatch` warning were removed; sessions without raw intervals now report unavailable metrics and a `missing-raw-intervals` warning. Import strips a UTF-8 BOM, FileReader is explicitly UTF-8, timestamps remain canonical UTC, and `.assetsignore` now also keeps `CHANGELOG.md`, `wrangler.jsonc`, `.assetsignore`, `.git/`, and `.gitignore` out of the static asset set.

8. **Small-text readability.**
   Secondary explanatory text, percentile notes, session metadata, comparison/lab copy, and table notes were increased by roughly one pixel where space allows, with slightly lighter neutral colors. Mobile navigation and table sizes retain the existing breakpoints; no layout, palette, or component structure was changed.

### Validation performed

- `node --check` on all six application scripts - no syntax errors.
- `node --test` - **112 tests passed**, including new compatibility, variation reconciliation, corrupt-quarantine, shared-size, BOM, timestamp/identity, and hidden-pause completion tests.
- `git diff --check` - no whitespace or conflict errors (Git only reports its LF-to-CRLF working-copy notice for `script.js`).
- Real Microsoft Edge 155 `file://` run through the DevTools protocol with zero console exceptions or warnings:
  - Standard mode completed with 480 accepted intervals over 8.0 s active time (median 16.70 ms, 59.9 FPS);
  - export before save, save, and re-export reused the same id; saving re-stamped `savedAt`, and the subsequent export matched the stored record;
  - re-importing that export added zero sessions and reported a duplicate/skip;
  - a Quick run after a saved Standard run showed the compatibility finding naming both the mode and duration mismatch;
  - comparing the two saved sessions showed mode/duration warnings and no `threshold-mismatch` warning;
  - cancelling during navigation produced **CANCELLED**, no result, Save/Export disabled, and no new history entry after the would-be run window;
  - a deliberately corrupt record was quarantined and removed from active history after reload while valid sessions remained;
  - keyboard focus on the History link plus Enter navigated to `#history`;
  - desktop and 390 px screenshots showed no horizontal overflow.
- `.assetsignore` behavior was checked against Cloudflare Workers static-assets documentation: the file is read from the root of the configured assets directory and uses `.gitignore` syntax. Wrangler CLI validation was not possible because no Wrangler install/npm shim was available; no deployment was attempted.

### Remaining limitations

- Browser callback cadence is still not a physical panel refresh-rate or pixel-response measurement.
- Browser verification used headless Microsoft Edge only; Firefox and Safari were not available.
- The 50-session/32 MB limits are explicit product limits; an export that exceeds 32 MB is refused with instructions to export smaller groups rather than truncated.
- `file://` localStorage behavior remains browser-dependent.
- No committed browser-automation harness or pixel-diff baseline was added; the browser checks were performed with a temporary harness outside the repository.
