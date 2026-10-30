const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const parserSource = fs.readFileSync('content/caption-parser.js', 'utf8');
const source = fs.readFileSync('content/content.js', 'utf8');
const listeners = {};
const outgoing = [];
let runtimeListener = null;
const videoId = 'testVideo123';
const window = {
  __hoverNotesLoaded: false,
  location: { href: `https://www.youtube.com/watch?v=${videoId}`, origin: 'https://www.youtube.com' },
  addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
  postMessage(data, targetOrigin) {
    assert.equal(targetOrigin, this.location.origin);
    outgoing.push(data);
  },
  dispatchEvent() {},
  devicePixelRatio: 1
};
const document = {
  title: 'Large transcript receiver test - YouTube',
  documentElement: {},
  activeElement: null,
  querySelector() { return null; },
  getElementById() { return null; },
  createElement(tag) {
    assert.equal(tag, 'textarea');
    let value = '';
    return {
      set innerHTML(input) { value = String(input); },
      get value() { return value; }
    };
  }
};
const chrome = { runtime: { onMessage: { addListener(fn) { runtimeListener = fn; } } } };
class MutationObserver { constructor(fn) { this.fn = fn; } observe() {} }
const context = {
  window, document, chrome, URL, Map, Set, Promise, Number, String, Boolean, Math, Date,
  MutationObserver, setTimeout, clearTimeout,
  console: { info() {}, warn() {}, error() {} }
};
vm.createContext(context);
vm.runInContext(parserSource, context, { filename: 'content/caption-parser.js' });
vm.runInContext(source, context, { filename: 'content/content.js' });
assert.equal(typeof runtimeListener, 'function', 'content script should register its runtime listener');

function mainMessage(data) {
  for (const fn of listeners.message || []) {
    fn({ source: window, origin: window.location.origin, data: { source: '__HOVERNOTES_MAIN__', ...data } });
  }
}

(async () => {
  const responsePromise = new Promise(resolve => {
    const keepOpen = runtimeListener({
      action: 'GET_TRANSCRIPT_SLICE',
      payload: { startTime: 0, endTime: 30 }
    }, {}, resolve);
    assert.equal(keepOpen, true);
  });

  // Satisfy the player-track lookup with one Hindi auto-caption track.
  mainMessage({
    type: 'CAPTION_TRACKS', videoId,
    tracks: [{ languageCode: 'hi', kind: 'asr', vssId: 'a.hi', name: 'Hindi' }]
  });

  // Wait until getFullTranscript has registered its waiter and requested player captions.
  for (let i = 0; i < 100 && !outgoing.some(m => m.type === 'REQUEST_CAPTION_BODY'); i++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.ok(outgoing.some(m => m.type === 'REQUEST_CAPTION_BODY'), 'isolated script must request the selected player caption track');

  const spoken = 'न'.repeat(13_969_317);
  const body = JSON.stringify({
    events: [{ tStartMs: 0, dDurationMs: 30000, segs: [{ utf8: spoken }] }]
  });
  const chunkSize = 192 * 1024;
  const totalChunks = Math.ceil(body.length / chunkSize);
  const transferId = 'large-transfer-test';
  mainMessage({
    type: 'CAPTION_BODY_START', videoId, languageCode: 'hi', transferId,
    status: 200, contentType: 'application/json; charset=UTF-8', transport: 'fetch',
    responseCharacters: body.length, totalChunks
  });
  for (let index = 0; index < totalChunks; index++) {
    mainMessage({
      type: 'CAPTION_BODY_CHUNK', transferId, index,
      chunk: body.slice(index * chunkSize, (index + 1) * chunkSize)
    });
  }

  const result = await responsePromise;
  assert.equal(result.success, true);
  assert.equal(result.itemCount, 1);
  assert.equal(result.lines[0].startsWith('[00:00] '), true);
  assert.equal(result.transcriptText.length, '[00:00] '.length + spoken.length);
  assert.equal(result.transcriptText.endsWith(spoken), true);
  console.log(`PASS: isolated content script reassembled ${body.length.toLocaleString()} characters across ${totalChunks} chunks and parsed one Hindi cue.`);
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
