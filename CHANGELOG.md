# Changelog

## v1.0.14 — Screenshot events interleaved within timestamped sections

- Extract extension-managed screenshot heading/embed pairs before section sorting.
- Sort timestamped instructional bullet blocks within their parent topic so an earlier visual observation cannot remain nested beneath later lecture content.
- Reinsert each screenshot as an inline timestamp anchor and Obsidian embed immediately after its matching timestamped teaching point (or the closest supported point).
- Preserve legacy top-level screenshot placement when no preceding timestamped topic section exists.
- Extend previous-note sanitization to remove both legacy screenshot headings and inline timestamp anchors.
- Preserve v1.0.13 Gemini timeout/fallback, caption retrieval, screenshot quality filtering, and Stop behaviour.
- Bump manifest, sidebar UI, README, VERSION.txt and changelog to `1.0.14`.
- Add an exact regression fixture for the v1.0.13 `[01:38]` parent section / `[01:41]` screenshot / `[02:04]` bullet chronology defect.

## 1.0.13 — Markdown block integrity and instructional coverage

- Fixes Markdown assembly when a new streamed segment starts directly after a screenshot embed or timestamped heading; inserts and validates blank-line boundaries before persistence.
- Applies the same block-boundary normalization before previous-note sanitization, so concatenated screenshot embeds cannot leak into later Gemini context.
- Strengthens the system and per-segment prompts to retain meaningful conceptual framing, why a subject matters, learning objectives, instructor rationale, analogies, and distinctions between memorization and understanding—even when no formula or formal operation is taught.
- Restricts the no-new-content comment to intervals without new substantive instructional learning, rather than using absence of a formula/definition as a proxy for absence of learning.
- Adds regression tests for the exact live Markdown concatenation failures and the transcript's early DSA conceptual discussion.
- Preserves v1.0.12 screenshot relevance heuristics, promotional filtering, perceptual deduplication, 30-second Gemini first-token timeout/fallback, 300-second segment size, Stop boundary, and the large-caption player bridge.
- Bumps manifest, sidebar UI, README, VERSION.txt and changelog to `1.0.13`.
- Automated tests verify deterministic formatting and prompt rules; only another live run can validate model-level content coverage.

## 1.0.12 — Obstruction-aware frame ranking and chronological note assembly

- Preserves the v1.0.11 transcript-based promotional gate and perceptual duplicate detection.
- Adds a local warm-tone foreground-occlusion proxy over the upper-left slide area. It reduces a candidate's selection score when skin-like foreground pixels obscure likely slide content, while retaining eligibility so a frame is not discarded solely by this imperfect color heuristic. This is not face detection, OCR, or semantic vision.
- Uses the obstruction-adjusted selection score both when retaining the best frame per minute and when choosing the best frame for a transcript interval. Logs include the estimated ratio and penalty for live calibration.
- Inserts screenshot anchors and Obsidian embeds at their actual timestamp in the Markdown rather than appending them at the end. The complete note is normalized before persistence so timestamped concept sections and screenshot blocks are chronologically ordered.
- Removes exact duplicate extension-managed image embeds and repeated canonical statements for the computer-science definition, algorithm definition, and efficient-program relationship while preserving other sentences on the same bullet.
- Repairs only the known unambiguous malformed timestamp range form (`[00:00 - 0]:10]`), and tightens the prompt to merge a slide definition with the instructor's verbal restatement rather than repeating it.
- Adds regression tests for foreground-obstruction ranking, timestamp-range repair, chronological screenshot insertion, duplicate image embeds, and repeated definitions. Existing Gemini 30-second fallback, promotional suppression, duplicate-frame detection, Stop behavior, 300-second chunking and large caption bridge are retained.
- Local tests cannot prove that a selected frame is semantically educational or fully unobstructed. A live Chrome smoke test is required.
- Bumps manifest, sidebar UI, README, VERSION.txt and changelog to `1.0.12`.

## 1.0.11 — Transcript-aware screenshot gating, slide deduplication and chronological note guidance

