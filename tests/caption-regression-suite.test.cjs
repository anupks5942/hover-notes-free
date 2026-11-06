const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const parserSource = fs.readFileSync('content/caption-parser.js', 'utf8');
const contentSource = fs.readFileSync('content/content.js', 'utf8');
const mainSource = fs.readFileSync('content/youtube-main.js', 'utf8');

// Lightweight DOMParser mock for Node.js test environment
function createMockDOMParser() {
  return class MockDOMParser {
    parseFromString(str, mimeType) {
      const xml = String(str || '').trim();
      if (xml.startsWith('<parsererror') || (xml.startsWith('<') && !xml.endsWith('>'))) {
        return { querySelector(sel) { return sel === 'parsererror' ? {} : null; }, querySelectorAll() { return []; } };
      }
      function parseAttributes(attrStr) {
        const attrs = {};
        const regex = /([a-zA-Z0-9_:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
        let match;
        while ((match = regex.exec(attrStr)) !== null) {
          attrs[match[1]] = match[2] !== undefined ? match[2] : match[3];
        }
        return attrs;
      }
      function createNode(tag, attrStr, content) {
        const attrs = parseAttributes(attrStr);
        return {
          tagName: tag,
          textContent: content.replace(/<[^>]+>/g, ''),
          getAttribute(name) { return attrs[name] !== undefined ? attrs[name] : null; },
          hasAttribute(name) { return attrs[name] !== undefined; },
          querySelectorAll(sel) {
            if (sel === 's') {
              const sNodes = [];
              const sRegex = /<s(?:\s+[^>]*)?>([\s\S]*?)<\/s>/gi;
              let sMatch;
              while ((sMatch = sRegex.exec(content)) !== null) {
                sNodes.push({ textContent: sMatch[1].replace(/<[^>]+>/g, '') });
              }
              return sNodes;
            }
            return [];
          }
        };
      }
      return {
        querySelector() { return null; },
        querySelectorAll(selector) {
          const results = [];
          if (selector === 'text') {
            const regex = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
            let m;
            while ((m = regex.exec(xml)) !== null) results.push(createNode('text', m[1], m[2]));
          } else if (selector === 'p[t], p[start]') {
            const regex = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
            let m;
            while ((m = regex.exec(xml)) !== null) {
              const node = createNode('p', m[1], m[2]);
              if (node.hasAttribute('t') || node.hasAttribute('start')) results.push(node);
            }
          }
          return results;
        }
      };
    }
  };
}

// ---------------------------------------------------------------------------
// Suite 1: Parser unit tests (Requirements 1-10)
// ---------------------------------------------------------------------------
{
  const context = { globalThis: {}, console, DOMParser: createMockDOMParser() };
  vm.createContext(context);
  vm.runInContext(parserSource, context, { filename: 'content/caption-parser.js' });
  const parser = context.globalThis.HoverNotesCaptionParser;

  // 1. Standard JSON3 with multiple events
  const json3 = {
    events: [
      { tStartMs: 0, dDurationMs: 1500, segs: [{ utf8: 'Cue 1' }] },
      { tStartMs: 1500, dDurationMs: 2000, segs: [{ utf8: 'Cue 2' }] }
    ]
  };
  const cues1 = parser.parseJson3TimedText(json3);
  assert.equal(cues1.length, 2, 'Req 1: Standard JSON3 with multiple events');
  assert.equal(cues1[0].text, 'Cue 1');
  assert.equal(cues1[1].text, 'Cue 2');

  // 2. JSON3 with multiple segments per event
  const multiSeg = {
    events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'Segment A ' }, { utf8: 'Segment B' }] }]
  };
  const cues2 = parser.parseJson3TimedText(multiSeg);
  assert.equal(cues2.length, 1, 'Req 2: Multiple segments per event');
  assert.equal(cues2[0].text, 'Segment A Segment B');

  // 3. Legacy XML timed text
  const legacyXml = '<transcript><text start="0.5" dur="1.5">Legacy cue</text></transcript>';
  const cues3 = parser.parseXmlTimedText(legacyXml);
  assert.equal(cues3.length, 1, 'Req 3: Legacy XML timed text');
  assert.equal(cues3[0].text, 'Legacy cue');
  assert.equal(cues3[0].start, 0.5);

  // 4. SRV3 XML timed text
  const srv3Xml = '<timedtext format="3"><body><p t="1000" d="2000"><s>SRV3 </s><s>cue</s></p></body></timedtext>';
  const cues4 = parser.parseXmlTimedText(srv3Xml);
  assert.equal(cues4.length, 1, 'Req 4: SRV3 XML timed text');
  assert.equal(cues4[0].text, 'SRV3 cue');
  assert.equal(cues4[0].start, 1.0);

  // 5. WebVTT format adapter
  const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nWebVTT cue';
  const cues5 = parser.parseVttTimedText(vtt);
  assert.equal(cues5.length, 1, 'Req 5: WebVTT format adapter');
  assert.equal(cues5[0].text, 'WebVTT cue');

  // 6. Valid JSON with an unknown schema
  const unknownJson = JSON.stringify({ customFormat: true, data: [{ word: 'test' }] });
  const parseRes6 = parser.parseCaptionResponse(unknownJson, { format: 'default', contentType: 'application/json' });
  assert.equal(parseRes6.cues.length, 0, 'Req 6: Valid JSON with unknown schema yields 0 cues');
  assert.equal(parseRes6.error, 'Unsupported YouTube caption JSON schema');
  assert.ok(parseRes6.diagnostics, 'Safe diagnostics present');
  assert.ok(parseRes6.diagnostics.topLevelKeys.includes('customFormat'));

  // 7. Malformed JSON
  const malformed = '{"events": [ { tStartMs: broken';
  const parseRes7 = parser.parseCaptionResponse(malformed, { format: 'json3', contentType: 'application/json' });
  assert.equal(parseRes7.cues.length, 0, 'Req 7: Malformed JSON handled safely');
  assert.equal(parseRes7.error, 'Malformed JSON caption response');

  // 8. Empty response
  const parseRes8 = parser.parseCaptionResponse('', { format: 'json3' });
  assert.equal(parseRes8.cues.length, 0, 'Req 8: Empty response handled safely');
  assert.equal(parseRes8.error, 'Empty caption response body');

  // 9. Invalid or negative timestamps
  const invalidTimeJson = {
    events: [
      { tStartMs: -500, dDurationMs: 1000, segs: [{ utf8: 'Negative start' }] },
      { tStartMs: 500, dDurationMs: -100, segs: [{ utf8: 'Negative duration' }] },
      { tStartMs: NaN, dDurationMs: 500, segs: [{ utf8: 'NaN time' }] },
      { tStartMs: 1000, dDurationMs: 1000, segs: [{ utf8: 'Valid' }] }
    ]
  };
  const cues9 = parser.parseJson3TimedText(invalidTimeJson);
  assert.equal(cues9.length, 1, 'Req 9: Invalid/negative timestamps filtered out');
  assert.equal(cues9[0].text, 'Valid');

  // 10. Out-of-order cues
  const outOfOrder = {
    events: [
      { tStartMs: 3000, dDurationMs: 1000, segs: [{ utf8: 'Last' }] },
      { tStartMs: 1000, dDurationMs: 1000, segs: [{ utf8: 'First' }] }
    ]
  };
  const cues10 = parser.parseJson3TimedText(outOfOrder);
  assert.equal(cues10.length, 2, 'Req 10: Out-of-order cues sorted chronologically');
  assert.equal(cues10[0].text, 'First');
  assert.equal(cues10[1].text, 'Last');
}

