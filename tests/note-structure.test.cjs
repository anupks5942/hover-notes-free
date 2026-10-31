const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

global.chrome = { storage: { local: { get(_keys, callback) { callback({}); }, async set() {} } } };
global.window = {};
vm.runInThisContext(fs.readFileSync('sidebar/gemini-client.js', 'utf8'), { filename: 'sidebar/gemini-client.js' });

const client = window.geminiClient;

const malformed = '- Topic covered [00:00 - 0]:10] in the introduction.';
assert.equal(client.normalizeTimestampFormatting(malformed), '- Topic covered [00:00–00:10] in the introduction.');

const unsorted = `---\ntitle: Test\n---\n# Test\n\n### [02:23] Later concept\n- Later evidence.\n\n### [02:01](https://youtube.com/watch?v=x&t=121s)\n![[HoverNotes/images/slide.jpg]]\n\n### [01:39] Earlier concept\n- Earlier evidence.`;
const sorted = client.normalizeNoteDocument(unsorted);
assert.ok(sorted.indexOf('### [01:39] Earlier concept') < sorted.indexOf('**[02:01]('));
assert.ok(sorted.indexOf('**[02:01](') < sorted.indexOf('### [02:23] Later concept'));

const inserted = client.insertTimestampedBlockChronologically(
  '---\ntitle: Test\n---\n# Test\n\n### [01:39] First\n- Evidence.\n\n### [02:23] Second\n- More evidence.',
  '### [02:01](https://youtube.com/watch?v=x&t=121s)\n![[HoverNotes/images/slide.jpg]]',
  121
);
assert.ok(inserted.indexOf('### [01:39] First') < inserted.indexOf('**[02:01]('));
assert.ok(inserted.indexOf('**[02:01](') < inserted.indexOf('### [02:23] Second'));

const duplicated = `### [03:00] Computer science\n- Computer science is about solving problems by designing algorithms that can be converted into efficient programs. This is the instructor's central definition.\n\n### [03:40] Algorithm definition\n- Computer science is about solving problems by designing algorithms that can be converted into efficient programs.\n- An algorithm is a systematic, step-by-step procedure for solving a problem.\n\n### [04:00] More\n- An algorithm is a systematic, step-by-step procedure for solving a problem.`;
const deduped = client.normalizeNoteDocument(duplicated);
const csCount = (deduped.match(/computer science is about solving problems by designing algorithms/gi) || []).length;
const algorithmCount = (deduped.match(/an algorithm is a systematic, step-by-step procedure/gi) || []).length;
assert.equal(csCount, 1, 'canonical computer-science definition should appear once');
assert.equal(algorithmCount, 1, 'canonical algorithm definition should appear once');
assert.match(deduped, /This is the instructor's central definition\./,
  'non-duplicate information on a line containing a repeated definition must remain');
const expandedRepeat = client.normalizeNoteDocument('### [01:00] First\n- Computer science is about solving problems by designing algorithms that can be converted into efficient programs.\n\n### [02:00] Later\n- Computer science is about solving problems by designing algorithms that can be converted into efficient programs; the key challenge remains optimizing time and memory.');
assert.match(expandedRepeat, /the key challenge remains optimizing time and memory/i,
  'a repeated definition sentence with an additional meaningful clause must not be deleted');

const repeatedImage = `### [02:01](https://youtube.com/watch?v=x&t=121s)\n![[HoverNotes/images/slide.jpg]]\n\n### [03:00](https://youtube.com/watch?v=x&t=180s)\n![[HoverNotes/images/slide.jpg]]`;
const uniqueImage = client.normalizeNoteDocument(repeatedImage);
assert.equal((uniqueImage.match(/!\[\[HoverNotes\/images\/slide\.jpg\]\]/g) || []).length, 1);

assert.match(client.systemPrompt, /combine them into one concise note/i);
assert.match(client.systemPrompt, /Format time ranges consistently as \[MM:SS–MM:SS\]/);


// Regression: extension-owned screenshot insertion followed by a later streamed
// segment must not concatenate an image embed and timestamped heading on one line.
const malformedBlocks = `### [01:38](https://youtube.com/watch?v=x&t=98s)
![[HoverNotes/images/slide.jpg]]### [02:21] Objective and Core Purpose
- The instructor explains why DSA needs conceptual clarity [02:21–02:57].

The instructor describes the role of CS engineers [03:12].### [03:21] Definition of an Algorithm
- An algorithm is a systematic process.`;
const repairedBlocks = client.normalizeNoteDocument(malformedBlocks);
assert.match(repairedBlocks, /!\[\[HoverNotes\/images\/slide\.jpg\]\]\n\n### \[02:21\]/,
  'a managed image embed must be separated from the next timestamped heading');
