# v1.0.20 field review — 2026-11-01

## Evidence from the supplied run

- The Stop boundary was 06:01.
- The final transcript retrieval contained 6,855 characters.
- The log shows `source-direct-input`, not `source-map-start`: the short-transcript direct-render branch bypassed evidence extraction.
- Final rendering completed and was applied/saved (`outcome: applied-and-saved`). This was not a rollback to the incremental draft.
- The saved final note contained 525 words and three concept headings (plus the screenshot reference section).

## Content comparison

The saved note did preserve the opening course overview, algorithm definition, time/memory criteria, and code-length misconception. It did not adequately preserve the 01:38–02:57 section explaining why DSA deserves conceptual clarity, why the instructor recommends depth over memorization, and the broader purpose of studying DSA before jumping into arrays/stacks/queues. That is a substantive coverage failure even though synthesis completed.

## Correction to an earlier assistant claim

The 525-word note's mention of the instructor's 15 years of experience and teaching thousands of students is supported by the original transcript at approximately 00:02–00:10. It was incorrect to describe that claim as unsupported. The transcript supports reporting it as the instructor's own claim; it does not independently verify it.

## Root cause addressed in v1.0.21

The direct-render path is removed. Every capture length now passes through bounded evidence extraction. Every non-empty 30-second source window gets a unique marker, which is required to survive evidence extraction and final rendering. The final prompt also contains a measured editorial contract derived from the supplied `hovernotes.io.md`, rather than only a vague instruction to be HoverNotes-like.

This change is a technically testable improvement, not proof of model-quality parity. Live output still requires inspection.