- Keeps the v1.0.10 30-second Gemini first-token timeout, sticky session fallback model, and model-specific generation configuration unchanged.
- Moves automatic screenshot selection until after the current transcript interval is extracted. A conservative Hindi/English transcript classifier suppresses automatic screenshots for intervals with multiple promotional signals and no instructional signals. The supplied lecture's 00:00–01:18 promotional introduction matches this rule and should no longer produce an automatic screenshot.
- Adds a whole-frame 64-bit perceptual difference hash plus four regional hashes to visually qualified candidates. Exact/near matches use a whole-frame Hamming distance of 10 or less. If the presenter moves, a motion-aware fallback also requires a whole-frame distance of 25 or less plus two adjacent matching regions (regional distance 21 or less). The extension suppresses repeats against screenshots already saved in the current run and among candidates within the current interval. Frames are marked as used only after their screenshot has been persisted.
- Removes extension-managed screenshot headings and Obsidian embeds from prior-note context before sending it to Gemini. It also sanitizes generated text before persistence if the model nevertheless emits managed screenshot references, preventing copied old image links from appearing twice.
- Passes the selected frame's actual timestamp to the model and instructs it to keep transcript-derived material in strictly increasing timestamp order, place frame-only observations at the frame timestamp, and avoid repeating definitions already covered.
- Does not add OCR or a separate vision-model call. Screenshot filtering remains a conservative transcript-promotion gate plus visual-detail scoring and perceptual deduplication; it cannot prove that every retained frame is educationally relevant or readable.
- Adds regression tests for the supplied Hindi promotional-intro pattern, instructional transcript acceptance, near-duplicate slide hashes, managed-image context stripping, and chronology/asset prompt rules. Existing caption bridge, 40 MiB cap, 192 KiB chunk relay, Stop-boundary handling, AI prompt grounding, 300-second segment size and first-token timeout are retained.
- All 10 automated test files pass. The new selection and note-organization behavior still requires a live Chrome smoke test; automated tests do not prove image quality or model compliance on all lecture types.
- Bumps manifest, sidebar UI, README, VERSION.txt and changelog to `1.0.11`.

## 1.0.10 — Bounded Gemini first-token wait and study-frame selection

- Adds a 30-second first-text-token timeout to each Gemini request. The timeout ends as soon as the first non-empty text delta arrives; it does not cap a successful stream after output begins. Timed-out primary attempts fall through to the configured fallback model. Once a fallback succeeds, it becomes preferred for the rest of the extension session to avoid repeating the same wait on each interval; saving model settings or reloading resets the preference. Explicit parent cancellation remains a cancellation and does not trigger fallback.
- Sends `thinkingConfig` only to the configured primary model. The known fallback model is sent without that unsupported option, avoiding the extra HTTP 400 and duplicate retry observed in v1.0.9. The primary-model compatibility retry remains when a 400 rejects `thinkingConfig`.
- Adds a passive frame sampler that checks a 320×180 frame every 2.5 seconds while AI Notes is active, without changing video playback or seeking. It retains the best quality-scored frame per minute (20-bucket cap) and selects the highest-scoring candidate within the current transcript interval.
- Adds a local edge-density / distributed-detail screen. A frame failing the threshold is not attached to Gemini or saved as an automatic study screenshot; transcript-based generation continues. Manual screenshots are unchanged. The heuristic is not OCR, legibility detection, face detection, or semantic understanding.
- Calibrates the v1.0.10 local screenshot heuristic against the supplied v1.0.9 images: 01:19 talking-head/flag image rejected (score 29); 04:00 slide image accepted (score 88).
- Updates the system prompt to attribute instructor promises, guarantees, opinions, and personal claims rather than presenting them as verified facts.
- Adds regression tests for first-token timeout fallback, model-specific generation settings, and slide-like frame scoring.
- Bumps manifest, sidebar UI, README, VERSION.txt and changelog to `1.0.10`.
- Automated tests do not prove live Gemini fallback latency or screenshot quality across different lecture styles; run the short Chrome smoke test before the 30-minute benchmark.

## 1.0.9 — Performance diagnostics and controlled Stop finalization

