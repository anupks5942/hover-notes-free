# v1.0.24 — Offline Validation Report

**Build:** 1.0.24  
**Purpose:** Focused editorial calibration based on the live v1.0.23 comparison.  
**Live Gemini/Chrome test:** Not performed in this build environment.

## Changes

- Final-render instructions now consolidate overlapping concept sections, keep explanations and examples nested under their parent concepts, discourage repeated statements, and use selective bracketed callouts.
- A deterministic callout-density check allows about two labels per main topic heading, calibrated to the human-authored 00:00–08:00 benchmark. Notes above that ceiling receive one optional editorial-refinement request.
- A refined result is applied only if it passes structural validation, lowers the number of callouts, and falls within the callout-density ceiling. The source-to-note semantic audit then reviews that candidate. If refinement fails or does not improve the metric, the original final render is retained.
- Mermaid guidance now explicitly covers several parallel source-stated examples that illustrate one abstract concept; no unsourced examples or relationships are permitted.
- A body H1 is removed only when it matches the YAML title, including the common metadata-only ` - YouTube` suffix. A distinct H1 is retained.
- Capture, caption relay, screenshot restoration, API-key handling, extension permissions, storage schema and vault access flows were not changed.

## Automated verification

- Node regression scripts passed: **21/21**.
- JavaScript syntax checks passed for all **12** JavaScript files under `background/`, `content/`, and `sidebar/`.
- Manifest/version/UI version consistency passed: **1.0.24**.
- Chrome permissions remain exactly `storage`, `activeTab`, `scripting`, and `tabs`; no permission was added.
- Secret-pattern scan found no embedded API-key-like values in the packaged application source.

## Fixed benchmark result

The human-authored 00:00–08:00 benchmark fixture returned:

| Measure | Result |
|---|---:|
| Content signal groups | 13/13 (100%) |
| Style checks | 9/9 (100%) |
| Words | 870 |
| Evaluator result | Pass |

This is a regression screen of a human-authored fixture based on the supplied transcript. It is **not** a live AI output and is not proof that Gemini will produce identical notes.

## Live verification still required

The build cannot call the user's Gemini key or control their Chrome session. Therefore this report does **not** claim that the live model will always create the desired mindmap, merge all overlapping topics, or stay below the callout ceiling. The code path is covered by mocked regression tests, but actual Gemini editorial quality must be confirmed with one controlled run. A passing API/pipeline status alone is not a style-parity pass.
