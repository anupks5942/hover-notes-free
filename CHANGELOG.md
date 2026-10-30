
## 1.0.8 — Large caption response chunk relay

- Fixed the MAIN-world bridge's 3 MiB response-body cutoff. The user's live Hindi YouTube caption response was 13,969,317 characters; it was correctly observed but discarded before transfer.
- Increased the guarded maximum accepted caption response to 40 MiB and relays responses larger than 192 KiB through ordered, numbered `CAPTION_BODY_START` / `CAPTION_BODY_CHUNK` messages.
- Reassembles chunks in the isolated content script with transfer-ID validation, duplicate-chunk rejection, declared-length checks, bounded transfer count, and a 60-second timeout.
- Keeps small caption responses on the existing single-message path. PO tokens and caption contents are not written to diagnostic logs.
- Limits the MAIN-world full-body cache to two entries with a 10-minute replay window, and the isolated completed-body cache to two entries.
- Adds a large-body relay regression test using a 13,969,317-character payload, plus an isolated-world receiver integration test.
- Bumps manifest, sidebar UI, README, VERSION.txt and changelog to `1.0.8`.
- Automated tests do not prove live Chrome/YouTube extraction; the user's 2-minute smoke test remains required.

# Changelog

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
