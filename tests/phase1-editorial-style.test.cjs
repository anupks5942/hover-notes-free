const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

global.window = {};
vm.runInThisContext(fs.readFileSync('sidebar/note-synthesis.js', 'utf8'), {
  filename: 'sidebar/note-synthesis.js'
});
const h = window.HoverNotesNoteSynthesis;

// A duplicate H1 is removed only when it exactly matches the YAML title.
const duplicateTitle = `---\ntitle: "Data Structures & Algorithms"\nauthor: YouTube\n---\n\n# Data Structures & Algorithms\n\n### Core Concept\n- Source-grounded content.`;
const splitDuplicate = h.splitDocument(duplicateTitle);
assert.equal(splitDuplicate.removedDuplicateTitle, true);
assert.doesNotMatch(splitDuplicate.preamble, /^# /m);
assert.match(splitDuplicate.preamble, /title: "Data Structures & Algorithms"/);
assert.match(splitDuplicate.body, /^### Core Concept/);

// A distinct H1 is user content and must not be deleted just because frontmatter exists.
const distinctTitle = `---\ntitle: "Data Structures & Algorithms"\n---\n\n# Personal Study Plan\n\n### Core Concept\n- Source-grounded content.`;
const splitDistinct = h.splitDocument(distinctTitle);
assert.equal(splitDistinct.removedDuplicateTitle, false);
assert.match(splitDistinct.preamble, /# Personal Study Plan/);

// The captured YouTube metadata appends " - YouTube" while the display H1 does not.
const youtubeTitle = `---\ntitle: "Data Structure | DS in one shot - YouTube"\n---\n\n# Data Structure | DS in one shot\n\n### Course Overview\n- Course detail.`;
const splitYoutube = h.splitDocument(youtubeTitle);
assert.equal(splitYoutube.removedDuplicateTitle, true);
assert.doesNotMatch(splitYoutube.preamble, /^# /m);

assert.equal(h.readYamlTitle('title: "A \\\"quoted\\\" title"'), 'A "quoted" title');

const overlabelled = Array.from({ length: 9 }, (_, i) =>
  `### Topic ${i + 1}\n- **[Definition]** Statement one.\n- **[Example]** Statement two.\n- **[Key Insight]** Statement three.`
).join('\n\n');
const overMetrics = h.measureReferenceStyle(overlabelled);
assert.equal(overMetrics.mainTopicHeadings, 9);
assert.equal(overMetrics.boldCallouts, 27);
assert.ok(h.editorialStyleWarnings(overlabelled).some(x => x.code === 'excessive-bold-callouts'));

const selective = Array.from({ length: 9 }, (_, i) =>
  `### Topic ${i + 1}\n- Main statement.\n    - Supporting detail.\n- **[Key Insight]** One useful distinction.\n- **[Example]** One source-supported example.`
).join('\n\n');
assert.equal(h.editorialStyleWarnings(selective).length, 0, 'two distinct callouts per topic remain within the reference-calibrated ceiling');

// The source-length heading estimate is a soft editorial target, never a hard
// rejection threshold. A coherent four-section note must remain eligible for
// editorial recovery even when a 10-minute capture's heuristic suggests seven.
const fourTopicNote = Array.from({ length: 4 }, (_, i) =>
  `### Topic ${i + 1}\n- Main statement.\n    - Supporting source detail.`
).join('\n\n');
const lowHeadingWarnings = h.editorialStyleWarnings(fourTopicNote, 7);
assert.ok(lowHeadingWarnings.some(x => x.code === 'fewer-than-preferred-topic-headings' && x.severity === 'soft'));
assert.equal(h.validateOutput(fourTopicNote, 1200, {
  minimumCharacters: 100, minimumHeadings: 1, allowTimestampHeadings: true,
  requireNestedBullets: false, requireBoldLabels: false, requireHyphenBullets: true
}).valid, true, 'four coherent headings must not be rejected only for missing a time-derived heading quota');

const timestampDraft = fourTopicNote.replaceAll('### Topic', '### [00:00–02:00] Topic');
assert.ok(h.editorialStyleWarnings(timestampDraft, 7).some(x => x.code === 'timestamp-led-headings' && x.severity === 'hard'));
assert.equal(h.validateOutput(timestampDraft, 1200, {
  minimumCharacters: 100, minimumHeadings: 1, allowTimestampHeadings: true,
  requireNestedBullets: false, requireBoldLabels: false, requireHyphenBullets: true
}).valid, true, 'timestamp headings must reach the recovery pass instead of aborting before it');
assert.equal(h.validateOutput(timestampDraft, 1200, {
  minimumCharacters: 100, minimumHeadings: 2, requireNestedBullets: true,
  requireBoldLabels: true, requireHyphenBullets: true
}).valid, false, 'timestamp headings must still fail final strict validation if recovery does not fix them');

const endsWithMermaid = `### Data Organization\n- The examples form a supported relationship.\n\`\`\`mermaid\nmindmap\n  root((Organization))\n    Kitchen\n    Warehouse\n\`\`\``;
assert.equal(h.validateOutput(endsWithMermaid, 1000, {
  minimumCharacters: 100, minimumHeadings: 1, requireHyphenBullets: true
}).valid, true, 'a legitimate Mermaid fence at end of document must not be stripped as an outer response wrapper');
const outerWrapper = `\`\`\`markdown\n### Data Organization\n- Source-backed statement.\n\`\`\``;
assert.equal(h.validateOutput(outerWrapper, 0, {
  minimumCharacters: 10, minimumHeadings: 1, requireHyphenBullets: true
}).valid, true, 'a complete model-added outer Markdown wrapper should still be removed');

// The initial renderer and optional style-repair pass must follow the same contract.
const client = fs.readFileSync('sidebar/gemini-client.js', 'utf8');
assert.match(client, /Use bold bracketed labels sparingly/);
assert.match(client, /Normally use one or two bracketed callouts per main topic heading at most/i);
assert.match(client, /When three or more parallel examples illustrate the same abstract idea/);
assert.match(client, /candidateForAudit = styleValidation\.markdown/);
assert.match(client, /editorial-repair-accepted/);
assert.match(client, /runSemanticAudit\(candidateForAudit, 'initial'\)/);
assert.match(client, /no more than two per main topic heading/);

console.log('Editorial style density, source-supported diagram guidance, and duplicate-title regression tests passed.');
