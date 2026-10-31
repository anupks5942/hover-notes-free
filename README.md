# HoverNotes Clone — Phase 1.0.14

Build: 1.0.14

## v1.0.14 — Timestamped screenshots interleaved inside topic sections

v1.0.14 fixes the chronology defect observed in the v1.0.13 live Markdown. Previously, a screenshot was represented as a peer `### [timestamp]` heading, so the section sorter placed it after the entire parent topic—even when its timestamp belonged between timestamped teaching bullets inside that topic.

The normalizer now extracts extension-managed screenshot heading/embed pairs before sorting, orders timestamped instructional bullet blocks within each topic section, and reinserts each screenshot as an inline timestamp link plus Obsidian embed immediately after the matching timestamped teaching point. If a timestamped observation was incorrectly nested below later bullet items, the normalizer restores its chronological position and list level. Legacy screenshot heading/embed pairs are migrated during normalization, and previous-note sanitization removes both old and new screenshot-anchor formats.

The change preserves the existing screenshot-selection pipeline, promotional filter, perceptual duplicate suppression, 30-second Gemini first-token timeout/fallback, Stop handling, and YouTube large-caption bridge. It does not change the AI model, prompt, caption extraction, screenshot scoring, or segment size.

Automated regression coverage uses the exact observed structure: a `[01:38]` DSA topic section, a nested `[01:41]` visual observation and screenshot, followed by `[02:04]` and `[02:19]` teaching bullets and a later `[02:40]` section. Tests verify that bullets, image anchor, image embed, and later section are ordered correctly, and that a second normalization pass does not duplicate the screenshot.

Automated tests cannot prove every model-generated document will have this exact structure. The next live four-minute Chrome test must verify in-section placement in the actual Obsidian note.

## v1.0.13 — Markdown block integrity and instructional coverage

v1.0.13 repaired concatenated Markdown block boundaries and strengthened instructions to retain conceptual motivation, subject importance, learning objectives, instructor reasoning, analogies, and distinctions between memorization and understanding. These were prompt and normalization improvements, not a deterministic guarantee against omissions.

## v1.0.12 — Obstruction-aware frame ranking and chronological note cleanup

v1.0.12 preserved the v1.0.11 promotional gate and perceptual deduplication, added a local foreground-obstruction scoring proxy, inserted screenshots at timestamps, removed exact duplicate embeds and repeated canonical definitions, and repaired a known malformed timestamp shape. The obstruction proxy is not OCR, face detection, or semantic image understanding.

## v1.0.11 — Transcript-aware screenshot filtering and deduplication

v1.0.11 added transcript-based promotional-frame suppression and perceptual duplicate-frame detection while preserving Gemini fallback, caption retrieval, Stop handling and existing generation settings.

## v1.0.10 — Bounded Gemini first-token wait and study-frame sampling

v1.0.10 added a 30-second first-text-token timeout with model fallback and passive frame sampling. The local visual heuristic was subsequently refined by transcript promotion filtering and perceptual deduplication.

## Requirements

- Google Chrome 111 or later.
- A configured Gemini API key (or configured OpenAI-compatible endpoint).
- A writable local Obsidian vault folder connected through the extension.

## What this build supports

- YouTube pages with accessible player caption tracks; JSON3 and supported srv3 XML caption responses.
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
- Model output still requires comparison against the supplied transcript for high-stakes study use.
- The extension is a Phase 1 prototype; full HoverNotes parity and non-YouTube support are not claimed.

## Testing

Run each test in `tests/*.test.cjs` with Node.js. The regression suite checks caption parsing and large-body chunk reassembly, Gemini fallback, screenshot filtering/deduplication, note normalization and Stop/performance instrumentation. Browser integration and model-quality behaviour still require a live Chrome smoke test.

For the current acceptance procedure, see `PHASE1-TEST-PLAN.md`.