// ---------------------------------------------------------------------------
// Suite 2: Bridge, Chunking & Cache Regression (Requirements 11-13)
// ---------------------------------------------------------------------------
async function runSuite2() {
  const listeners = {};
  const emitted = [];
  const videoId = 'testBridgeVideo';

  const captionTrack = {
    languageCode: 'hi', kind: 'asr', vssId: 'a.hi',
    name: { simpleText: 'Hindi' },
    baseUrl: `https://www.youtube.com/api/timedtext?v=${videoId}&lang=hi`
  };

  const player = {
    getPlayerResponse() { return { captions: { playerCaptionsTracklistRenderer: { captionTracks: [captionTrack] } } }; },
    getOption(group, key) { if (group === 'captions' && key === 'tracklist') return [captionTrack]; return null; },
    setOption() {},
    loadModule() {}
  };

  const windowMock = {
    location: { href: `https://www.youtube.com/watch?v=${videoId}`, origin: 'https://www.youtube.com' },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    postMessage(data, origin) {
      assert.equal(origin, this.location.origin);
      emitted.push(data);
      for (const fn of listeners.message || []) fn({ source: windowMock, origin: this.location.origin, data });
    },
    fetch: async (url) => {
      return {
        status: 200,
        headers: { get: () => 'application/json; charset=UTF-8' },
        clone() { return { text: async () => '{"events":[]}' }; }
      };
    }
  };

  const mainContext = {
    window: windowMock,
    document: { getElementById: (id) => id === 'movie_player' ? player : null, querySelector: () => null },
    location: windowMock.location,
    URL, Promise, Reflect, Object, String, Number, Date,
    setTimeout, clearTimeout,
    console: { info() {}, warn() {}, error() {} }
  };
  vm.createContext(mainContext);
  vm.runInContext(mainSource, mainContext, { filename: 'content/youtube-main.js' });

  // 11. Preservation of `fmt` metadata across the MAIN-world bridge
  await windowMock.fetch(`https://www.youtube.com/api/timedtext?v=${videoId}&lang=hi&fmt=json3`);
  await new Promise(r => setTimeout(r, 10));
  const json3Msg = emitted.find(m => m.type === 'CAPTION_BODY' && m.format === 'json3');
  assert.ok(json3Msg, 'Req 11: format fmt=json3 must be preserved across bridge');
  assert.equal(json3Msg.format, 'json3');

  await windowMock.fetch(`https://www.youtube.com/api/timedtext?v=${videoId}&lang=hi&fmt=srv3`);
  await new Promise(r => setTimeout(r, 10));
  const srv3Msg = emitted.find(m => m.type === 'CAPTION_BODY' && m.format === 'srv3');
  assert.ok(srv3Msg, 'Req 11: format fmt=srv3 must be preserved across bridge');
  assert.equal(srv3Msg.format, 'srv3');

  // 11b. Request URL with no fmt parameter: must NOT assume or force 'default'
  await windowMock.fetch(`https://www.youtube.com/api/timedtext?v=${videoId}&lang=hi`);
  await new Promise(r => setTimeout(r, 10));
  const noFmtMsg = emitted.filter(m => m.type === 'CAPTION_BODY').at(-1);
  assert.ok(noFmtMsg, 'URL without fmt must be observed');
  assert.equal(noFmtMsg.format, '', 'Absent fmt must remain empty string and not convert to default');

  // 13. Elimination of unsafe raw response reuse: REQUEST_CAPTION_BODY must NOT replay unvalidated raw responses from cache
  const beforeCount = emitted.length;
  for (const fn of listeners.message || []) {
    fn({ source: windowMock, origin: windowMock.location.origin, data: {
      source: '__HOVERNOTES_ISOLATED__', type: 'REQUEST_CAPTION_BODY',
      videoId, languageCode: 'hi', vssId: 'a.hi', format: 'srv3'
    }});
  }
  const srv3Replayed = emitted.slice(beforeCount).find(m => m.type === 'CAPTION_BODY');
  assert.strictEqual(srv3Replayed, undefined, 'Req 13: unvalidated raw response must not be replayed from cache');
  const srv3Activation = emitted.slice(beforeCount).find(m => m.type === 'CAPTION_ACTIVATION');
  assert.ok(srv3Activation, 'Req 13: track activation must be performed on player');
}

