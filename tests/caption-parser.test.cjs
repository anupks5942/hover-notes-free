const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const parserSource = fs.readFileSync('content/caption-parser.js', 'utf8');
const context = { globalThis: {}, console };
vm.createContext(context);
vm.runInContext(parserSource, context, { filename: 'content/caption-parser.js' });
const parser = context.globalThis.HoverNotesCaptionParser;

const json3 = {
  events: [
    { tStartMs: 0, dDurationMs: 2200, segs: [{ utf8: 'नमस्कार ' }, { utf8: 'दोस्तों' }] },
    { tStartMs: 2200, dDurationMs: 1800, segs: [{ utf8: 'Array &amp; Stack' }] },
    { tStartMs: 4000, dDurationMs: 500, segs: [{ utf16: 'legacy fallback' }] },
    { tStartMs: 4500, dDurationMs: 200, wWinId: 1 }
  ]
};
const cues = parser.parseJson3TimedText(json3);
assert.equal(cues.length, 3);
assert.equal(cues[0].start, 0);
assert.equal(cues[0].text, 'नमस्कार दोस्तों');
assert.equal(cues[1].text, 'Array & Stack');
assert.equal(cues[2].text, 'legacy fallback');

console.log('YouTube JSON3 caption parser tests passed.');
