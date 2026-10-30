# Phase 1 manual acceptance test plan

These tests must be run in Chrome with a connected dedicated Obsidian test vault. The source ZIP alone cannot validate runtime or AI quality.

## Benchmark procedure

- Use the same YouTube lecture, start at 00:00, set playback to 2.0x.
- Start AI Notes and run until the player's timestamp reaches 30:00.
- Pause at 30:00, click Stop, wait for the final interval to finish and save.
- ZIP only `HoverNotes/` (Markdown plus all referenced images) and review it against the transcript.

## Acceptance checks

1. **Fresh run:** At 00:00, a previous run causes a confirmation. Confirming resets the note and cursor; cancelling leaves the previous note untouched.
2. **No subject leakage:** Early transcript segments must not contain formulas/concepts merely because they are common in DSA/GATE. Every example/value must be traceable to the supplied segment/frame.
3. **Continuity:** Adjacent transcript windows must not duplicate captions at their shared boundary or silently skip the requested interval.
4. **Prior context:** Later segments should not reproduce previous sections verbatim.
5. **Checkpoint integrity:** A failed/empty AI response must not advance `last_processed`; the output must not show a success notification.
6. **Stop:** Pausing at 30:00 and clicking Stop must finish the active segment, then flush the tail up to 30:00. No further segments should be scheduled afterward.
7. **Navigation cancellation:** Navigating to another YouTube video must cancel the active generation and must not append old-video output to the new note.
8. **Vault persistence:** Every Markdown screenshot reference must resolve to a file in `HoverNotes/images/`. Screenshot names must be unique.
9. **No captions:** On a video with no accessible YouTube captions, the extension must report that limitation and leave the progress checkpoint unchanged.
10. **Extension reload:** Reloading the extension from the same folder path must preserve access to the connected vault (subject to Chrome's permission state).

## Not a Phase 1 acceptance claim

This test does not prove full HoverNotes parity, direct audio understanding, caption-free operation, continuous visual comprehension, or support for non-YouTube sites. Those are later phases.


## 1.0.2 caption extraction regression

1. Run `node tests/caption-parser.test.cjs`; JSON3 `segs[].utf8` must produce non-empty cues.
2. On a Hindi YouTube lecture with captions, click AI Notes and confirm transcript extraction succeeds before a screenshot is written.
3. Confirm generated output is not just YAML/frontmatter and contains lecture text grounded in the captions.
4. If captions are not exposed, verify the UI reports a diagnostic (track discovery versus response parsing) and does not create an orphan screenshot or advance the checkpoint.
5. Repeat on a video with English captions and a video with no available captions.

## 1.0.7 player-issued caption response test (required before benchmark)

1. In `chrome://extensions/`, confirm the sidebar header displays `v1.0.7`. Reload the extension, then refresh the YouTube tab so the `document_start` MAIN-world observer is installed before YouTube's player scripts.
2. Open the service-worker console only for extension lifecycle errors; caption observer messages appear in the YouTube tab's page console.
3. Click AI Notes on a public video with a known caption track. The bridge should report `MAIN-world observer installed`, return caption-track metadata, then report that it requested captions through the YouTube player.
4. Confirm `[HoverNotes Player Bridge] Timed-text response observed` has `status: 200` and `responseCharacters > 0`; then confirm `[HoverNotes Captions] Player caption retrieval succeeded` with `cueCount > 0`.
5. Confirm no CSP inline-script error occurs. Confirm no `pot` token or full timed-text URL appears in logs.
6. Only after all of the above succeeds, run the 2-minute smoke test. If it fails, export the exact console lines and full red-banner tooltip; do not run the 15-minute benchmark.

This observer uses undocumented YouTube player APIs and may need adjustment when YouTube changes its player. The automated tests mock browser responses; they do not prove live YouTube caption behavior.
