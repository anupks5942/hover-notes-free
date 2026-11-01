# Changelog

## v1.0.25 — finalization recovery and Markdown fence safety

- Removed the time-derived topic-heading minimum as a hard acceptance gate. The source-window estimate is now a soft editorial signal; a coherent note is not rejected solely for having fewer sections than a timestamp-based heuristic predicts.
- Added one conditional structural-recovery/editorial request for hard style defects, including timestamp-led headings, missing nested hierarchy, missing selective bracketed callouts, and excessive callout density. The recovery prompt also checks whether distinct topics were over-merged, without imposing a heading quota.
- A repaired candidate is applied only if it passes strict document validation, clears all hard style defects, and improves any soft low-heading signal. If the initial candidate contains hard defects and the recovery fails, finalization fails closed and retains the incremental draft.
- Applied the same small structural heading floor to semantic repair; the heuristic topic count can no longer reject a successful semantic repair.
- Fixed Markdown wrapper handling: remove an outer model-added Markdown fence only when the entire response is wrapped. A legitimate code/Mermaid fence at the end of the note is preserved.
- Added a mocked integration regression reproducing the v1.0.24 failure shape (four timestamp-led headings versus a heuristic of seven) and proving recovery, strict validation, and source-to-note audit can complete.
- Capture, captions, screenshots, storage schema, API-key configuration, extension permissions, and vault access were not changed.
- Offline validation only. Live Gemini output quality and exact HoverNotes parity still require one controlled Chrome acceptance run.

## v1.0.24 — editorial calibration and title cleanup

- Tightened the subject-agnostic final-rendering contract: merge overlapping concept sections, keep explanations/examples nested under their parent concept, and use bracketed bold labels selectively rather than as a prefix for ordinary bullets.
- Added a measured callout-density check and one conditional editorial refinement pass when labels are overused. The refined candidate is accepted only when it reduces callout count and passes structural validation; the existing source-to-note semantic audit then checks for content loss. If the refinement fails or does not improve the metric, the initial final render is retained.
- Clarified when a Mermaid mindmap/flowchart is useful, including several source-stated parallel examples illustrating one concept. Diagrams must remain grounded in the transcript and must not add examples or categories.
- Remove a body H1 only when it exactly duplicates the YAML `title`; preserve distinct H1 content and the rest of the frontmatter.
- Keep screenshot restoration, transcript-boundary handling, Gemini fallback, API-key storage, vault permissions, and the semantic coverage/repair pipeline unchanged.
- Added regression tests for duplicate-title cleanup, preservation of distinct headings, callout-density detection, and style-refinement/semantic-audit wiring.
- Validation is offline and mocked. A live Gemini run is still required to verify the model's actual editorial output; this build does not claim exact HoverNotes parity before that test.

## v1.0.23 — semantic coverage audit and reference benchmark

- Added a separate second-pass source-to-note audit after final rendering. It compares every bounded original-transcript batch with the entire candidate note and reports material omissions or directly contradicted claims.
- Added one targeted repair pass and a mandatory post-repair audit. If omissions remain, the candidate is rejected and the incremental draft is retained.
- Kept source-window identity in JavaScript-owned metadata; the model does not need to reproduce hidden IDs.
- Prevented false unsupported-claim findings based solely on absence from an individual transcript batch; a claim may be supported elsewhere in the lecture.
- Replaced misleading DSA-specific style examples with a subject-neutral reference-style profile.
- Added a fixed user-source benchmark for the KG DSA lecture from 00:00 to 08:00, a curated gold-note fixture, a deterministic content/style screening evaluator, and a fail-closed semantic-audit regression test.
- Corrected the measured `hovernotes.io.md` profile. The benchmark explicitly separates style checks from content-signal checks and labels its regex checks as heuristics.
- Validation is offline/mocked. Live Gemini output quality and exact HoverNotes parity remain unverified.

# Changelog

## v1.0.22 — deterministic source-window provenance

- Fix the v1.0.21 synthesis blocker: the final evidence-extraction pipeline no longer asks Gemini to reproduce `[[HN_SOURCE_*]]` or `[[HN_TIME_*]]` tokens exactly. The v1.0.21 field log showed six successful/returned attempts for the first source chunk followed by an abort because `[[HN_TIME_0001]]` was absent from generated packet text; final editorial rendering never started.
- Move source-window identity and packet association into a JavaScript-owned sidecar. Each transcript cue is assigned to one 30-second window, each window is assigned to one packet, and sidecar associations are merged deterministically during hierarchical reduction.
- Evidence-extraction and consolidation prompts now receive plain timestamp ranges/cue counts. They ask for comprehensive evidence, not hidden token copying. Final rendering receives the complete range map and is not required to echo synthetic IDs.
- Add a regression smoke test where both evidence extraction and final rendering return valid Markdown without any internal markers; this must still reach final validation and saving.
- Retain the reference-style editorial contract, screenshot restoration, frontmatter preservation, user-edit protection, rollback, Gemini fallback and existing Chrome/Obsidian storage.
- Tighten the minimum final-document length check to a modest source-relative floor; semantic completeness remains a model-quality question, not something a character threshold alone can prove.
- Automated tests are local only. Live Gemini output quality and full HoverNotes parity remain unverified until a real Chrome run produces a topic-organized document.

## v1.0.21 — reference-calibrated evidence-first synthesis

- Made evidence extraction mandatory for every capture length; removed the direct-render bypass for short transcript runs.
- Divided source cues into bounded chunks while preserving 30-second window boundaries.
- Added an explicit editorial contract derived from the supplied `hovernotes.io.md` export: topic headings, nested hyphen bullets, bold bracketed labels, supported equations, useful Mermaid diagrams, comparison tables and occasional blockquotes.
- Attached up to four original cached screenshot frames to matching extraction requests when available.
- Added validation for topic structure, nested bullets, labeled callouts and Markdown fences.
- Field test did not reach final rendering: model output omitted a mandatory hidden time marker, causing evidence extraction to abort. This was a design flaw corrected in v1.0.22.

## v1.0.20 — deterministic screenshot restoration

- Made screenshot placement markers optional in model output; the extension restores managed timestamp links and image embeds independently.

## v1.0.19 — source-grounded topic synthesis pipeline

- Retrieved the original caption transcript from 00:00 through the frozen Stop boundary as the primary factual source.
- Added source-grounded evidence extraction, hierarchical consolidation and topic-based final rendering.

## v1.0.18 — Stop-boundary flush scope fix

- Fixed a `ReferenceError` during final interval flushing by keeping frame timestamp checks inside their declaration scope.

## v1.0.17 — topic-based final study-note synthesis

- Added final note synthesis after Stop, preserving incremental drafts and user edits.

## v1.0.16 — frame-helper fallback injection and non-fatal capture

- Fixed dynamic fallback injection order and made screenshot capture failure non-fatal to text generation.
