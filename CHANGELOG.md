# Changelog

All notable changes to **RefreshTest** are documented in this file.

RefreshTest is a browser tool that **estimates** display refresh cadence from `requestAnimationFrame` (animation callback) timing. It does not read a panel's physical hardware refresh rate, and it cannot measure pixel response time. This changelog records engineering changes to the measurement logic and UI behavior only.

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
