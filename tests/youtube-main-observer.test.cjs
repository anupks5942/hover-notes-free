const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('content/youtube-main.js', 'utf8');
const listeners = {};
const emitted = [];
const logs = [];
const videoId = 'testVideo123';
const token = 'DO_NOT_LEAK_THIS_PO_TOKEN';
const captionTrack = {
  languageCode: 'hi',
  kind: 'asr',
  vssId: 'a.hi',
  name: { simpleText: 'Hindi (auto-generated)' },
  baseUrl: `https://www.youtube.com/api/timedtext?v=${videoId}&lang=hi`
};
const largeCaptionTrack = {
  languageCode: 'hi-large', kind: 'asr', vssId: 'a.hi-large',
  name: { simpleText: 'Hindi large-response test' },
  baseUrl: `https://www.youtube.com/api/timedtext?v=${videoId}&lang=hi-large`
};
let selectedTrack = null;

const player = {
  getPlayerResponse() {
    return { captions: { playerCaptionsTracklistRenderer: { captionTracks: [captionTrack, largeCaptionTrack] } }, videoDetails: { videoId } };
  },
  getOption(group, key) {
    if (group === 'captions' && key === 'tracklist') return [captionTrack, largeCaptionTrack];
    return null;
  },
  setOption(group, key, track) {
    assert.equal(group, 'captions');
    assert.equal(key, 'track');
    selectedTrack = track;
  },
  loadModule(name) { assert.equal(name, 'captions'); }
};

const location = { href: `https://www.youtube.com/watch?v=${videoId}`, origin: 'https://www.youtube.com' };
const document = {
  getElementById(id) { return id === 'movie_player' ? player : null; },
  querySelector() { return null; }
};

let responseBody = JSON.stringify({
  events: [{ tStartMs: 0, dDurationMs: 1500, segs: [{ utf8: 'नमस्कार दोस्तों' }] }]
});
const nativeResponse = {
  status: 200,
  headers: { get(name) { return name.toLowerCase() === 'content-type' ? 'application/json; charset=UTF-8' : ''; } },
  clone() { return { text: async () => responseBody }; }
};

function MockXHR() { this.handlers = {}; this.status = 200; this.responseType = ''; this.responseText = responseBody; }
MockXHR.prototype.addEventListener = function (type, fn) { (this.handlers[type] ||= []).push(fn); };
MockXHR.prototype.getResponseHeader = function () { return 'application/json'; };
MockXHR.prototype.open = function () {};
MockXHR.prototype.send = function () { for (const fn of this.handlers.loadend || []) fn(); };

const window = {
  location,
  ytInitialPlayerResponse: { captions: { playerCaptionsTracklistRenderer: { captionTracks: [captionTrack] } } },
  addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
  postMessage(data, targetOrigin) {
    assert.equal(targetOrigin, location.origin);
    emitted.push(data);
    for (const fn of listeners.message || []) fn({ source: window, origin: location.origin, data });
  },
  fetch: async () => nativeResponse,
  XMLHttpRequest: MockXHR
};

const context = {
  window, document, location, URL, Promise, Reflect, Object, String, Number, Date,
  setTimeout, clearTimeout,
  console: { info: (...args) => logs.push(args), warn: (...args) => logs.push(args), error: (...args) => logs.push(args) }
};
vm.createContext(context);
vm.runInContext(source, context, { filename: 'content/youtube-main.js' });

function inbound(type, payload = {}) {
  for (const fn of listeners.message || []) fn({
    source: window,
    origin: location.origin,
    data: { source: '__HOVERNOTES_ISOLATED__', type, ...payload }
  });
}

