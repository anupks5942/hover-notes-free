# My HoverNotes — v1.0.29

Build: 1.0.29

## v1.0.29 — Final request-correlation correction & lifecycle cleanup

v1.0.29 resolves subtle request correlation and lifecycle cleanup defects identified in production audits:
- **Removal of uncorrelated response fallback:** Removed legacy single-waiter fallback in `deliverCaptionBody()`. Every response must carry a non-empty `requestId` matching an active waiter. Mismatched or unrequested responses are strictly rejected.
- **Strict MAIN-world request context matching:** Exact `vssId` matching is required whenever present in the URL or context, never falling back to kind or language on mismatch. Language fallback is permitted only when no track identity is in the URL and exactly one candidate exists. Conflicting responses are dropped in `captureTimedText()` before reaching the isolated script.
- **Explicit cancellation & lifecycle cleanup:** Waiter timeouts issue `CANCEL_CAPTION_REQUEST` to the MAIN world, immediately deleting active request contexts. Video navigations clear active contexts in both worlds. Late responses from cancelled requests are dropped.
- **Concurrent chunk-transfer isolation:** Removed blanket transfer wiping on `CAPTION_BODY_START`. Transfers are isolated by `transferId` with bounded concurrent transfers (`MAX_ACTIVE_TRANSFERS = 4`), preventing interleaved streams from corrupting each other.
- **Deterministic track selection & policy realism:** Preserved explicit `vssId` and `kind` across retrieval and activation. Documented that the hypothesis of auto-generated `a.hi` being the intended track on `2o2vX0ZqQ_Y` remains unverified live evidence because live tracklists were not logged at failure time.

## v1.0.28 — YouTube caption ingestion lifecycle & track selection repair

v1.0.28 eliminates stale and uncorrelated YouTube caption ingestion failures by:
- Implementing request-correlated timed-text retrieval with unique `requestId` tracking through player bridge initiation, response snapshotting, chunk transfer, and waiter resolution. Older or uncorrelated responses can never resolve a newer pending request.
- Enforcing exact `vssId` matching first (e.g., distinguishing auto-generated Hindi `a.hi` from manual Hindi `.hi`), failing closed if an explicit `vssId` is requested but missing.
- Removing unvalidated raw-response caching and replay in both the MAIN world and isolated content scripts; only validated timestamped cues enter `transcriptCache`, strictly isolated by `${videoId}::${trackKey}`.
- Adding bounded fresh recovery: exactly one controlled fresh retry on 0-cue failure with a new `requestId`, forced player track reactivation, and zero progress advance if retry also produces 0 cues.
- Adding full-pass $O(N)$ JSON3 census diagnostics calculating non-whitespace character volume, segment text field frequencies (`utf8`, `utf16`, `text`), text length percentiles, and timestamp validity without logging caption text or secrets.

## v1.0.27 — YouTube JSON3 event schema census diagnostics

v1.0.27 adds in-memory, privacy-safe structural event schema census diagnostics to inspect unsupported YouTube caption JSON responses when parsing produces zero cues. It analyzes the full `events` collection for key frequencies, segment-like fields, and distinct key signatures, and performs bounded nested sampling to uncover property paths, string leaf lengths, and timestamp-like numeric value ranges without guessing or modifying units. Traversal-node budget limits ensure the YouTube page cannot freeze, and strict redaction guarantees no caption text or credentials are ever logged.

## v1.0.26 — YouTube caption ingestion repair

v1.0.26 resolves YouTube caption-parsing failures by replacing ad-hoc retries with a format-aware dispatcher supporting JSON3, SRV3 XML, legacy XML, and WebVTT. It preserves the `fmt` request metadata across the MAIN-world bridge, distinguishes an absent `fmt` parameter from explicitly supplied formats, correctly dispatches `application/json` responses with absent `fmt` to JSON adapters without forcing XML parsing, isolates multi-format cache entries by format, and outputs privacy-safe schema diagnostics when an unsupported JSON schema is encountered.

## v1.0.25 — Finalization recovery

v1.0.25 addresses the live v1.0.24 failure in which the final renderer returned four topic sections but the validator demanded seven based on the capture duration. That estimate is now advisory, not a hard pass/fail condition. The extension validates basic document integrity first, then performs at most one conditional structure-recovery request when the candidate has timestamp-led headings, lacks reference-style nesting/callouts, has excessive callouts, or appears to have merged distinct topics. A recovered note must pass strict structural validation before the existing source-to-note semantic audit can accept it. If a hard defect remains, the incremental draft is retained.

The Markdown validator also distinguishes an outer model-added Markdown wrapper from a legitimate code or Mermaid block at the end of a note, so it no longer strips a real closing fence.

Offline regression includes a mocked reproduction of the four-heading v1.0.24 failure and verifies recovery plus semantic audit. This does not guarantee live Gemini editorial quality or 100% parity with the supplied HoverNotes export; one controlled Chrome run is still required.

## v1.0.24 — Editorial calibration and semantic coverage audit

After the final topic-based document is rendered from the original transcript evidence, the extension performs a separate second-pass source-to-note review using the configured AI provider. The reviewer compares bounded original transcript batches with the entire candidate document, identifies material omissions and claims directly contradicted by the batch, and can request one targeted repair. The repaired document is reviewed again. If material omissions remain, the extension retains the incremental draft instead of applying a document that failed the semantic gate.

This second pass uses the same configured model/provider pipeline; it is a separate review request, not an independent third-party judge or a guarantee of completeness. Automated tests mock model responses. Live Gemini output quality and full HoverNotes parity remain unverified.