assert.match(repairedBlocks, /engineers \[03:12\]\.\n\n### \[03:21\]/,
  'a paragraph must be separated from a concatenated timestamped heading');
assert.ok(!/\]\]###|\.### \[\d/.test(repairedBlocks),
  'no timestamped heading may remain concatenated to the preceding block');

const malformedPrevious = `### [01:38](https://youtube.com/watch?v=x&t=98s)
![[HoverNotes/images/slide.jpg]]### [02:21] DSA conceptual clarity
- Important instructional rationale.`;
const sanitizedPrevious = client.sanitizePreviousNotes(malformedPrevious);
assert.doesNotMatch(sanitizedPrevious, /HoverNotes\/images\/slide\.jpg/,
  'malformed managed image blocks should still be removed from previous-note context');
assert.match(sanitizedPrevious, /### \[02:21\] DSA conceptual clarity/,
  'normalizing a malformed image block must preserve the following content heading');

// Regression: a screenshot at 01:41 belongs inside the 01:38 DSA section,
// after its matching visual-observation bullet and before later 02:04/02:19 bullets.
// The old normalizer left the screenshot after the entire parent section and left
// the 01:41 visual bullet nested below later-timestamped content.
const liveChronologyCase = `---
title: DSA lecture
---
# DSA lecture

### [01:38] Importance and Fundamental Approach to Data Structures and Algorithms

- **[01:38–02:04] Significance of DSA:** The instructor emphasizes conceptual clarity.
- **[02:04–02:19] Career and Lifelong Impact:** The instructor claims these subjects are valuable.
- **[02:19–02:39] Depth Over Quick Jumping:** The instructor stresses understanding fundamentals.
  - **[01:41] Visual and Conceptual Framework:** The slide explains efficient programs.
    - Data Structures organize data; algorithms solve problems using organized data.

### [01:41](https://youtube.com/watch?v=x&t=101s)
![[HoverNotes/images/slide-0141.jpg]]

### [02:40] Core Intention of Studying Data Structures and Algorithms
- **[02:40–02:57] Beyond Rote Memorization:** The instructor explains the larger objective.`;
const chronologicalNote = client.normalizeNoteDocument(liveChronologyCase);
const chronologicalMarkers = [
  '- **[01:38–02:04] Significance of DSA',
  '- **[01:41] Visual and Conceptual Framework',
  '**[01:41](https://youtube.com/watch?v=x&t=101s)**',
  '![[HoverNotes/images/slide-0141.jpg]]',
  '- **[02:04–02:19] Career and Lifelong Impact',
  '- **[02:19–02:39] Depth Over Quick Jumping',
  '### [02:40] Core Intention'
];
let previousMarkerIndex = -1;
for (const marker of chronologicalMarkers) {
  const markerIndex = chronologicalNote.indexOf(marker);
  assert.ok(markerIndex > previousMarkerIndex, `chronological marker out of order: ${marker}`);
  previousMarkerIndex = markerIndex;
}
assert.doesNotMatch(chronologicalNote, /^\s{2,}- \*\*\[01:41\]/m,
  'the out-of-order visual observation must be promoted out of the later bullet');
assert.doesNotMatch(chronologicalNote, /^### \[01:41\]\(https?:/m,
  'a screenshot inside a timestamped topic must not remain as a peer heading');
assert.match(chronologicalNote, /Visual and Conceptual Framework[\s\S]*?\n\n\*\*\[01:41\]/,
  'screenshot should immediately follow the matching timestamped teaching point');

// Legacy screenshot blocks are also relocated when a document is normalized again.
const legacyScreenshotBlock = `### [01:41](https://youtube.com/watch?v=x&t=101s)\n![[HoverNotes/images/slide-0141.jpg]]`;
const normalizedAgain = client.normalizeNoteDocument(`${chronologicalNote}\n\n${legacyScreenshotBlock}`);
assert.equal((normalizedAgain.match(/!\[\[HoverNotes\/images\/slide-0141\.jpg\]\]/g) || []).length, 1,
  'normalization must keep one managed screenshot embed');

const conceptualPromptText = client.systemPrompt;
assert.match(conceptualPromptText, /conceptual framing, why a subject or idea matters, learning objectives/i);
assert.match(conceptualPromptText, /no new substantive instructional learning/i);
assert.match(conceptualPromptText, /Never use it merely because the interval contains no formula/i);
assert.match(conceptualPromptText, /distinctions between memorization and understanding/i);

console.log('Timestamp normalization, chronological screenshot insertion, duplicate-definition cleanup and image deduplication tests passed.');
