# v1.0.25 — Offline Finalization Recovery Validation

**Build:** 1.0.25  
**Base:** v1.0.24 Editorial Calibration  
**Live Chrome/Gemini run:** Not performed in this build environment.

## Why this build exists

The supplied v1.0.24 field run completed incremental generation and received a final-render response, but its own validator rejected the candidate because it had four topic headings while a time-derived heuristic required seven. The extension retained the chronological incremental draft, so the editorial refinement and semantic audit never ran.

## Focused changes

1. **Heading count is now advisory.** The source-window-derived estimate still helps identify possible over-merging, but is no longer a hard validator floor. A valid note is not rejected solely because it has fewer topic headings than a time-based heuristic predicts.
2. **One structural recovery pass.** The first render is checked for timestamp-led headings, missing nested hierarchy, missing selective bracketed callouts, excessive callouts, and lower-than-preferred heading count. When needed, one editorial recovery request receives the full source evidence and candidate note. It is instructed to split only genuinely distinct topics, remove timestamp headings, restore nested structure/callouts where useful, and retain all source-supported information.
3. **Strict acceptance remains.** The recovery candidate must pass length, Markdown-fence, heading-floor, timestamp-heading, nested-bullet, callout and hyphen-bullet checks. It must clear hard style defects. If the note was below the soft heading preference, recovery must increase the number of concept headings or meet the preference. The existing second-pass source-to-note audit then checks the accepted candidate and can perform one targeted semantic repair followed by re-audit.
4. **Fail-closed behavior remains.** If a candidate has hard editorial defects and the single recovery request fails or does not fix them, the final candidate is rejected and the incremental draft is retained. A coherent candidate with only a soft heading-count warning may continue to source audit if the refinement does not materially improve it.
5. **Terminal Markdown fence fix.** A model-added outer Markdown wrapper is removed only when the entire response is enclosed in that wrapper. A valid Mermaid/code block at the end of a note is preserved.
6. **No capture/storage changes.** YouTube capture, caption relay, screenshot collection/restoration, API-key slots, extension permissions, storage schema, and vault folder access were not changed.

## Targeted regression: v1.0.24 failure reproduction

`tests/phase1-structural-recovery.test.cjs` simulates a 10-minute transcript with:

- A first final-render candidate containing four timestamp-led topic headings.
- A soft source-length heuristic of seven headings.
- One structural recovery response that creates five descriptive topic headings, nested bullets, a selective bracketed callout and a source-supported Mermaid diagram.
- A successful second-pass source-to-note audit.

Assertions confirm that the recovery request runs once, the recovered note is applied, timestamp-led headings are absent, and `final-render-complete` reports both structural and semantic validation passed. This is a mocked orchestration test; it does not predict exactly what Gemini will write in a live run.

## Automated verification

- Node regression scripts: **22/22 passed**.
- JavaScript syntax checks: **12/12 passed** (application source under `background/`, `content/`, and `sidebar/`).
- Fixed human-authored 00:00–08:00 benchmark: **13/13 content signal groups and 9/9 style checks**. This is a regex/structure screening fixture, not a live model output or semantic proof.
- Manifest version, `VERSION.txt`, and visible sidebar label: **1.0.25**.
- Extension permissions unchanged: `storage`, `activeTab`, `scripting`, `tabs`.
- ZIP integrity and root manifest verified.
- No embedded API-key-like secrets found in packaged source.

## What this proves—and what it does not

This build specifically fixes the code-side rejection condition observed in the latest v1.0.24 run and verifies that timestamp-heading recovery can continue into semantic audit. It does **not** prove that Gemini will always generate perfect topic organization, a Mermaid diagram whenever helpful, exhaustive notes, or 100% visual/structural parity with HoverNotes. One controlled live Chrome/Gemini acceptance run is still necessary.