// ---------------------------------------------------------------------------
// Suite 3A: Content Script - Exact Zero Cues Failure (Req 12, 14, 15)
// ---------------------------------------------------------------------------
async function runSuite3A() {
  const contentListeners = {};
  const outgoingMessages = [];
  let runtimeListener = null;
  const failureVideoId = '2o2vX0ZqQ_Y';

  const windowObj = {
    __hoverNotesLoaded: false,
    location: { href: `https://www.youtube.com/watch?v=${failureVideoId}`, origin: 'https://www.youtube.com' },
    addEventListener(type, fn) { (contentListeners[type] ||= []).push(fn); },
    postMessage(data, targetOrigin) {
      assert.equal(targetOrigin, this.location.origin);
      outgoingMessages.push(data);
    },
    dispatchEvent() {},
    devicePixelRatio: 1
  };
  const docObj = {
    title: 'GATE Course - YouTube',
    documentElement: {},
    activeElement: null,
    querySelector() { return null; },
    getElementById() { return null; },
    createElement(tag) {
      let value = '';
      return { set innerHTML(v) { value = String(v); }, get value() { return value; } };
    }
  };
  const chromeObj = { runtime: { onMessage: { addListener(fn) { runtimeListener = fn; } } } };
  class MockMutationObserver { constructor(fn) { this.fn = fn; } observe() {} }

  const errorLogs = [];
  const contentCtx = {
    window: windowObj, document: docObj, chrome: chromeObj, URL, Map, Set, Promise, Number, String, Boolean, Math, Date,
    MutationObserver: MockMutationObserver, setTimeout, clearTimeout,
    DOMParser: createMockDOMParser(),
    console: {
      info: () => {},
      warn: () => {},
      error: (...args) => errorLogs.push(args)
    }
  };
  vm.createContext(contentCtx);
  vm.runInContext(parserSource, contentCtx, { filename: 'content/caption-parser.js' });
  vm.runInContext(contentSource, contentCtx, { filename: 'content/content.js' });

  function deliverMain(data) {
    for (const fn of contentListeners.message || []) {
      fn({ source: windowObj, origin: windowObj.location.origin, data: { source: '__HOVERNOTES_MAIN__', ...data } });
    }
  }

  // 14. The exact zero-cues failure path
  // User recorded: videoId: 2o2vX0ZqQ_Y, languageCode: hi, responseCharacters: 2197161, contentType: application/json; charset=UTF-8, transport: xhr
  const simulatedUnknownJson = JSON.stringify({
    responseContext: { visitorData: 'mock-visitor' },
    unsupportedRoot: { items: new Array(100).fill({ id: 'dummy', val: 'no_cues' }) }
  });
  const paddingNeeded = 2_197_161 - simulatedUnknownJson.length;
  const unknownLargeJson = JSON.stringify({
    responseContext: { visitorData: 'mock-visitor' },
    unsupportedRoot: { items: new Array(100).fill({ id: 'dummy' }) },
    padding: 'x'.repeat(Math.max(0, paddingNeeded - 20))
  });

  // Provide caption tracks
  deliverMain({
    type: 'CAPTION_TRACKS',
    videoId: failureVideoId,
    tracks: [{ languageCode: 'hi', kind: 'asr', vssId: 'a.hi', name: 'Hindi' }]
  });

  const responsePromise = new Promise(resolve => {
    runtimeListener({
      action: 'GET_TRANSCRIPT_SLICE',
      payload: { startTime: 0, endTime: 60 }
    }, {}, resolve);
  });

  // Wait for REQUEST_CAPTION_BODY
  for (let i = 0; i < 50 && !outgoingMessages.some(m => m.type === 'REQUEST_CAPTION_BODY'); i++) {
    await new Promise(r => setTimeout(r, 5));
  }
  const req1 = outgoingMessages.find(m => m.type === 'REQUEST_CAPTION_BODY');
  assert.ok(req1, 'Player captions must be requested');

  // 12. Chunked transfer with metadata preservation
  const chunkSize = 192 * 1024;
  const totalChunks = Math.ceil(unknownLargeJson.length / chunkSize);
  const transferId = 'transfer-unknown-schema';
  deliverMain({
    type: 'CAPTION_BODY_START',
    requestId: req1.requestId,
    vssId: req1.vssId,
    videoId: failureVideoId,
    languageCode: 'hi',
    format: '', // absent fmt parameter
    transferId,
    status: 200,
    contentType: 'application/json; charset=UTF-8',
    transport: 'xhr',
    responseCharacters: unknownLargeJson.length,
    totalChunks
  });

  for (let index = 0; index < totalChunks; index++) {
    deliverMain({
      type: 'CAPTION_BODY_CHUNK',
      transferId,
      index,
      chunk: unknownLargeJson.slice(index * chunkSize, (index + 1) * chunkSize)
    });
  }

  // Attempt 1 produces zero cues, so content script triggers exactly one fresh retry with forceReactivation
  for (let i = 0; i < 50 && outgoingMessages.filter(m => m.type === 'REQUEST_CAPTION_BODY').length < 2; i++) {
    await new Promise(r => setTimeout(r, 5));
  }
  const retryReq = outgoingMessages.filter(m => m.type === 'REQUEST_CAPTION_BODY')[1];
  assert.ok(retryReq, 'Attempt 2 retry must be requested on zero cues');
  assert.equal(retryReq.forceReactivation, true, 'Retry must set forceReactivation: true');
  assert.notEqual(retryReq.requestId, outgoingMessages[0].requestId, 'Retry must use a new distinct requestId');

  // Deliver attempt 2 response with matching requestId (also zero cues to test zero-cue failure handling)
  deliverMain({
    type: 'CAPTION_BODY',
    requestId: retryReq.requestId,
    videoId: failureVideoId,
    languageCode: 'hi',
    format: '',
    status: 200,
    contentType: 'application/json; charset=UTF-8',
    transport: 'xhr',
    body: unknownLargeJson,
    responseCharacters: unknownLargeJson.length
  });

  const sliceResult = await responsePromise;
  assert.equal(sliceResult.success, true);
  assert.equal(sliceResult.itemCount, 0, 'Zero cues must be returned for unsupported schema');
  assert.equal(sliceResult.lines.length, 0);
  assert.equal(sliceResult.transcriptText, '');

  // 14 & safe diagnostic checks
  assert.ok(sliceResult.diagnostic.includes('Unsupported YouTube caption JSON schema'), 'Must diagnose unsupported JSON schema');
  assert.ok(sliceResult.diagnostic.includes('fmt=absent (unspecified)'), 'Must distinguish absent fmt from explicit format');
  assert.ok(!sliceResult.diagnostic.includes('empty'), 'Must NOT report empty response when 2.19M chars captured');
  assert.ok(sliceResult.diagnostic.includes('responseContext'), 'Safe diagnostics must identify top keys');

  // Verify safe error logging
  const schemaError = errorLogs.find(args => args[0] === '[HoverNotes Captions] Unsupported YouTube caption JSON schema');
  assert.ok(schemaError, 'Safe schema diagnostic error must be logged');
  assert.equal(schemaError[1].contentType, 'application/json; charset=UTF-8');
  assert.equal(schemaError[1].format, 'absent');
  assert.equal(schemaError[1].transport, 'xhr');
  assert.ok(!JSON.stringify(errorLogs).includes('no_cues'), 'No text content leaked to logs');

  // 15. Confirmation that zero cues do not advance progress or enter transcriptCache
  assert.equal(sliceResult.performance.fullCueCount, 0, 'transcriptCache cue count must remain 0');
}

