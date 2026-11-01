# Phase 1.1 — semantic coverage and reference parity report

## Executive result

v1.0.23 adds a separate source-to-note review pass and one targeted repair pass after final rendering. It closes a specific gap in v1.0.22: deterministic source-window assignment proved that each transcript window was routed into an evidence packet, but did not prove that important meaning from the window survived evidence extraction and final rendering.

This report records **offline code and benchmark validation only**. The browser extension has not been run against live Gemini in this environment. Do not interpret the passing tests as proof that real model output already matches HoverNotes.

## What v1.0.22 did not verify

- JavaScript assigned every non-empty 30-second source window to an evidence packet and carried that association through map/reduce.
- That bookkeeping proved source routing, not semantic preservation.
- The final renderer was prompted to perform its own coverage check, but no separate source-to-note comparison ran after rendering.
- The structural validator measured headings, bullet structure, callouts, output length and Markdown fences. It did not detect omitted lecture concepts.

## v1.0.23 changes

1. **Second-pass source-to-note audit.** After final rendering, the configured AI provider receives original timestamped transcript batches and the entire candidate note. It reports material points missing from the note and claims directly contradicted by that source batch.
2. **JavaScript-owned source association.** Batches are constructed deterministically from the original transcript chunks. The model does not need to reproduce internal IDs.
3. **Targeted repair.** If omissions or directly contradicted claims are found, one repair request receives the affected source ranges, findings and full candidate document. It is instructed to preserve unrelated correct content and the reference style.
4. **Post-repair verification.** The same second-pass audit runs again. If findings remain, final synthesis fails closed and the existing incremental draft is retained rather than silently accepting the incomplete candidate.
5. **False-positive guard.** An auditor examining one source batch must not flag a note claim merely because that claim is absent from that batch; it may be supported elsewhere in the lecture. Unsupported-claim findings are limited to direct contradictions or clear overstatements disproved by the supplied batch.
6. **Reference-profile correction.** The DSA-specific style exemplar was replaced by a subject-neutral structure. The measured reference statistics were corrected from the actual file.
7. **Fail-closed regression.** The mocked integration suite verifies that an omission triggers a repair, a successful repair is re-audited, and a still-incomplete repaired note is rejected.

## Reference measurements

Measured from the supplied `hovernotes.io.md`:

| Measure | Observed |
|---|---:|
| Characters | 21,651 |
| Lines | 467 |
| Words (regex count) | 2,894 |
| `###` headings | 32 |
| `####` headings | 6 |
| Top-level hyphen bullets | 82 |
| Nested hyphen bullets | 163 |
| Mermaid diagrams | 3 |
| Display equations | 1 |
| Markdown table lines | 24 |

These measurements describe the whole export. They are not target quotas for every partial lecture. The reference profile and benchmark distinguish style expectations from content coverage.

## Fixed benchmark fixture: KG DSA 00:00–08:00

Source basis:
- User-supplied timestamped Hindi transcript `Transcript(5).txt`.
- User-supplied full reference export `hovernotes.io.md` for editorial style.
- Source interval limited to 00:00–08:00.

The hand-curated `benchmarks/fixtures/dsa-lecture-00-08-golden.md` is a **benchmark example authored from the supplied transcript**, not a copy of an unavailable HoverNotes 8-minute export and not a live AI generation.

Its measured result:

| Benchmark dimension | Result |
|---|---:|
| Content signal groups | 13/13 (100%) |
| Style checks | 9/9 (100%) |
| Words | 870 |
| Topic headings | 9 |
| Timestamp-led headings | 0 |
| Nested hyphen bullets | 19 |
| Bold callouts | 18 |
| Mermaid diagrams | 1 |
| Display equations | 1 |

The diagram and equation are justified by the source: the lecture uses real-world data-organization analogies and displays the equation `Efficient Program = Data Structure + Algorithm`. No comparison table or code example is forced into this eight-minute fixture because that interval does not support them.

## Historical output screening

The deterministic benchmark was also run on prior files supplied by the user:

| Historical file | Words | Content signal groups | Style checks |
|---|---:|---:|---:|
| v1.0.21 output ending at 08:00 | 1,135 | 12/13 (92%) | 3/9 |
| v1.0.20 output | 513 | 7/13 (54%) | 3/9 |
| Earlier output | 870 | 9/13 (69%) | 4/9 |

**Critical qualifier:** these historical files were incremental/fallback documents from runs where final synthesis did not complete or was rejected. They are useful for showing why chronological drafts fail the target-style screen, but they are not measurements of a successfully applied final synthesis.

## What the offline benchmark does and does not prove

The benchmark has two layers:

- **Deterministic style checks:** topic-heading counts, timestamp headings, bullet convention, nesting, callouts, diagrams, equations and word-count bounds.
- **Keyword/signal coverage checks:** predefined source concepts are searched for in the note using regular expressions and minimum hit counts.

This is a regression screen, not a semantic theorem prover. A keyword-based evaluator can be fooled by irrelevant keyword stuffing and cannot fully determine whether an explanation is faithful. The second-pass model audit adds a stronger check, but it uses the same configured model/provider pipeline and is therefore not an independent third-party judge. Both can make mistakes.

## Verification performed for v1.0.23

- 20/20 Node test scripts pass.
- Markdown sanitizer TAP suite: 4/4 subtests pass.
- Dedicated test verifies source batching and audit JSON parsing.
- Mocked integration test verifies omission detection → targeted repair → post-repair audit.
- Mocked fail-closed test verifies that remaining omissions reject the final candidate.
- Reference benchmark passes the curated gold fixture and rejects a deliberately chronological/incomplete draft.
- JavaScript syntax, manifest version, package version and ZIP integrity checks are performed before delivery.

Not performed:
- Live Chrome integration.
- Live Gemini requests.
- Human review of a newly generated v1.0.23 note.
- Proof of exact HoverNotes wording or private backend equivalence.

## Acceptance definition

A future live output should not be accepted solely because synthesis returns `applied-and-saved`. Review the saved Markdown against the matching transcript interval for:

1. Coverage of every material teaching point, explanation, example, analogy, distinction and course detail.
2. Correct attribution of instructor claims and absence of invented claims.
3. Topic-based structure, nested hyphen bullets and bold concept callouts.
4. Source-justified use of equations, Mermaid, tables and code.
5. No chronological heading-per-window structure or arbitrary compression.

A single passing short capture is not evidence of reliability across all videos or subjects. Broader regression requires multiple subjects, speakers, transcript styles and longer captures.
