# Phase 1.1 — developer verification plan (v1.0.25)

This is an internal/offline verification plan. It is not a request for the user to run another playback test.

## Automated suite

Run from the extension root:

```bash
for f in tests/*.test.cjs; do node "$f" || exit 1; done
```

The suite must cover:
- Transcript extraction, 30-second windows, packet association and map/reduce sidecars.
- Marker-free model responses.
- Reference-style output validation and conditional structural/editorial recovery, soft heading guidance, timestamp-heading removal, and selective callout-density refinement.
- Second-pass audit JSON parsing and source-batch construction.
- Omission detection, targeted repair, post-repair verification and fail-closed rejection.
- Screenshot restoration, frontmatter preservation, duplicate-title H1 cleanup (exact match only), and manual-edit safeguards.
- Existing caption, frame, Stop-boundary and Gemini fallback regressions.

## Fixed benchmark

Run:

```bash
node benchmarks/evaluate-reference-parity.cjs benchmarks/fixtures/dsa-lecture-00-08-golden.md
```

Expected: 13/13 content signal groups and 9/9 style checks.

The evaluator is a deterministic regex/formatting screen, not a full semantic judge. Its scores must be labelled accordingly. The gold note is a human-authored benchmark based on the user-supplied 00:00–08:00 transcript, not a live AI result or a claim about HoverNotes' private output.

## Package checks

- `node --check` every JavaScript file under `background/`, `content/`, `sidebar/` and `tests/` where applicable.
- Parse `manifest.json` and verify `manifest.json`, `VERSION.txt`, and visible UI build label all say `1.0.25`.
- Confirm no API keys are present in package files.
- Create ZIP with `manifest.json` at archive root and run `unzip -t`.

## Live integration status

Live Chrome and Gemini are not available to this offline developer harness. Do not claim the second-pass reviewer guarantees completeness or that v1.0.25 has achieved HoverNotes parity until a real final document has been inspected.