(async () => {
  inbound('GET_CAPTION_TRACKS', { videoId });
  const tracksMessage = emitted.find(m => m.type === 'CAPTION_TRACKS');
  assert.ok(tracksMessage);
  assert.equal(tracksMessage.tracks.length, 2);
  assert.equal(tracksMessage.tracks[0].languageCode, 'hi');
  assert.ok(!JSON.stringify(tracksMessage).includes(token));

  inbound('REQUEST_CAPTION_BODY', { videoId, languageCode: 'hi', vssId: 'a.hi' });
  assert.equal(selectedTrack.languageCode, 'hi', 'selected track should be activated through the player API');
  const activation = emitted.find(m => m.type === 'CAPTION_ACTIVATION' && m.ok);
  assert.ok(activation, 'player activation success should be reported');

  const tokenBearingPlayerUrl = `https://www.youtube.com/api/timedtext?v=${videoId}&lang=hi&fmt=json3&potc=1&pot=${token}`;
  const returnedResponse = await window.fetch(tokenBearingPlayerUrl);
  assert.equal(returnedResponse, nativeResponse, 'fetch wrapper must return the original response to YouTube');
  await new Promise(resolve => setTimeout(resolve, 0));
  const captionMessage = emitted.find(m => m.type === 'CAPTION_BODY');
  assert.ok(captionMessage, 'timedtext response should be relayed to isolated context');
  assert.equal(captionMessage.status, 200);
  assert.equal(captionMessage.responseCharacters, responseBody.length);
  assert.equal(captionMessage.body, responseBody);
  assert.ok(!JSON.stringify(emitted).includes(token), 'PO token must not be relayed');
  assert.ok(!JSON.stringify(logs).includes(token), 'PO token must not be logged');

  const bodyMessagesBeforeReplay = emitted.filter(m => m.type === 'CAPTION_BODY').length;
  inbound('REQUEST_CAPTION_BODY', { videoId, languageCode: 'hi', vssId: 'a.hi' });
  const bodyMessagesAfterReplay = emitted.filter(m => m.type === 'CAPTION_BODY').length;
  assert.equal(bodyMessagesAfterReplay, bodyMessagesBeforeReplay + 1, 'a player response observed before the extension request should be replayed from the in-memory cache');

  const xhr = new window.XMLHttpRequest();
  xhr.open('GET', tokenBearingPlayerUrl);
  xhr.send();
  await new Promise(resolve => setTimeout(resolve, 0));
  const xhrMessage = emitted.filter(m => m.type === 'CAPTION_BODY').at(-1);
  assert.equal(xhrMessage.transport, 'xhr');
  assert.equal(xhrMessage.body, responseBody);
  assert.ok(!JSON.stringify(emitted).includes(token));

  // Regression: the user's live Hindi lecture returned 13,969,317 characters.
  // Ensure it is relayed in ordered chunks rather than rejected at the old 3 MiB cap.
  responseBody = 'न'.repeat(13_969_317);
  inbound('REQUEST_CAPTION_BODY', { videoId, languageCode: 'hi-large', vssId: 'a.hi-large' });
  assert.equal(selectedTrack.languageCode, 'hi-large');
  const largeUrl = `https://www.youtube.com/api/timedtext?v=${videoId}&lang=hi-large&fmt=json3&potc=1&pot=${token}`;
  await window.fetch(largeUrl);
  await new Promise(resolve => setTimeout(resolve, 250));
  const startMessage = emitted.filter(m => m.type === 'CAPTION_BODY_START').at(-1);
  assert.ok(startMessage, 'large caption response should use the chunked relay protocol');
  assert.equal(startMessage.responseCharacters, 13_969_317);
  const chunks = emitted.filter(m => m.type === 'CAPTION_BODY_CHUNK' && m.transferId === startMessage.transferId)
    .sort((a, b) => a.index - b.index);
  assert.equal(chunks.length, startMessage.totalChunks);
  const reassembled = chunks.map(chunk => chunk.chunk).join('');
  assert.equal(reassembled.length, responseBody.length);
  assert.equal(reassembled, responseBody, 'chunk relay must preserve the full response without truncation');
  assert.ok(!JSON.stringify(emitted).includes(token), 'large response relay must not expose the PO token');
  assert.ok(!JSON.stringify(logs).includes(token), 'large response diagnostics must not log the PO token');

  console.log('PASS: MAIN-world fetch/XHR observer, player activation, 13,969,317-character chunk relay, cache replay and PO-token redaction.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
