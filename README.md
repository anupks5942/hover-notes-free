# HoverNotes Clone — Phase 1.0.11

Build: 1.0.11

A personal Chrome Manifest V3 prototype for creating transcript-grounded YouTube lecture notes and saving them to a local Obsidian vault.

## Requirements

- Google Chrome 111 or later (the caption observer is a static MAIN-world content script).

## 1.0.11 transcript-aware screenshot gating and note organization

v1.0.11 retains the v1.0.10 Gemini first-token timeout/fallback behavior and adds targeted fixes based on the supplied v1.0.10 live run.

**Promotional-frame suppression:** automatic screenshot selection now happens after transcript extraction. A conservative Hindi/English classifier suppresses screenshots when the interval contains several promotional signals and no instructional signals. This specifically targets course introductions, channel promotions, subscriptions, and similar material. It does not suppress transcript-based note generation.

**Slide deduplication:** visually qualified frames receive a whole-frame 64-bit difference hash plus four regional hashes. Exact/near matches use whole-frame Hamming distance ≤10; a motion-aware fallback tolerates presenter movement when the whole-frame distance is ≤25 and two adjacent regions match within distance 21. The extension avoids saving a near-duplicate of a screenshot already saved in the current AI Notes run, and it avoids choosing duplicate candidates within one interval. The frame is recorded as used only after successful screenshot persistence.

**Managed image and note cleanup:** screenshot headings and Obsidian image embeds are removed from previous-note context before it is sent to Gemini. Generated text is also sanitized for extension-managed screenshot references before persistence. This addresses the repeated screenshot embeds seen at 02:38 and 03:38 in the supplied v1.0.10 Markdown.

**Chronology guidance:** the model receives the selected frame's timestamp and is instructed to keep transcript-derived concepts in ascending timestamp order, place frame-only observations at the frame's actual timestamp, and avoid repeating definitions already covered in earlier segments. These are prompt constraints, not a formal guarantee that every model response will obey them.

The screenshot logic is deliberately limited: **there is no OCR or semantic image understanding in v1.0.11**. It combines a transcript-based promotional-intro gate, local visual-detail scoring, and perceptual duplicate detection. It cannot guarantee that every selected image is educationally relevant or that all slide text is legible.

The 30-second Gemini first-token timeout, sticky session fallback, model-specific request settings, caption observer/chunk relay, Stop boundary, and 300-second segment size are unchanged from v1.0.10. The new logic passed local regression tests but requires a live Chrome smoke test before a longer benchmark.

## 1.0.10 bounded Gemini first-token wait and initial study-frame sampler

v1.0.10 introduced a 30-second first-text-token timeout. The timeout ends when the first non-empty text delta arrives; it does not cap a healthy response stream. Timed-out primary attempts fall through to the configured fallback model. Once a fallback succeeds, it becomes preferred for the rest of the extension session to avoid repeating the same wait on each interval. Parent cancellation does not trigger fallback.

It also introduced a passive frame sampler that checks a 320×180 frame every 2.5 seconds while AI Notes is active, without seeking or pausing playback. A local edge-density heuristic retained the best visually detailed frame per minute. That original heuristic was not OCR or semantic recognition and was responsible for some visually busy but unhelpful screenshots; v1.0.11 adds the transcript promotion gate and perceptual deduplication described above.

The note-generation instructions attribute instructor promises, guarantees, opinions, and personal claims rather than presenting them as independently verified facts.

## 1.0.9 performance diagnostics and Stop finalization

v1.0.9 added timing instrumentation without claiming that AI generation had become faster. The user's subsequent live run showed that the first Gemini request took 296.3 seconds to return its first token, while caption parsing took 468 ms and screenshot capture took 31 ms. A later segment encountered HTTP 429, HTTP 503, then a fallback-model HTTP 400 compatibility retry before succeeding. These measurements motivated the bounded first-token wait and model-specific request configuration in v1.0.11.

The extension reports caption cache hit/miss, track discovery, player response wait, JSON3/XML parsing, cue counts, interval filtering, Gemini attempts and key slots, HTTP status, first-token and stream timing, screenshot/persistence, preview rendering, note save and total run durations.

The Stop UI displays `Finishing…` with a persistent spinner until the final interval and save complete. The final transcript flush is bounded by the player position captured at Stop. Streamed Markdown preview updates are batched to 150 ms.

## 1.0.8 large-caption response handling

YouTube returned a valid 13,969,317-character JSON3 caption response for the supplied Hindi lecture. v1.0.7 observed that response but discarded its body because the MAIN-world bridge had a 3 MiB transfer limit. v1.0.8 transfers large responses in numbered chunks, reassembles them in the isolated content script, checks the final character count, and then passes the full body to the JSON3 parser. The maximum accepted response is 40 MiB.

## What this build currently supports

- YouTube pages and accessible YouTube caption tracks, using a static MAIN-world observer to capture the player-issued timed-text response; watch-page HTML is metadata fallback only.
- JSON3 UTF-8 captions and modern srv3 XML caption responses.
- English-language Markdown generation from the selected caption transcript (the model translates Hindi/Hinglish captions into technical English).
- Locally qualified frames may be stored in `HoverNotes/images/`; promotional-only intervals are suppressed and near-duplicate slide frames are skipped within a run. Manual snapshots remain available. Selection is not OCR or semantic image recognition.
- Gemini streaming with configured key rotation and an optional OpenAI-compatible fallback endpoint.
- Local Markdown saving in `HoverNotes/{Video_Title}.md`.
- Obsidian wiki-link screenshot references using unique `screenshot-<24-char-id>.jpg` filenames.
- Per-video progress checkpoints, fresh-run confirmation at the beginning of a video, graceful Stop with final-interval flushing, and cancellation on video navigation.