// ---------------------------------------------------------------------------
// Suite 3B: Large-Body Transfer (Req 16 - ~2,197,161 chars)
// ---------------------------------------------------------------------------
async function runSuite3B() {
  const contentListeners = {};
  const outgoingMessages = [];
  let runtimeListener = null;
  const validVideoId = 'validLargeVideo123';

  const windowObj = {
    __hoverNotesLoaded: false,
    location: { href: `https://www.youtube.com/watch?v=${validVideoId}`, origin: 'https://www.youtube.com' },
    addEventListener(type, fn) { (contentListeners[type] ||= []).push(fn); },
    postMessage(data, targetOrigin) {
      assert.equal(targetOrigin, this.location.origin);
      outgoingMessages.push(data);
    },
    dispatchEvent() {},
    devicePixelRatio: 1
  };
  const docObj = {
    title: 'Large Video - YouTube',
    documentElement: {},
    activeElement: null,
    querySelector() { return null; },
    getElementById() { return null; },
    createElement(tag) {
      let value = '';
      return { set innerHTML(v) { value = String(v); }, get value() { return value; } };
    }
  };
  const chromeObj = { runtime: { onMessage: { addListener(fn) { runtimeListener = fn; } } } };
  class MockMutationObserver { constructor(fn) { this.fn = fn; } observe() {} }

  const contentCtx = {
    window: windowObj, document: docObj, chrome: chromeObj, URL, Map, Set, Promise, Number, String, Boolean, Math, Date,
    MutationObserver: MockMutationObserver, setTimeout, clearTimeout,
    DOMParser: createMockDOMParser(),
    console: { info: () => {}, warn: () => {}, error: () => {} }
  };
  vm.createContext(contentCtx);
  vm.runInContext(parserSource, contentCtx, { filename: 'content/caption-parser.js' });
  vm.runInContext(contentSource, contentCtx, { filename: 'content/content.js' });

  function deliverMain(data) {
    for (const fn of contentListeners.message || []) {
      fn({ source: windowObj, origin: windowObj.location.origin, data: { source: '__HOVERNOTES_MAIN__', ...data } });
    }
  }

  deliverMain({
    type: 'CAPTION_TRACKS',
    videoId: validVideoId,
    tracks: [{ languageCode: 'hi', kind: 'asr', vssId: 'a.hi', name: 'Hindi' }]
  });

  const validResponsePromise = new Promise(resolve => {
    runtimeListener({
      action: 'GET_TRANSCRIPT_SLICE',
      payload: { startTime: 0, endTime: 120 }
    }, {}, resolve);
  });

  for (let i = 0; i < 50 && !outgoingMessages.some(m => m.type === 'REQUEST_CAPTION_BODY'); i++) {
    await new Promise(r => setTimeout(r, 5));
  }
  const validReq = outgoingMessages.find(m => m.type === 'REQUEST_CAPTION_BODY');
  assert.ok(validReq, 'Must request caption body');

  // Approximate the observed 2,197,161 characters with valid JSON3
  const repeatWord = 'नमस्कार ';
  const wordRepetitions = Math.floor(2_190_000 / repeatWord.length);
  const largeJson3 = JSON.stringify({
    events: [
      { tStartMs: 0, dDurationMs: 60000, segs: [{ utf8: repeatWord.repeat(wordRepetitions) }] },
      { tStartMs: 60000, dDurationMs: 60000, segs: [{ utf8: 'Second valid cue' }] }
    ]
  });

  const chunkSize = 192 * 1024;
  const validTotalChunks = Math.ceil(largeJson3.length / chunkSize);
  const validTransferId = 'transfer-valid-large';
  deliverMain({
    type: 'CAPTION_BODY_START',
    requestId: validReq.requestId,
    vssId: validReq.vssId,
    videoId: validVideoId,
    languageCode: 'hi',
    format: 'json3',
    transferId: validTransferId,
    status: 200,
    contentType: 'application/json; charset=UTF-8',
    transport: 'xhr',
    responseCharacters: largeJson3.length,
    totalChunks: validTotalChunks
  });

  for (let index = 0; index < validTotalChunks; index++) {
    deliverMain({
      type: 'CAPTION_BODY_CHUNK',
      transferId: validTransferId,
      index,
      chunk: largeJson3.slice(index * chunkSize, (index + 1) * chunkSize)
    });
  }

  const validSliceRes = await validResponsePromise;
  assert.equal(validSliceRes.success, true);
  assert.equal(validSliceRes.itemCount, 2, 'Large valid JSON3 payload must be successfully parsed into cues');
  assert.equal(validSliceRes.lines[0].startsWith('[00:00] '), true);
  assert.equal(validSliceRes.lines[1].startsWith('[01:00] '), true);
}

(async () => {
  await runSuite2();
  await runSuite3A();
  await runSuite3B();
  console.log('PASS: All 15 caption regression requirements + 2,197,161-character large body transfer passed.');
})().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
