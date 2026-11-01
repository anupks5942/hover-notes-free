const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

global.window = {};
vm.runInThisContext(fs.readFileSync('sidebar/note-synthesis.js', 'utf8'), {
  filename: 'sidebar/note-synthesis.js'
});

const tools = window.HoverNotesNoteSynthesis;
assert.ok(tools, 'note synthesis helpers should register');

const timestampedCue = '[00:12](https://youtu.be/abc?t=12)(https://youtu.be/abc?t=12) spoken lecture text';
assert.equal(tools.normalizeTranscriptForAI(timestampedCue), '[00:12] spoken lecture text',
  'AI input normalization should retain timestamp and spoken cue but remove duplicate URL wrappers');

const markdown = `---\ntitle: "DSA"\nsource: "https://youtube.com/watch?v=abc"\ntags: [study]\n---\n\n# DSA\n\n### [01:10] Idea of Computer Science\n- Data structures and algorithms.\n\n**[01:43](https://www.youtube.com/watch?v=abc&t=103s)**\n![[HoverNotes/images/slide-01.jpg]]\n\n### [02:10] Arrays\n- Contiguous memory.\n\n### [02:43](https://www.youtube.com/watch?v=abc&t=163s)\n![[HoverNotes/images/slide-02.jpg]]`;

const parts = tools.splitDocument(markdown);
assert.match(parts.preamble, /^---[\s\S]*tags: \[study\][\s\S]*---$/);
assert.doesNotMatch(parts.preamble, /^# DSA$/m, 'a body H1 that duplicates the YAML title should be removed');
assert.equal(parts.removedDuplicateTitle, true);
assert.match(parts.body, /^### \[01:10\]/);

const protectedDraft = tools.protectManagedScreenshotBlocks(parts.body);
assert.equal(protectedDraft.assets.length, 2);
assert.match(protectedDraft.markdown, /\[\[HN_VISUAL_ASSET_01\]\]/);
assert.match(protectedDraft.markdown, /\[\[HN_VISUAL_ASSET_02\]\]/);
assert.doesNotMatch(protectedDraft.markdown, /!\[\[HoverNotes\/images\//);
const visualContext = tools.extractVisualContext(protectedDraft.markdown, protectedDraft.assets);
assert.match(visualContext, /Idea of Computer Science/);
assert.match(visualContext, /Arrays/);
assert.doesNotMatch(visualContext, /HN_VISUAL_ASSET/);

const generated = `### Idea of Computer Science
- Efficient programs require data structures and algorithms. These are the foundations for organizing data and describing the process used to solve a problem.
- **[Key Insight]** The structure should be selected according to the problem's requirements, rather than choosing the same structure for every situation.

[[HN_VISUAL_ASSET_01]]

### Arrays
- Arrays use contiguous memory and support index-based access to their elements.
- **[Advantages]** Random access makes reading or updating a known index efficient.
- **[Limitations]** A fixed-size array may require shifting elements when inserting or deleting at an interior position.
[[HN_VISUAL_ASSET_02]]`;
const validation = tools.validateOutput(generated, protectedDraft.markdown.length);
assert.equal(validation.valid, true);
const restored = tools.restoreManagedScreenshotBlocks(validation.markdown, protectedDraft.assets);
assert.equal((restored.match(/!\[\[HoverNotes\/images\//g) || []).length, 2);
assert.match(restored, /\*\*\[01:43\]\(https:\/\/www\.youtube\.com\/watch\?v=abc&t=103s\)\*\*/);

// Gemini may omit screenshot placeholders. They are optional model output;
// the extension owns and restores the actual screenshot block after validation.
const generatedWithoutVisualToken = generated.replace('[[HN_VISUAL_ASSET_01]]', '').replace('[[HN_VISUAL_ASSET_02]]', '');
const visualIndependentValidation = tools.validateOutput(generatedWithoutVisualToken, protectedDraft.markdown.length);
assert.equal(visualIndependentValidation.valid, true, 'missing screenshot placeholders must not discard otherwise valid synthesis');
const visualRestoredAfterOmission = tools.restoreManagedScreenshotBlocks(visualIndependentValidation.markdown, protectedDraft.assets);
assert.equal((visualRestoredAfterOmission.match(/!\[\[HoverNotes\/images\//g) || []).length, 2, 'all screenshots must be restored even when Gemini omits both placeholders');

const droppedOne = tools.restoreManagedScreenshotBlocks(
  generated.replace('[[HN_VISUAL_ASSET_02]]', ''),
  protectedDraft.assets
);
assert.equal((droppedOne.match(/!\[\[HoverNotes\/images\//g) || []).length, 2);
assert.match(droppedOne, /### Visual References/);

const duplicated = tools.restoreManagedScreenshotBlocks(
  `${generated}\n\n[[HN_VISUAL_ASSET_01]]`,
  protectedDraft.assets
);
assert.equal((duplicated.match(/!\[\[HoverNotes\/images\/slide-01\.jpg\]\]/g) || []).length, 1);

assert.equal(tools.validateOutput('too short', 1000).valid, false);
assert.equal(tools.validateOutput('### Topic\n```mermaid\nflowchart TD\n A-->B', 100).valid, false);
assert.equal(tools.validateOutput('Some prose without headings '.repeat(20), 100).valid, false);
assert.equal(tools.validateOutput('### [00:00] First\nText\n\n### [01:00] Second\nMore text '.repeat(20), 100, { minimumCharacters: 100 }).valid, false,
  'timestamp-led headings must not pass final-note validation');

console.log('Note synthesis utility tests passed.');
