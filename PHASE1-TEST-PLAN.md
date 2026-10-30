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

## v1.0.11 screenshot deduplication and note chronology checks

1. Reload v1.0.11 from the same unpacked extension directory and refresh the YouTube tab. Keep the existing MyVault connection.
2. Run the supplied KnowledgeGATE lecture from 00:00 at 2.0×. Let it reach 04:00, pause first, then click Stop.
3. Confirm the 00:00–01:18 course-promotion interval logs `Screenshot selection skipped for promotional interval` and does not create an automatic image embed.
4. Confirm the later instructional interval can select a slide. If the same slide remains visible in subsequent intervals, confirm the perceptual hash gate reports a duplicate and does not save another copy.
5. Inspect the Markdown: each screenshot heading/embed pair must occur once; previously saved screenshot links must not be copied into the next AI-generated segment; major concept headings should have timestamps in ascending order.
6. Compare the notes against `Transcript.txt` around 01:39–04:01. The frame at 02:38 may support a visual slide description at 02:38, but it must not move that visual information ahead of earlier transcript content.
7. Send the single YouTube-tab Console export, generated Markdown, and screenshot files. Verify that transcript generation continues even when a screenshot is suppressed.
8. Automated tests do not prove the model will always obey chronology instructions or that visual selection is semantically correct. Review this live result before resuming the 30-minute benchmark.

## v1.0.10 performance, model fallback and initial study-frame checks

1. Use the same unpacked extension directory; reload the extension and refresh the YouTube tab. Do not disconnect or reconnect the existing vault.
2. Start the benchmark video at 00:00 and 2.0x. Start AI Notes, then pause the video at the chosen test boundary before pressing Stop.
3. Confirm the button changes to `Finishing…`, remains disabled with the spinner visible, and does not return to `AI Notes` until the final interval has either saved or failed visibly.
4. Confirm an in-flight generation finishing during the asynchronous Stop-position query does not close the run early; the final note must not contain timestamps later than the captured Stop boundary. If the frame capture occurs after the boundary, the out-of-range frame must be omitted instead of being assigned the earlier timestamp.
5. In DevTools Console, filter for `[HoverNotes Performance]` and collect `Caption transcript load finished`, `Gemini attempt`, `Generation segment completed`, and `AI Notes run completed` records.
6. Confirm diagnostics include caption load/cache, parse and slice timings; Gemini provider/model/key-slot attempt, HTTP status, first-token and stream timing; screenshot, preview and note-save timings; and final run wall time.
7. Confirm no API key, prompt text, transcript text, caption body, or image data appears in the performance records.
8. Compare the measured timings before changing model selection, AI prompts, or the 300-second generation segment size. A successful automated test is not a substitute for this live performance run.


## v1.0.10 short live smoke test (required before 30-minute benchmark)

1. Reload v1.0.10 from the same unpacked extension folder and refresh the YouTube tab. Keep the existing MyVault connection.
2. Start the same lecture at 00:00 and 2.0x. Run to 04:00, pause first, then click Stop. Wait until the button returns to `AI Notes` and the spinner disappears.
3. In the single YouTube tab DevTools Console, collect `[HoverNotes Performance]`, `[HoverNotes Frames]`, `[HoverNotes AI]` and `[HoverNotes Captions]` records. No second DevTools console is required when all these prefixes appear in the same console.
4. Confirm a slow primary Gemini attempt logs `first-token-timeout` after approximately 30 seconds and proceeds to the fallback model; confirm the fallback request does not contain `thinkingConfig`. A fast primary response should not trigger the timeout.
5. Confirm a talking-head-only interval logs `selected: false` and does not create an automatic screenshot embed. Confirm an interval with a slide-like frame can select and embed the best candidate with its actual sampled timestamp.
6. Confirm screenshots are not captured by seeking or pausing the video; only the user-operated pause before Stop should change playback state.
7. Confirm instructor guarantees/opinions in the generated Markdown are attributed to the instructor. Check the exported Markdown links and image files in the vault.
8. Only after this smoke test succeeds should the 30-minute benchmark resume.