The renderer also consolidates repeated concepts, uses nested bullets for supporting explanations, limits bracketed callouts to selective use (normally one or two per main topic section), and conditionally runs one editorial refinement pass when measured callout density is excessive. The refined version is retained only when it passes structural validation and reduces callout count; the source-to-note semantic audit then checks it for content loss. A duplicate body H1 is removed only when it matches the YAML title, including the metadata-only ` - YouTube` suffix. Distinct H1 content and frontmatter are preserved.

A fixed 00:00–08:00 benchmark, human-authored gold note, deterministic regex/style evaluator and measured reference profile are included under `benchmarks/` and `PHASE1.1-SEMANTIC-COVERAGE-REPORT.md`. The regex evaluator is a regression screen, not a semantic proof.

## v1.0.22 — Deterministic source-window provenance

The live note remains an incremental, recoverable draft. When you click Stop, the extension retrieves the original YouTube caption transcript from 00:00 through the frozen stop position and generates the final study document from that source—not from the already-compressed AI draft.

**Evidence extraction is required for every capture length.** The transcript is divided at intact 30-second boundaries into bounded packets. The extension maps each non-empty time window to its packet using JavaScript-owned metadata. Gemini is not asked to echo hidden `HN_TIME_*` or `HN_SOURCE_*` identifiers. That brittle contract caused v1.0.21 to abort after otherwise successful model calls when a marker was omitted. Source-window metadata is carried through consolidation by the extension, independently of generated prose.

The final renderer uses an editorial contract derived from the supplied `hovernotes.io.md` export: concept-oriented headings, nested hyphen bullets, bold bracketed labels, supported display equations, useful Mermaid diagrams, comparison tables, and occasional blockquotes. It rejects timestamp-led headings, insufficient topic structure, missing nested explanations, and output that is too short. It does not require synthetic source markers in the Markdown.

Original screenshot frames associated with a source packet can be attached to the evidence-extraction request when their image data remains in the current run cache. The extension independently preserves and restores screenshot timestamp links and Obsidian image embeds. The model is asked to capture only slide information that is visibly legible; this does not guarantee OCR-quality extraction from every frame.

YouTube description metadata and earlier AI-generated draft notes are excluded from the final factual prompt. The original YAML frontmatter and extension-managed screenshot embeds remain preserved. Instructor claims are retained only when supported by the transcript or visible source material and should be attributed as claims.

The extension continues using the existing Gemini keys, model/fallback configuration, Chrome storage, and Obsidian folder permission. No uninstall/reinstall or storage reset is required for an in-place update.

## Requirements

- Google Chrome 111 or later.
- A configured Gemini API key (or configured OpenAI-compatible endpoint).
- A writable local Obsidian vault folder connected through the extension.

## What this build supports

- YouTube pages with accessible player caption tracks; format-aware parsing for JSON3, SRV3 XML, legacy XML, and WebVTT caption responses with privacy-safe diagnostics for unsupported schemas.
- Translation of Hindi/Hinglish captions into structured English Markdown notes.
- Transcript-grounded generation with timestamps, instructor-claim attribution, prior-note context, and streaming output.
- Automatic locally filtered screenshots, promotional-interval suppression and perceptual duplicate suppression. Screenshot selection is heuristic, not full semantic vision or OCR.
- Obsidian wiki-link image embeds saved under `HoverNotes/images/`.
- Local Markdown note saving under `HoverNotes/`.
- Gemini streaming, configured key rotation, first-token timeout and fallback model behaviour.
- Progress checkpoints, fresh-run confirmation, graceful Stop/final flush, and cancellation on video navigation.

## Current limitations

- The extension does not directly transcribe video audio. It depends on captions exposed by YouTube.
- Automatic screenshot selection is heuristic. It cannot guarantee that every selected frame is educational, unobstructed, or fully readable.
- The source-window sidecar proves that each transcript window is assigned to an evidence packet and tracked through reduction. The v1.0.25 second-pass audit checks the rendered note against the original transcript and can request one repair, but it uses the same configured model/provider pipeline and is not a mathematical proof of semantic completeness. The final Markdown still needs quality review.
- The extension is a Phase 1 prototype; full HoverNotes parity and non-YouTube support are not claimed.

## Testing

Run each test in `tests/*.test.cjs` with Node.js. The regression suite checks caption parsing and large-body chunk reassembly, Gemini fallback, screenshot filtering/deduplication, note normalization, Stop/performance instrumentation, deterministic source-window mapping, marker-free extraction, map/reduce metadata continuity, source-to-note second-pass review, targeted repair, fail-closed verification and reference-benchmark behavior. Browser integration and real Gemini note quality are not covered by mocked tests.

For offline developer checks, see `PHASE1-TEST-PLAN.md`. The benchmark methodology and limitations are documented in `PHASE1.1-SEMANTIC-COVERAGE-REPORT.md`.

## Synthesis limits

- The extension depends on caption tracks exposed by YouTube; it does not transcribe audio itself.
- Evidence chunks are bounded at approximately 9,000 characters without splitting a 30-second source window. Evidence-ledger consolidation is bounded at 36,000 characters and five levels. Each model request is capped at 8,192 output tokens.
- Provider quotas, transient model availability, context limits and model quality can still prevent a complete final document. If retrieval, extraction, consolidation, validation or saving fails, the extension retains the incremental draft.
- Evidence extraction and the second-pass audit can each inspect up to four cached screenshot frames for a request or packet. It does not guarantee OCR-quality extraction from every frame; screenshot embeds remain preserved even when slide text is unreadable or a frame is unavailable.
- These limits do not guarantee one polished Markdown document for an unrestricted 12-hour lecture. Very long-course chapter splitting and resumable multi-document synthesis remain future work.
- Automated tests verify wiring, chunk integrity, source-window sidecar coverage and output structure. They cannot prove semantic completeness or live Gemini quality. The final Markdown must be evaluated against the matching source interval in `hovernotes.io.md`.