- Adds structured timing for caption-track discovery, player caption-response wait/chunk delivery, caption parsing, transcript-slice filtering, screenshot capture, screenshot persistence, Gemini requests, Markdown rendering, and note saving.
- Adds Gemini attempt diagnostics with provider/model, configured key-slot number (never key material), HTTP status, fallback/retry reason, response-header latency, time to first generated text, stream duration, and generated-character count.
- Emits one performance report per processing interval and a run summary containing wall-clock duration and summed AI-processing time. Diagnostic logs do not include API keys, prompts, transcript text, image data, or caption bodies.
- Captures the player timestamp when Stop is requested, guards the async Stop-boundary race, and bounds the final transcript flush to that timestamp. A frame captured beyond the frozen boundary is omitted rather than mislabeled with an earlier timestamp; screenshot-response timing cannot shorten the transcript interval.
- Changes the post-Stop UI to show `Finishing…`, a persistent spinner, and `Finishing notes…` / interval-specific status until the final flush and save complete.
- Prevents an automatic second flush after a failed in-flight generation; failed intervals remain uncommitted so the user can inspect the error rather than silently waiting through a duplicate attempt.
- Batches streamed Markdown preview rendering to at most one whole-document render every 150 ms, with a forced final render before persistence.
- Keeps the caption acquisition strategy, 40 MiB caption limit, 192 KiB chunk relay, evidence-first prompt, configured model order, API-key rotation policy, 300-second AI segment size, and output format unchanged.
- Adds regression tests for Gemini performance event reporting, Stop-boundary/finalization invariants, caption timing metadata, and transcript-cache-hit reporting.
- Bumps manifest, sidebar UI, README, VERSION.txt and changelog to `1.0.9`.
- Automated tests validate instrumentation and control-flow invariants; only a live Chrome run can establish actual end-to-end processing times and whether the performance bottleneck has been identified.


## 1.0.8 — Large caption response chunk relay

- Fixed the MAIN-world bridge's 3 MiB response-body cutoff. The user's live Hindi YouTube caption response was 13,969,317 characters; it was correctly observed but discarded before transfer.
- Increased the guarded maximum accepted caption response to 40 MiB and relays responses larger than 192 KiB through ordered, numbered `CAPTION_BODY_START` / `CAPTION_BODY_CHUNK` messages.
- Reassembles chunks in the isolated content script with transfer-ID validation, duplicate-chunk rejection, declared-length checks, bounded transfer count, and a 60-second timeout.
- Keeps small caption responses on the existing single-message path. PO tokens and caption contents are not written to diagnostic logs.
- Limits the MAIN-world full-body cache to two entries with a 10-minute replay window, and the isolated completed-body cache to two entries.
- Adds a large-body relay regression test using a 13,969,317-character payload, plus an isolated-world receiver integration test.
- Bumps manifest, sidebar UI, README, VERSION.txt and changelog to `1.0.8`.
- Automated tests do not prove live Chrome/YouTube extraction; the user's 2-minute smoke test remains required.


## 1.0.7 — Player-issued YouTube caption response observer

- Replaced inline `<script>` injection with a static Manifest V3 MAIN-world content script declared at `document_start`; this avoids the CSP violation seen in v1.0.6.
- Observes the YouTube player's native `/api/timedtext` fetch/XHR response and relays the response body to the isolated content script.
- Requests caption activation through the YouTube player API and waits for player-issued cues, including retry while player track controls are not ready (for example, during pre-roll ads).
- Stops fetching token-less `captionTracks[].baseUrl` URLs directly. No PO token is synthesized, stored, or written to logs.
- Adds explicit diagnostics for track activation, timeout, body length, transport and parser outcomes.
- Bumps manifest, sidebar UI, README and changelog version to `1.0.7`.
- Validation includes mocked MAIN-world fetch/XHR interception, bridge messaging, JSON3/Hindi parsing, syntax, manifest and ZIP checks. **Live YouTube behavior is not verified by automated tests and requires the user's Chrome smoke test.**

## 1.0.6 — Restore original caption acquisition path

- Restored the original inline page-world caption-track event bridge (`__HOVERNOTES_CAPTIONS_RESPONSE__`) instead of the v1.0.2+ service-worker `executeScript` track-discovery route.
- Restored the original `pickBestCaptionTrack` preference and exact timed-text URL/fallback sequence: append `fmt=json3` as the original did, then request the selected `baseUrl` unchanged.
- Restored the original cue-overlap interval filter while retaining exact requested interval bounds (no silent 120-second expansion).
- Restored the original manifest host-permission set, including `<all_urls>`, to avoid combining permission tightening with caption-pipeline regression recovery. This broad permission is temporary until live behavior is verified and a least-privilege reduction can be tested independently.
- Kept transcript-grounded AI prompt, cancellation/progress changes, screenshot persistence safeguards, and visible build label.
- Added diagnostics for both original-path requests without logging signed URL query parameters or caption text.
- Live YouTube caption retrieval is not claimed fixed until verified by the user.