## Important limitations (not yet implemented)

- This build does **not** directly capture or transcribe video audio. It depends on captions exposed by YouTube. A video without an accessible caption track cannot produce faithful spoken-content notes; the extension reports this and does not advance its processing checkpoint.
- Automatic screenshot selection combines local visual-detail scoring, a conservative transcript-based promotional-intro filter, and perceptual near-duplicate detection. It is still not OCR or semantic image understanding: it can miss low-detail slides, retain visually busy but irrelevant frames in non-promotional intervals, or fail to judge text legibility. Sampling occurs every 2.5 seconds while AI Notes is active and does not seek or pause playback.
- It is currently YouTube-specific. Generic HTML5 players, Udemy, Coursera, university LMS pages, Bilibili, Zoom/Meet recordings, and local video files are not implemented.
- The annotation toolbar, advanced HoverNotes playback popover, multilingual selector, and other full HoverNotes UI-parity features are not part of Phase 1.
- AI requests are sent to the configured external AI provider. Local Markdown/image saving does not mean AI processing is offline. The Gemini API key is still stored in `chrome.storage.local` for this client-side prototype; do not share extension storage exports or screenshots of Settings.

## Historical diagnostic/build notes

- The sidebar header displays the installed build number (`v1.0.11`).
- v1.0.4 logged service-worker proxy outcomes; that proxy path was later removed from caption acquisition.
- v1.0.5/v1.0.6 direct-fetch and inline-script experiments were superseded by the v1.0.7 MAIN-world player observer.
- Caption acquisition logs use the `[HoverNotes Player Bridge]` and `[HoverNotes Captions]` prefixes; v1.0.9 performance measurements use `[HoverNotes Performance]`. Large caption bodies are transferred in 192 KiB chunks (up to a guarded 40 MiB response limit); logs never include PO-token query values or caption body text.
- Hovering the red save/error status reveals the complete diagnostic text when the compact bar clips it.

## 1.0.5 caption-fetch rollback

- Restored direct timed-text `fetch()` from the YouTube content-script context. This matches the original code path and v1.0.2; it intentionally does not route caption bodies through the extension service worker.
- Added safe content-script diagnostics for the requested caption host/path/format, HTTP status, content type, and response length. Signed query strings and caption text are not logged.
- The service-worker proxy remains available for unrelated approved requests, but timed-text retrieval no longer uses it.
- This is a targeted correction based on the v1.0.4 live diagnostic showing three service-worker requests returned HTTP 200, `text/html`, and zero response characters. Live verification is still required.

## Installation

1. Extract this ZIP to a stable folder, for example `C:\HoverNotes-Dev\hover-notes`.
2. Open `chrome://extensions/` and enable Developer mode.
3. Use **Load unpacked** and select the `hover-notes` folder (the folder containing `manifest.json`).
4. Configure your Gemini API key under the extension's Settings.
5. Connect your dedicated Obsidian test vault. The extension writes notes to `HoverNotes/` and screenshots to `HoverNotes/images/` inside that vault.
6. For future code updates, overwrite the files in the **same extracted folder** and click the extension's Reload button. Do not uninstall it or load the folder from a new path; the persisted vault directory handle is origin-scoped.
7. Refresh the YouTube tab after reloading the extension.

## Repeatable benchmark run

1. Open the same benchmark YouTube video at `00:00` and set playback to `2.0x`.
2. Click **AI Notes**. If a prior note/checkpoint exists for the same video, first export the previous output ZIP, then confirm the fresh-run prompt.
3. Let the video reach `30:00` (this is 30 minutes of video content, about 15 minutes of wall-clock playback at 2x).
4. Pause the video at `30:00`, then click **Stop**. If a generation request is already in progress, Stop finishes that segment and then processes any remaining transcript interval up to the paused timestamp.
5. Wait for the final save status. Verify the `.md` file and all referenced images exist in the vault.
6. Zip only the generated `HoverNotes/` output folder, including its `images/` directory. The images folder can retain unused screenshots from previous runs; for a clean comparison, include the images referenced by the current Markdown note. Do not include the whole vault or API keys.

## Phase 1 engineering notes

See `CHANGELOG.md` and `PHASE1-TEST-PLAN.md` for the fixes and manual acceptance tests. A static code check cannot prove Gemini output quality or Chrome/Obsidian runtime behavior; those must be validated using the benchmark run.

## YouTube caption acquisition in 1.0.7

- A dedicated static MAIN-world content script runs at `document_start`; it does not inject inline script elements, avoiding YouTube/extension CSP violations.
- The bridge observes the YouTube player's own `/api/timedtext` fetch/XHR response. It does not construct or log proof-of-origin (PO) tokens and does not refetch token-less `captionTracks[].baseUrl` values.
- When AI Notes requests a transcript, the bridge asks the YouTube player to activate the selected caption track and waits for the player-issued response.
- The browser page is the source of the caption response; the extension parses the response body in its isolated content-script context.
- This path depends on YouTube's undocumented player APIs and network behavior. It requires a live Chrome smoke test; the project does not claim it is verified until that test succeeds.
