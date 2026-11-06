/**
 * Tests for v1.0.28: Caption Ingestion Lifecycle, Track Selection,
 * Correlation by Request ID, Cache Safety, Controlled Retry,
 * JSON3 Parser Behavioral Matrix, and Full-Pass Census.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const parserSource = fs.readFileSync(path.join(__dirname, '../content/caption-parser.js'), 'utf8');
const mainSource = fs.readFileSync(path.join(__dirname, '../content/youtube-main.js'), 'utf8');
const contentSource = fs.readFileSync(path.join(__dirname, '../content/content.js'), 'utf8');

function createParser() {
  const sandbox = { globalThis: {}, console };
  vm.createContext(sandbox);
  vm.runInContext(parserSource, sandbox);
  return sandbox.globalThis.HoverNotesCaptionParser;
}

test('JSON3 Parser Behavioral Matrix', async (t) => {
  const parser = createParser();

  await t.test('1. Normal events with utf8 segments', () => {
    const json = {
      events: [
        { tStartMs: 1000, dDurationMs: 2500, segs: [{ utf8: 'Hello world' }] },
        { tStartMs: 3500, dDurationMs: 2000, segs: [{ utf8: 'Second cue' }] }
      ]
    };
    const cues = parser.parseJson3TimedText(json);
    assert.equal(cues.length, 2);
    assert.equal(cues[0].start, 1);
    assert.equal(cues[0].duration, 2.5);
    assert.equal(cues[0].text, 'Hello world');
    assert.equal(cues[1].start, 3.5);
  });

  await t.test('2. Control events without segs are ignored without error', () => {
    const json = {
      events: [
        { tStartMs: 0, dDurationMs: 1000, id: 1, wpWinPosId: 1 }, // window / style control event
        { tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: 'Actual text' }] },
        { tStartMs: 3000, id: 2 } // another control event
      ]
    };
    const cues = parser.parseJson3TimedText(json);
    assert.equal(cues.length, 1);
    assert.equal(cues[0].text, 'Actual text');
  });

  await t.test('3. Mixed shapes and multiple segments in one event', () => {
    const json = {
      events: [
        {
          tStartMs: 2000,
          dDurationMs: 3000,
          segs: [
            { utf8: 'First part ' },
            { utf8: 'and second part.' }
          ]
        }
      ]
    };
    const cues = parser.parseJson3TimedText(json);
    assert.equal(cues.length, 1);
    assert.equal(cues[0].text, 'First part and second part.');
  });

  await t.test('4. Whitespace-only segments are trimmed and ignored', () => {
    const json = {
      events: [
        { tStartMs: 1000, dDurationMs: 1000, segs: [{ utf8: '   \n  \t ' }] },
        { tStartMs: 2000, dDurationMs: 1000, segs: [{ utf8: 'Valid cue' }] }
      ]
    };
    const cues = parser.parseJson3TimedText(json);
    assert.equal(cues.length, 1);
    assert.equal(cues[0].text, 'Valid cue');
  });

  await t.test('5. Hindi Unicode text is preserved without mojibake', () => {
    const hindiText = 'नमस्कार दोस्तों, इस ट्यूटोरियल में आपका स्वागत है।';
    const json = {
      events: [
        { tStartMs: 0, dDurationMs: 4000, segs: [{ utf8: hindiText }] }
      ]
    };
    const cues = parser.parseJson3TimedText(json);
    assert.equal(cues.length, 1);
    assert.equal(cues[0].text, hindiText);
  });

  await t.test('6. HTML entities are unescaped (&amp;, &lt;, &gt;, &quot;, &#39;)', () => {
    const json = {
      events: [
        { tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: 'Tom &amp; Jerry &lt;3 &quot;cartoons&#39; &gt;' }] }
      ]
    };
    const cues = parser.parseJson3TimedText(json);
    assert.equal(cues.length, 1);
    assert.equal(cues[0].text, `Tom & Jerry <3 "cartoons' >`);
  });

  await t.test('7. Missing or invalid duration defaults to fallback without NaN', () => {
    const json = {
      events: [
        { tStartMs: 5000, segs: [{ utf8: 'No duration specified' }] },
        { tStartMs: 8000, dDurationMs: 0, segs: [{ utf8: 'Zero duration' }] },
        { tStartMs: 9000, dDurationMs: -50, segs: [{ utf8: 'Invalid negative' }] } // skipped
      ]
    };
    const cues = parser.parseJson3TimedText(json);
    assert.equal(cues.length, 2);
    assert.equal(cues[0].duration, 0);
    assert.equal(Number.isFinite(cues[0].duration), true);
    assert.equal(cues[1].duration, 0);
  });

  await t.test('8. Out-of-order events: sorted chronologically by start', () => {
    const json = {
      events: [
        { tStartMs: 8000, dDurationMs: 2000, segs: [{ utf8: 'Later cue' }] },
        { tStartMs: 2000, dDurationMs: 2000, segs: [{ utf8: 'Earlier cue' }] }
      ]
    };
    const cues = parser.parseJson3TimedText(json);
    assert.equal(cues.length, 2);
    assert.equal(cues[0].start, 2);
    assert.equal(cues[0].text, 'Earlier cue');
    assert.equal(cues[1].start, 8);
    assert.equal(cues[1].text, 'Later cue');
  });

  await t.test('9. utf16 and text property fallback', () => {
    const json = {
      events: [
        { tStartMs: 1000, dDurationMs: 1000, segs: [{ utf16: 'UTF-16 text' }] },
        { tStartMs: 2000, dDurationMs: 1000, segs: [{ text: 'Plain text prop' }] }
      ]
    };
    const cues = parser.parseJson3TimedText(json);
    assert.equal(cues.length, 2);
    assert.equal(cues[0].text, 'UTF-16 text');
    assert.equal(cues[1].text, 'Plain text prop');
  });
});

test('Full-Pass JSON3 Census Verification', async (t) => {
  const parser = createParser();

  await t.test('Computes accurate full-pass metrics on synthetic multi-event fixtures', () => {
    const events = [
      { tStartMs: 0, dDurationMs: 1000, id: 1 }, // control event, no segs
      { tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: 'short' }] }, // 5 chars
      { tStartMs: 3000, dDurationMs: 2500, segs: [{ utf8: 'medium length text' }] }, // 18 chars
      { tStartMs: 5500, dDurationMs: 3000, segs: [{ utf8: 'a very long sentence containing many words for percentile testing' }] }, // 65 chars
      { tStartMs: 8500, dDurationMs: 1000, segs: [{ utf8: '   ' }] } // whitespace only (0 non-whitespace)
    ];

    const census = parser.performFullPassJson3Census(events);
    assert.equal(census.totalEvents, 5);
    assert.equal(census.eventsWithNonEmptySegs, 4);
    assert.equal(census.eventsMissingSegs, 1);
    assert.equal(census.totalSegments, 4);
    assert.equal(census.utf8.present, 4);
    assert.equal(census.utf8.nonWhitespaceCount, 3);
    assert.equal(census.firstUsableTextEventIndex, 1);
    assert.equal(census.firstUsableTextSegmentIndex, 0);
    assert.ok(census.totalNonWhitespaceChars > 80);
    assert.equal(census.timestampValidity.validStart, 5);
    assert.equal(census.timestampValidity.validDuration, 5);

    // Percentiles
    assert.equal(census.textLengths.min, 5);
    assert.equal(census.textLengths.max, 65);
    assert.ok(census.textLengths.p50 >= 5);
  });

  await t.test('Census correctly reports 0 usable text on control-only events', () => {
    const events = new Array(50).fill(null).map((_, i) => ({
      tStartMs: i * 1000,
      dDurationMs: 1000,
      id: i,
      wpWinPosId: 1
    }));
    const census = parser.performFullPassJson3Census(events);
    assert.equal(census.totalEvents, 50);
    assert.equal(census.eventsWithNonEmptySegs, 0);
    assert.equal(census.eventsMissingSegs, 50);
    assert.equal(census.firstUsableTextEventIndex, null);
    assert.equal(census.totalNonWhitespaceChars, 0);
  });
});

test('Track Selection Logic in MAIN-World youtube-main.js', async (t) => {
  function setupMainWorld() {
    const emitted = [];
    const listeners = {};
    const setOptionCalls = [];

    const mockPlayer = {
      getOption: (module, opt) => {
        if (module === 'captions' && opt === 'tracklist') {
          return [
            { languageCode: 'hi', kind: 'asr', vssId: 'a.hi', name: 'Hindi (auto)' },
            { languageCode: 'hi', vssId: '.hi', name: 'Hindi (manual)' },
            { languageCode: 'en', vssId: '.en', name: 'English' }
          ];
        }
        return [];
      },
      setOption: (module, opt, value) => {
        setOptionCalls.push({ module, opt, value });
      },
      loadModule: () => {}
    };

    const windowMock = {
      location: { origin: 'https://www.youtube.com' },
      addEventListener: (evt, fn) => { (listeners[evt] ||= []).push(fn); },
      postMessage: (data) => { emitted.push(data); },
      fetch: async () => ({ status: 200, headers: { get: () => 'application/json' }, clone: () => ({ text: async () => '{}' }) })
    };

    const ctx = {
      window: windowMock,
      document: { getElementById: (id) => id === 'movie_player' ? mockPlayer : null, querySelector: () => null },
      location: windowMock.location,
      URL, Promise, Reflect, Object, String, Number, Date,
      setTimeout,
      clearTimeout,
      console: { info() {}, warn() {}, error() {} }
    };
    vm.createContext(ctx);
    vm.runInContext(mainSource, ctx, { filename: 'content/youtube-main.js' });

    function postInbound(data) {
      for (const fn of listeners.message || []) {
        fn({ source: windowMock, origin: windowMock.location.origin, data: { source: '__HOVERNOTES_ISOLATED__', ...data } });
      }
    }

    return { emitted, setOptionCalls, postInbound, mockPlayer };
  }

  await t.test('1. Exact vssId is selected when provided (a.hi over .hi)', () => {
    const { emitted, setOptionCalls, postInbound } = setupMainWorld();
    postInbound({
      type: 'REQUEST_CAPTION_BODY',
      requestId: 'req-exact-vss',
      videoId: 'testVid1',
      languageCode: 'hi',
      vssId: 'a.hi'
    });

    const act = emitted.find(m => m.type === 'CAPTION_ACTIVATION' && m.requestId === 'req-exact-vss');
    assert.ok(act, 'Activation message emitted');
    assert.equal(act.ok, true);
    assert.equal(act.vssId, 'a.hi', 'Must select exact vssId a.hi');
    const setTrack = setOptionCalls.find(c => c.opt === 'track');
    assert.equal(setTrack.value.vssId, 'a.hi');
  });

  await t.test('2. Missing explicit vssId fails closed without falling back to same-language track', () => {
    const { emitted, postInbound } = setupMainWorld();
    postInbound({
      type: 'REQUEST_CAPTION_BODY',
      requestId: 'req-missing-vss',
      videoId: 'testVid1',
      languageCode: 'hi',
      vssId: 'nonexistent.vss.id'
    });

    const act = emitted.find(m => m.type === 'CAPTION_ACTIVATION' && m.requestId === 'req-missing-vss');
    assert.ok(act);
    assert.equal(act.ok, false, 'Must fail closed when explicit vssId is not found');
    assert.ok(act.reason.includes('nonexistent.vss.id'));
  });

  await t.test('3. Fallback when no vssId provided chooses manual over ASR', () => {
    const { emitted, setOptionCalls, postInbound } = setupMainWorld();
    postInbound({
      type: 'REQUEST_CAPTION_BODY',
      requestId: 'req-no-vss',
      videoId: 'testVid1',
      languageCode: 'hi',
      vssId: ''
    });

    const act = emitted.find(m => m.type === 'CAPTION_ACTIVATION' && m.requestId === 'req-no-vss');
    assert.ok(act);
    assert.equal(act.ok, true);
    assert.equal(act.vssId, '.hi', 'Fallback must prefer manual track (.hi) over ASR (a.hi)');
  });

  await t.test('4. Force reactivation toggles track off then on', async () => {
    const { setOptionCalls, postInbound } = setupMainWorld();
    postInbound({
      type: 'REQUEST_CAPTION_BODY',
      requestId: 'req-reactivate',
      videoId: 'testVid1',
      languageCode: 'hi',
      vssId: 'a.hi',
      forceReactivation: true
    });

    // Wait for the 50ms setTimeout in youtube-main.js
    await new Promise(r => setTimeout(r, 70));

    const tracksSet = setOptionCalls.filter(c => c.opt === 'track');
    assert.ok(tracksSet.length >= 2, 'Should set empty track then target track');
    assert.equal(Object.keys(tracksSet[0].value).length, 0, 'First setOption must clear track');
    assert.equal(tracksSet[1].value.vssId, 'a.hi', 'Second setOption must set target track');
  });
});

test('Request Correlation & Cache Safety in Isolated Script', async (t) => {
  function setupIsolated(targetVid = 'corrVid') {
    const outgoingMessages = [];
    const listeners = {};
    let runtimeListener = null;

    const testHooks = {};
    const windowObj = {
      __hoverNotesLoaded: false,
      __HOVERNOTES_CONTENT_TEST_HOOKS__: testHooks,
      location: { href: `https://www.youtube.com/watch?v=${targetVid}`, origin: 'https://www.youtube.com' },
      addEventListener(evt, fn) { (listeners[evt] ||= []).push(fn); },
      postMessage(data, targetOrigin) {
        assert.equal(targetOrigin, this.location.origin);
        outgoingMessages.push(data);
      },
      dispatchEvent() {},
      devicePixelRatio: 1
    };
    const docObj = {
      title: 'Test - YouTube',
      documentElement: {},
      activeElement: null,
      querySelector() { return null; },
      getElementById() { return null; },
      createElement(tag) {
        let value = '';
        return {
          set innerHTML(v) { value = String(v); },
          get value() { return value; }
        };
      }
    };
    const chromeObj = { runtime: { onMessage: { addListener(fn) { runtimeListener = fn; } } } };

    const ctx = {
      window: windowObj, document: docObj, chrome: chromeObj, URL, Map, Set, Promise, Number, String, Boolean, Math, Date,
      setTimeout, clearTimeout,
      MutationObserver: class { observe() {} },
      DOMParser: class {
        parseFromString() {
          return { querySelector: () => null, querySelectorAll: () => [] };
        }
      },
      console: { info() {}, warn() {}, error() {} }
    };
    ctx.globalThis = ctx;
    ctx.window.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(parserSource, ctx, { filename: 'content/caption-parser.js' });
    vm.runInContext(contentSource, ctx, { filename: 'content/content.js' });

    function deliverMain(data) {
      for (const fn of listeners.message || []) {
        fn({ source: windowObj, origin: windowObj.location.origin, data: { source: '__HOVERNOTES_MAIN__', ...data } });
      }
    }

    return { outgoingMessages, runtimeListener, deliverMain, testHooks };
  }

  await t.test('1. Parsed cues are isolated in transcriptCache by trackKey', async () => {
    const { outgoingMessages, runtimeListener, deliverMain } = setupIsolated('corrVid');

    // Setup 2 tracks
    deliverMain({
      type: 'CAPTION_TRACKS',
      videoId: 'corrVid',
      tracks: [
        { languageCode: 'hi', kind: 'asr', vssId: 'a.hi', name: 'Hindi (auto)' },
        { languageCode: 'hi', vssId: '.hi', name: 'Hindi (manual)' }
      ]
    });

    // Request transcript slice
    const slicePromise = new Promise(resolve => {
      runtimeListener({ action: 'GET_TRANSCRIPT_SLICE', payload: { startTime: 0, endTime: 60 } }, {}, resolve);
    });

    // Wait for REQUEST_CAPTION_BODY
    await new Promise(r => setTimeout(r, 10));
    const req1 = outgoingMessages.find(m => m.type === 'REQUEST_CAPTION_BODY');
    assert.ok(req1);

    // Deliver valid JSON3 for this request
    const validJson3 = JSON.stringify({
      events: [{ tStartMs: 0, dDurationMs: 5000, segs: [{ utf8: 'Hindi manual cue' }] }]
    });

    deliverMain({
      type: 'CAPTION_BODY',
      requestId: req1.requestId,
      vssId: req1.vssId,
      videoId: 'corrVid',
      languageCode: 'hi',
      format: 'json3',
      status: 200,
      contentType: 'application/json',
      body: validJson3,
      responseCharacters: validJson3.length
    });

    const res = await slicePromise;
    assert.equal(res.success, true);
    assert.equal(res.itemCount, 1);
    assert.ok(res.transcriptText.includes('Hindi manual cue'));

    // Second slice request on same video/track must hit transcriptCache
    const slice2 = await new Promise(resolve => {
      runtimeListener({ action: 'GET_TRANSCRIPT_SLICE', payload: { startTime: 0, endTime: 60 } }, {}, resolve);
    });
    assert.equal(slice2.performance.cacheHit, true, 'Subsequent request for same track hits parsed cache');
  });

  await t.test('2. Late/uncorrelated response does not resolve a new attempt waiter', async () => {
    const { outgoingMessages, runtimeListener, deliverMain } = setupIsolated('corrVid');

    deliverMain({
      type: 'CAPTION_TRACKS',
      videoId: 'corrVid',
      tracks: [{ languageCode: 'en', vssId: '.en', name: 'English' }]
    });

    const slicePromise = new Promise(resolve => {
      runtimeListener({ action: 'GET_TRANSCRIPT_SLICE', payload: { startTime: 0, endTime: 30 } }, {}, resolve);
    });

    await new Promise(r => setTimeout(r, 10));
    const req = outgoingMessages.find(m => m.type === 'REQUEST_CAPTION_BODY');
    assert.ok(req);

    // Send a late response with a DIFFERENT requestId
    deliverMain({
      type: 'CAPTION_BODY',
      requestId: 'old-stale-request-id-from-past',
      videoId: 'corrVid',
      languageCode: 'en',
      format: 'json3',
      status: 200,
      body: JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'Stale' }] }] })
    });

    // The waiter for `req.requestId` should NOT be resolved by the stale message
    let resolved = false;
    slicePromise.then(() => { resolved = true; });
    await new Promise(r => setTimeout(r, 20));
    assert.equal(resolved, false, 'Waiter must remain pending when uncorrelated response arrives');

    // Now deliver with correct requestId
    deliverMain({
      type: 'CAPTION_BODY',
      requestId: req.requestId,
      videoId: 'corrVid',
      languageCode: 'en',
      format: 'json3',
      status: 200,
      body: JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'Fresh' }] }] })
    });

    const res = await slicePromise;
    assert.equal(res.success, true);
    assert.ok(res.transcriptText.includes('Fresh'));
  });

  await t.test('3. Controlled Retry: Attempt 1 produces 0 cues -> Attempt 2 fresh retry succeeds', async () => {
    const { outgoingMessages, runtimeListener, deliverMain } = setupIsolated('corrVid');

    deliverMain({
      type: 'CAPTION_TRACKS',
      videoId: 'corrVid',
      tracks: [{ languageCode: 'hi', vssId: 'a.hi', kind: 'asr', name: 'Hindi' }]
    });

    const slicePromise = new Promise(resolve => {
      runtimeListener({ action: 'GET_TRANSCRIPT_SLICE', payload: { startTime: 0, endTime: 60 } }, {}, resolve);
    });

    await new Promise(r => setTimeout(r, 10));
    const req1 = outgoingMessages.find(m => m.type === 'REQUEST_CAPTION_BODY');
    assert.ok(req1);
    assert.equal(req1.forceReactivation, false);

    // Deliver attempt 1 response with 0 cues (control-only events)
    deliverMain({
      type: 'CAPTION_BODY',
      requestId: req1.requestId,
      videoId: 'corrVid',
      languageCode: 'hi',
      format: 'json3',
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 1000, id: 1 }] }),
      responseCharacters: 50
    });

    // Allow content script to trigger fresh retry
    await new Promise(r => setTimeout(r, 15));
    const requests = outgoingMessages.filter(m => m.type === 'REQUEST_CAPTION_BODY');
    assert.equal(requests.length, 2, 'Must trigger exactly one retry request');
    const req2 = requests[1];
    assert.equal(req2.forceReactivation, true, 'Retry must set forceReactivation: true');
    assert.notEqual(req2.requestId, req1.requestId, 'Retry must use distinct requestId');

    // Deliver fresh response for attempt 2
    const validJson3 = JSON.stringify({
      events: [{ tStartMs: 0, dDurationMs: 5000, segs: [{ utf8: 'Recovered after retry!' }] }]
    });
    deliverMain({
      type: 'CAPTION_BODY',
      requestId: req2.requestId,
      videoId: 'corrVid',
      languageCode: 'hi',
      format: 'json3',
      status: 200,
      contentType: 'application/json',
      body: validJson3,
      responseCharacters: validJson3.length
    });

    const res = await slicePromise;
    assert.equal(res.success, true);
    assert.equal(res.itemCount, 1);
    assert.ok(res.transcriptText.includes('Recovered after retry!'));
  });

  await t.test('4. Double failure: Both attempts produce zero cues -> progress not advanced', async () => {
    const { outgoingMessages, runtimeListener, deliverMain } = setupIsolated('failVid');

    deliverMain({
      type: 'CAPTION_TRACKS',
      videoId: 'failVid',
      tracks: [{ languageCode: 'hi', vssId: 'a.hi', kind: 'asr', name: 'Hindi' }]
    });

    const slicePromise = new Promise(resolve => {
      runtimeListener({ action: 'GET_TRANSCRIPT_SLICE', payload: { startTime: 0, endTime: 60 } }, {}, resolve);
    });

    await new Promise(r => setTimeout(r, 10));
    const req1 = outgoingMessages.find(m => m.type === 'REQUEST_CAPTION_BODY');

    // Attempt 1 fails (0 cues)
    deliverMain({
      type: 'CAPTION_BODY',
      requestId: req1.requestId,
      videoId: 'failVid',
      languageCode: 'hi',
      format: 'json3',
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ events: [{ tStartMs: 0, id: 1 }] }),
      responseCharacters: 50
    });

    await new Promise(r => setTimeout(r, 15));
    const requests = outgoingMessages.filter(m => m.type === 'REQUEST_CAPTION_BODY');
    assert.equal(requests.length, 2);
    const req2 = requests[1];

    // Attempt 2 also fails (0 cues)
    deliverMain({
      type: 'CAPTION_BODY',
      requestId: req2.requestId,
      videoId: 'failVid',
      languageCode: 'hi',
      format: 'json3',
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ events: [{ tStartMs: 0, id: 2 }] }),
      responseCharacters: 50
    });

    const res = await slicePromise;
    assert.equal(res.success, true);
    assert.equal(res.itemCount, 0, 'Must return 0 cues on persistent failure');
    assert.equal(res.lines.length, 0, 'No lines returned so progress is not advanced in sidebar');
    assert.equal(res.transcriptText, '');
    assert.ok(res.diagnostic.length > 0, 'Diagnostic must explain failure');
  });

  await t.test('5. Attempt 1 timeout triggers fresh retry with forceReactivation and succeeds', async () => {
    const { outgoingMessages, runtimeListener, deliverMain, testHooks } = setupIsolated('timeoutVid');

    deliverMain({
      type: 'CAPTION_TRACKS',
      videoId: 'timeoutVid',
      tracks: [{ languageCode: 'hi', vssId: 'a.hi', kind: 'asr', name: 'Hindi' }]
    });

    const slicePromise = new Promise(resolve => {
      runtimeListener({ action: 'GET_TRANSCRIPT_SLICE', payload: { startTime: 0, endTime: 60 } }, {}, resolve);
    });

    await new Promise(r => setTimeout(r, 10));
    const req1 = outgoingMessages.find(m => m.type === 'REQUEST_CAPTION_BODY');
    assert.ok(req1);
    assert.equal(req1.forceReactivation, false);

    // Simulate Attempt 1 waiter timing out
    const waiter1 = testHooks.captionBodyWaiters.get(req1.requestId);
    assert.ok(waiter1);
    clearTimeout(waiter1.timer);
    testHooks.captionBodyWaiters.delete(req1.requestId);
    waiter1.resolve({
      requestId: req1.requestId,
      videoId: 'timeoutVid',
      vssId: 'a.hi',
      kind: 'asr',
      languageCode: 'hi',
      format: '',
      status: 0,
      body: '',
      responseCharacters: 0,
      timeout: true,
      contentType: '',
      transport: 'none'
    });

    // Content script must trigger bounded Attempt 2 retry with forceReactivation: true
    await new Promise(r => setTimeout(r, 15));
    const requests = outgoingMessages.filter(m => m.type === 'REQUEST_CAPTION_BODY');
    assert.equal(requests.length, 2, 'Must trigger attempt 2 retry on attempt 1 timeout');
    const req2 = requests[1];
    assert.equal(req2.forceReactivation, true, 'Retry must set forceReactivation: true');
    assert.notEqual(req2.requestId, req1.requestId, 'Retry must use distinct requestId');

    // Deliver successful cues for Attempt 2
    const validJson3 = JSON.stringify({
      events: [{ tStartMs: 0, dDurationMs: 4000, segs: [{ utf8: 'Recovered from timeout!' }] }]
    });
    deliverMain({
      type: 'CAPTION_BODY',
      requestId: req2.requestId,
      videoId: 'timeoutVid',
      languageCode: 'hi',
      format: 'json3',
      status: 200,
      contentType: 'application/json',
      body: validJson3,
      responseCharacters: validJson3.length
    });

    const res = await slicePromise;
    assert.equal(res.success, true);
    assert.equal(res.itemCount, 1);
    assert.ok(res.transcriptText.includes('Recovered from timeout!'));
  });
});