## 1.0.5 — Restore YouTube page-context caption retrieval

- Reverted the v1.0.3 change that routed YouTube `/api/timedtext` requests through the extension service worker.
- Restored direct content-script `fetch()` for JSON3/SRV3/XML timed-text requests, matching the original working request context and v1.0.2 implementation.
- Added content-script diagnostics for request host/path/format, HTTP status, content type, and response length without logging signed URL parameters or caption text.
- Kept the v1.0.4 visible version badge and parser improvements.
- Does not claim live success until tested in the user's Chrome environment.


## 1.0.1 — Phase 1 correctness and reliability

- Replaced the subject-specific, GATE/DSA-prescriptive system prompt with evidence-first instructions. Removed preloaded array formulas and forced example requirements that encouraged hallucinations.
- Added prior note context (last 12,000 characters) so each segment can avoid repeating existing content.
- Removed silent transcript-window expansion. Caption extraction now uses the exact requested half-open time interval and avoids duplicate captions at adjacent boundaries.
- Removed premature processing-cursor commits. Progress advances only after non-empty AI output is successfully saved.
- API/model failures now propagate to the caller rather than falling through to a success notification.
- Added `AbortController` propagation to Gemini and OpenAI-compatible streaming calls; video navigation aborts and waits for the active generation before switching notes.
- Changed the user-facing Stop behavior to stop scheduling, finish the in-flight segment, and flush any remaining interval after the video is paused.
- Added a fresh-run confirmation at video time 00:00 when previous progress/sections exist; the confirmation warns the user to export the previous run first.
- Required a connected Obsidian vault before screenshot capture, preventing Markdown links to unsaved image files.
- Changed screenshot filenames to unique 24-character identifiers to avoid same-timestamp overwrites.
- Moved Gemini API keys from URL query strings to the `x-goog-api-key` request header (the key remains in client-side extension storage; this is not server-side secret management).
- Restricted the broad `<all_urls>` host permission; this build's content script remains YouTube-only.
- Added message-source checks to the sidebar/content-script bridge and cleared bridge response timeouts when requests complete.
- Updated README to state the current limitations accurately.

## Known limitations carried into Phase 2

- No direct audio capture/transcription; notes depend on YouTube caption availability.
- One still frame per processing interval; scene-change/keyframe sampling is not implemented.
- No generic video-platform support or full HoverNotes UI parity yet.


## 1.0.2 — YouTube caption extraction hotfix

- Read `ytInitialPlayerResponse` through `chrome.scripting.executeScript` in the MAIN world instead of depending on an inline page script.
- Parse YouTube JSON3 `segs[].utf8` (while retaining legacy `utf16`) and modern `srv3` XML `<p>/<s>` cues.
- Try JSON3, srv3, and XML response formats across available caption tracks.
- Do not cache an empty transcript result; provide actionable extraction diagnostics.
- Extract transcript before persisting any screenshot; keep the AI screenshot in memory until note generation succeeds to avoid orphaned image files on caption/API failures.
- Add regression tests for real JSON3 cue structure, including Hindi/UTF-8 text and HTML entities.


## 1.0.3 — Caption fetch transport and vault initialization fix

- Fetch timedtext caption URLs through the extension service worker proxy, not directly from the YouTube content-script context. This addresses cross-origin fetch restrictions that can leave a discovered caption track with no readable cue body.
- Constrain the proxy to HTTPS YouTube and Gemini hosts.
- Preserve HTTP status/error details from the proxy for caption diagnostics.
- Stop creating empty `HoverNotes/` and `images/` directories merely when the vault is connected or restored; create them lazily on the first actual file save.
- Existing saved vault handles remain in IndexedDB; no reconnection is required when reloading the extension from the same directory.


## 1.0.4 — Caption pipeline diagnostics and visible build label

- Added the installed build number to the sidebar header.
- Added service-worker logs for MAIN-world caption track discovery and timed-text proxy request/response outcomes. Logs omit signed query parameters and caption text.
- Added content-script diagnostics for track candidates, per-format fetch/parse outcomes, cue counts, and final failure reasons.
- Added full diagnostic text to the save-status tooltip to avoid losing detail when the compact UI clips the red error message.
- This release improves observability only; it does not claim to resolve live caption retrieval until verified in Chrome against a real YouTube video.
