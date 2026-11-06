/**
 * Exhaustive Integration Tests for My HoverNotes v1.0.29:
 * 1. Strict Waiter Correlation (no uncorrelated/legacy fallback, strict metadata matching).
 * 2. Strict MAIN-World Request Context Matching (7 required cases).
 * 3. Explicit Cancellation & Lifecycle Cleanup (CANCEL_CAPTION_REQUEST, navigation clear, no stale context accumulation).
 * 4. Concurrent Chunk Transfer Isolation (interleaved chunks, no cross-deletion).
 * 5. Track Selection Verification (policy consistency, explicit vssId transmission).
 * 6. Out-of-Order Fetch/XHR Initiation Snapshotting (deferred promises, immutable snapshots).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const parserSource = fs.readFileSync(path.join(__dirname, '../content/caption-parser.js'), 'utf8');
const mainSource = fs.readFileSync(path.join(__dirname, '../content/youtube-main.js'), 'utf8');
const contentSource = fs.readFileSync(path.join(__dirname, '../content/content.js'), 'utf8');

function setupIsolatedWorld(targetVid = 'testVid') {
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
    querySelector: () => null,
    getElementById: () => null,
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

  return { ctx, outgoingMessages, runtimeListener, deliverMain, testHooks };
}

function setupMainWorld(options = {}) {
  const emitted = [];
  const listeners = {};
  const setOptionCalls = [];
  const testHooks = {};

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
    fetch: options.fetch || (async () => ({ status: 200, headers: { get: () => 'application/json' }, clone: () => ({ text: async () => '{}' }) })),
    __HOVERNOTES_MAIN_TEST_HOOKS__: testHooks
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

  return { ctx, emitted, setOptionCalls, postInbound, mockPlayer, windowMock, testHooks };
}

// -----------------------------------------------------------------------------
// Suite 1: Strict Request Waiter Correlation & Metadata Validation (content.js)
// -----------------------------------------------------------------------------
test('Suite 1: Strict Request Waiter Correlation & Metadata Validation', async (t) => {
  await t.test('1. Missing requestId cannot resolve a sole pending waiter', async () => {
    const { outgoingMessages, runtimeListener, deliverMain, testHooks } = setupIsolatedWorld('vid1');
    deliverMain({ type: 'CAPTION_TRACKS', videoId: 'vid1', tracks: [{ languageCode: 'en', vssId: '.en' }] });

    const slicePromise = new Promise(resolve => {
      runtimeListener({ action: 'GET_TRANSCRIPT_SLICE', payload: { startTime: 0, endTime: 30 } }, {}, resolve);
    });
    await new Promise(r => setTimeout(r, 10));
    const req = outgoingMessages.find(m => m.type === 'REQUEST_CAPTION_BODY');
    assert.ok(req);

    // Attempt to resolve with NO requestId (uncorrelated response)
    deliverMain({
      type: 'CAPTION_BODY',
      requestId: '', // missing requestId
      videoId: 'vid1',
      languageCode: 'en',
      vssId: '.en',
      format: 'json3',
      status: 200,
      body: JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'Sneaked In' }] }] })
    });

    let resolved = false;
    slicePromise.then(() => { resolved = true; });
    await new Promise(r => setTimeout(r, 20));
    assert.equal(resolved, false, 'Waiter must remain pending; uncorrelated response without requestId must be rejected');
    for (const w of testHooks.captionBodyWaiters.values()) clearTimeout(w.timer);
    testHooks.captionBodyWaiters.clear();
  });

  await t.test('2. Wrong non-empty requestId cannot resolve the waiter', async () => {
    const { outgoingMessages, runtimeListener, deliverMain, testHooks } = setupIsolatedWorld('vid2');
    deliverMain({ type: 'CAPTION_TRACKS', videoId: 'vid2', tracks: [{ languageCode: 'en', vssId: '.en' }] });

    const slicePromise = new Promise(resolve => {
      runtimeListener({ action: 'GET_TRANSCRIPT_SLICE', payload: { startTime: 0, endTime: 30 } }, {}, resolve);
    });
    await new Promise(r => setTimeout(r, 10));

    deliverMain({
      type: 'CAPTION_BODY',
      requestId: 'completely-wrong-id-999',
      videoId: 'vid2',
      languageCode: 'en',
      vssId: '.en',
      format: 'json3',
      status: 200,
      body: JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'Wrong' }] }] })
    });

    let resolved = false;
    slicePromise.then(() => { resolved = true; });
    await new Promise(r => setTimeout(r, 20));
    assert.equal(resolved, false, 'Waiter must not resolve with mismatched requestId');
    for (const w of testHooks.captionBodyWaiters.values()) clearTimeout(w.timer);
    testHooks.captionBodyWaiters.clear();
  });

  await t.test('3. Correct requestId with wrong videoId cannot resolve the waiter', async () => {
    const { outgoingMessages, runtimeListener, deliverMain, testHooks } = setupIsolatedWorld('vid3');
    deliverMain({ type: 'CAPTION_TRACKS', videoId: 'vid3', tracks: [{ languageCode: 'en', vssId: '.en' }] });

    const slicePromise = new Promise(resolve => {
      runtimeListener({ action: 'GET_TRANSCRIPT_SLICE', payload: { startTime: 0, endTime: 30 } }, {}, resolve);
    });
    await new Promise(r => setTimeout(r, 10));
    const req = outgoingMessages.find(m => m.type === 'REQUEST_CAPTION_BODY');

    deliverMain({
      type: 'CAPTION_BODY',
      requestId: req.requestId,
      videoId: 'differentVideo456', // wrong videoId
      languageCode: 'en',
      vssId: '.en',
      format: 'json3',
      status: 200,
      body: JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'Wrong Video' }] }] })
    });

    let resolved = false;
    slicePromise.then(() => { resolved = true; });
    await new Promise(r => setTimeout(r, 20));
    assert.equal(resolved, false, 'Waiter must not resolve when videoId mismatches');
    for (const w of testHooks.captionBodyWaiters.values()) clearTimeout(w.timer);
    testHooks.captionBodyWaiters.clear();
  });

  await t.test('4. Correct requestId with wrong explicit vssId cannot resolve the waiter', async () => {
    const { outgoingMessages, runtimeListener, deliverMain, testHooks } = setupIsolatedWorld('vid4');
    deliverMain({ type: 'CAPTION_TRACKS', videoId: 'vid4', tracks: [{ languageCode: 'hi', vssId: 'a.hi', kind: 'asr' }] });

    const slicePromise = new Promise(resolve => {
      runtimeListener({ action: 'GET_TRANSCRIPT_SLICE', payload: { startTime: 0, endTime: 30 } }, {}, resolve);
    });
    await new Promise(r => setTimeout(r, 10));
    const req = outgoingMessages.find(m => m.type === 'REQUEST_CAPTION_BODY');
    assert.equal(req.vssId, 'a.hi');

    deliverMain({
      type: 'CAPTION_BODY',
      requestId: req.requestId,
      videoId: 'vid4',
      languageCode: 'hi',
      vssId: '.hi', // wrong explicit vssId (.hi instead of a.hi)
      format: 'json3',
      status: 200,
      body: JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'Wrong Vss' }] }] })
    });

    let resolved = false;
    slicePromise.then(() => { resolved = true; });
    await new Promise(r => setTimeout(r, 20));
    assert.equal(resolved, false, 'Waiter must not resolve when vssId conflicts');
    for (const w of testHooks.captionBodyWaiters.values()) clearTimeout(w.timer);
    testHooks.captionBodyWaiters.clear();
  });

  await t.test('5. Correct request with matching metadata resolves successfully', async () => {
    const { outgoingMessages, runtimeListener, deliverMain } = setupIsolatedWorld('vid5');
    deliverMain({ type: 'CAPTION_TRACKS', videoId: 'vid5', tracks: [{ languageCode: 'hi', vssId: 'a.hi', kind: 'asr' }] });

    const slicePromise = new Promise(resolve => {
      runtimeListener({ action: 'GET_TRANSCRIPT_SLICE', payload: { startTime: 0, endTime: 30 } }, {}, resolve);
    });
    await new Promise(r => setTimeout(r, 10));
    const req = outgoingMessages.find(m => m.type === 'REQUEST_CAPTION_BODY');

    deliverMain({
      type: 'CAPTION_BODY',
      requestId: req.requestId,
      videoId: 'vid5',
      languageCode: 'hi',
      vssId: 'a.hi',
      format: 'json3',
      status: 200,
      body: JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'Valid Cues' }] }] }),
      responseCharacters: 80
    });

    const res = await slicePromise;
    assert.equal(res.success, true);
    assert.equal(res.itemCount, 1);
    assert.ok(res.transcriptText.includes('Valid Cues'));
  });
});

// -----------------------------------------------------------------------------
// Suite 2: Strict MAIN-World Request Context Matching (youtube-main.js)
// -----------------------------------------------------------------------------
test('Suite 2: Strict MAIN-World Request Context Matching', async (t) => {
  const { testHooks, postInbound } = setupMainWorld();
  const activeCaptionRequests = testHooks.activeCaptionRequests;
  const findMatchingRequestContext = testHooks.findMatchingRequestContext;

  await t.test('Case 1: Requested a.hi / observed a.hi: accept', () => {
    activeCaptionRequests.clear();
    activeCaptionRequests.set('req-1', {
      requestId: 'req-1', videoId: 'v1', languageCode: 'hi', vssId: 'a.hi', kind: 'asr', activatedAt: Date.now()
    });
    const match = findMatchingRequestContext({ videoId: 'v1', languageCode: 'hi', vssId: 'a.hi' });
    assert.ok(match);
    assert.equal(match.requestId, 'req-1');
  });

  await t.test('Case 2: Requested a.hi / observed .hi: reject', () => {
    activeCaptionRequests.clear();
    activeCaptionRequests.set('req-2', {
      requestId: 'req-2', videoId: 'v1', languageCode: 'hi', vssId: 'a.hi', kind: 'asr', activatedAt: Date.now()
    });
    const match = findMatchingRequestContext({ videoId: 'v1', languageCode: 'hi', vssId: '.hi' });
    assert.equal(match, null, 'Must reject when observed vssId conflicts with requested vssId');
  });

  await t.test('Case 3: Requested .hi / observed a.hi: reject', () => {
    activeCaptionRequests.clear();
    activeCaptionRequests.set('req-3', {
      requestId: 'req-3', videoId: 'v1', languageCode: 'hi', vssId: '.hi', activatedAt: Date.now()
    });
    const match = findMatchingRequestContext({ videoId: 'v1', languageCode: 'hi', vssId: 'a.hi' });
    assert.equal(match, null, 'Must reject when observed a.hi does not match requested .hi');
  });

  await t.test('Case 4: Requested kind ASR / observed conflicting explicit kind: reject', () => {
    activeCaptionRequests.clear();
    activeCaptionRequests.set('req-4', {
      requestId: 'req-4', videoId: 'v1', languageCode: 'en', vssId: '', kind: 'asr', activatedAt: Date.now()
    });
    const match = findMatchingRequestContext({ videoId: 'v1', languageCode: 'en', vssId: '', kind: 'standard' });
    assert.equal(match, null, 'Must reject when explicit kind conflicts');
  });

  await t.test('Case 5: URL without vssId with exactly one active matching request: accept', () => {
    activeCaptionRequests.clear();
    activeCaptionRequests.set('req-5', {
      requestId: 'req-5', videoId: 'v1', languageCode: 'hi', vssId: 'a.hi', kind: 'asr', activatedAt: Date.now()
    });
    const match = findMatchingRequestContext({ videoId: 'v1', languageCode: 'hi', vssId: '', kind: '' });
    assert.ok(match);
    assert.equal(match.requestId, 'req-5');
  });

  await t.test('Case 6: URL without vssId with multiple matching active requests: reject as ambiguous', () => {
    activeCaptionRequests.clear();
    activeCaptionRequests.set('req-6A', {
      requestId: 'req-6A', videoId: 'v1', languageCode: 'hi', vssId: 'a.hi', kind: 'asr', activatedAt: Date.now()
    });
    activeCaptionRequests.set('req-6B', {
      requestId: 'req-6B', videoId: 'v1', languageCode: 'hi', vssId: '.hi', kind: '', activatedAt: Date.now()
    });
    const match = findMatchingRequestContext({ videoId: 'v1', languageCode: 'hi', vssId: '', kind: '' });
    assert.equal(match, null, 'Must reject ambiguous candidates when multiple active requests share language');
  });

  await t.test('Case 7: Explicit metadata mismatch with only one active request: reject', () => {
    activeCaptionRequests.clear();
    activeCaptionRequests.set('req-7', {
      requestId: 'req-7', videoId: 'v1', languageCode: 'en', vssId: '.en', kind: '', activatedAt: Date.now()
    });
    // Observed URL has language hi: explicit conflict
    const match = findMatchingRequestContext({ videoId: 'v1', languageCode: 'hi', vssId: '', kind: '' });
    assert.equal(match, null, 'Must reject candidate with conflicting language even if sole active request');
  });

  await t.test('Case 8: captureTimedText drops mismatched observed vssId before relaying body', async () => {
    const { testHooks: hooks8, emitted } = setupMainWorld();
    hooks8.expectedVideoId = 'v1';
    hooks8.activeCaptionRequests.set('req-snap', {
      requestId: 'req-snap', videoId: 'v1', languageCode: 'hi', vssId: 'a.hi', kind: 'asr', activatedAt: Date.now()
    });

    const beforeCount = emitted.length;
    // URL observed with .hi (conflicting with a.hi)
    hooks8.captureTimedText(
      'https://www.youtube.com/api/timedtext?v=v1&lang=hi&vss_id=.hi&fmt=json3',
      { status: 200, contentType: 'application/json', requestContext: { requestId: 'req-snap', vssId: 'a.hi' } },
      Promise.resolve('{"events":[]}')
    );
    await new Promise(r => setTimeout(r, 20));
    const emittedBodies = emitted.slice(beforeCount).filter(m => m.type === 'CAPTION_BODY' || m.type === 'CAPTION_BODY_START');
    assert.equal(emittedBodies.length, 0, 'Conflicting response must be rejected before sending to isolated world');
    assert.equal(hooks8.activeCaptionRequests.has('req-snap'), false, 'Mismatched request context must be cleaned up');
  });
});

// -----------------------------------------------------------------------------
// Suite 3: Explicit Cancellation & Lifecycle Cleanup
// -----------------------------------------------------------------------------
test('Suite 3: Explicit Cancellation & Lifecycle Cleanup', async (t) => {
  await t.test('1. Waiter timeout sends CANCEL_CAPTION_REQUEST to MAIN world', async () => {
    const { outgoingMessages, testHooks } = setupIsolatedWorld('vidCancel');
    const bodyPromise = testHooks.waitForPlayerCaptionBody('vidCancel', { languageCode: 'en', vssId: '.en' }, 'req-timeout-1', 50);
    await bodyPromise;

    const cancelMsg = outgoingMessages.find(m => m.type === 'CANCEL_CAPTION_REQUEST');
    assert.ok(cancelMsg, 'CANCEL_CAPTION_REQUEST must be sent on waiter timeout');
    assert.equal(cancelMsg.requestId, 'req-timeout-1');
    assert.equal(cancelMsg.videoId, 'vidCancel');
  });

  await t.test('2. CANCEL_CAPTION_REQUEST removes context from activeCaptionRequests immediately', () => {
    const { testHooks, postInbound } = setupMainWorld();
    testHooks.activeCaptionRequests.set('req-to-cancel', {
      requestId: 'req-to-cancel', videoId: 'vidCancel', languageCode: 'en', vssId: '.en', activatedAt: Date.now()
    });
    assert.equal(testHooks.activeCaptionRequests.has('req-to-cancel'), true);

    postInbound({
      type: 'CANCEL_CAPTION_REQUEST',
      requestId: 'req-to-cancel',
      videoId: 'vidCancel'
    });

    assert.equal(testHooks.activeCaptionRequests.has('req-to-cancel'), false, 'Context must be removed immediately on cancellation');
  });

  await t.test('3. Video navigation clears activeCaptionRequests and isolated waiters', () => {
    const { testHooks } = setupMainWorld();
    testHooks.activeCaptionRequests.set('req-old', { requestId: 'req-old', videoId: 'oldVid', activatedAt: Date.now() });
    assert.equal(testHooks.activeCaptionRequests.size, 1);

    testHooks.handleVideoTransition('newVid123');
    assert.equal(testHooks.activeCaptionRequests.size, 0, 'All active contexts must be cleared on video transition');
  });

  await t.test('4. Late attempt 1 response rejected after cancellation; attempt 2 succeeds', async () => {
    const { outgoingMessages, runtimeListener, deliverMain } = setupIsolatedWorld('retryVid');
    deliverMain({ type: 'CAPTION_TRACKS', videoId: 'retryVid', tracks: [{ languageCode: 'hi', vssId: 'a.hi', kind: 'asr' }] });

    const slicePromise = new Promise(resolve => {
      runtimeListener({ action: 'GET_TRANSCRIPT_SLICE', payload: { startTime: 0, endTime: 60 } }, {}, resolve);
    });
    await new Promise(r => setTimeout(r, 10));

    const req1 = outgoingMessages.find(m => m.type === 'REQUEST_CAPTION_BODY');
    assert.ok(req1);

    // Deliver 0 cues for attempt 1 to trigger retry
    deliverMain({
      type: 'CAPTION_BODY',
      requestId: req1.requestId,
      vssId: 'a.hi',
      videoId: 'retryVid',
      languageCode: 'hi',
      format: 'json3',
      status: 200,
      body: JSON.stringify({ events: [{ tStartMs: 0, id: 1 }] }),
      responseCharacters: 50
    });

    await new Promise(r => setTimeout(r, 15));
    const requests = outgoingMessages.filter(m => m.type === 'REQUEST_CAPTION_BODY');
    assert.equal(requests.length, 2);
    const req2 = requests[1];

    // Now send a delayed response for attempt 1 (should be ignored because req1 was already resolved/cleared)
    deliverMain({
      type: 'CAPTION_BODY',
      requestId: req1.requestId, // old attempt 1 ID
      vssId: 'a.hi',
      videoId: 'retryVid',
      languageCode: 'hi',
      format: 'json3',
      status: 200,
      body: JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'Late attempt 1 text' }] }] }),
      responseCharacters: 80
    });

    // Attempt 2 response arrives
    deliverMain({
      type: 'CAPTION_BODY',
      requestId: req2.requestId,
      vssId: 'a.hi',
      videoId: 'retryVid',
      languageCode: 'hi',
      format: 'json3',
      status: 200,
      body: JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 5000, segs: [{ utf8: 'Fresh attempt 2 text' }] }] }),
      responseCharacters: 80
    });

    const res = await slicePromise;
    assert.equal(res.success, true);
    assert.equal(res.itemCount, 1);
    assert.equal(res.transcriptText.includes('Fresh attempt 2 text'), true);
    assert.equal(res.transcriptText.includes('Late attempt 1 text'), false, 'Late attempt 1 text must not leak into attempt 2');
  });
});

// -----------------------------------------------------------------------------
// Suite 4: Concurrent Chunk Transfer Isolation
// -----------------------------------------------------------------------------
test('Suite 4: Concurrent Chunk Transfer Isolation', async (t) => {
  await t.test('Overlapping transfers for distinct requests arrive out-of-order without cross-corruption', async () => {
    const { testHooks, deliverMain } = setupIsolatedWorld('chunkVid');
    const captionBodyWaiters = testHooks.captionBodyWaiters;

    let resolve1, resolve2;
    const p1 = new Promise(r => { resolve1 = r; });
    const p2 = new Promise(r => { resolve2 = r; });
    const timer1 = setTimeout(() => {}, 10000);
    const timer2 = setTimeout(() => {}, 10000);

    captionBodyWaiters.set('req-chunk-1', {
      requestId: 'req-chunk-1', videoId: 'chunkVid', vssId: 'a.hi', kind: 'asr', languageCode: 'hi',
      resolve: resolve1, timer: timer1
    });
    captionBodyWaiters.set('req-chunk-2', {
      requestId: 'req-chunk-2', videoId: 'chunkVid', vssId: '.en', kind: '', languageCode: 'en',
      resolve: resolve2, timer: timer2
    });

    // Start transfer 1 (Hindi)
    const json1 = JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'Hindi chunked payload' }] }] });
    deliverMain({
      type: 'CAPTION_BODY_START',
      transferId: 't1',
      requestId: 'req-chunk-1',
      vssId: 'a.hi',
      kind: 'asr',
      videoId: 'chunkVid',
      languageCode: 'hi',
      format: 'json3',
      totalChunks: 2,
      responseCharacters: json1.length
    });

    // Start transfer 2 (English) - must NOT wipe transfer 1!
    const json2 = JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: 'English chunked payload' }] }] });
    deliverMain({
      type: 'CAPTION_BODY_START',
      transferId: 't2',
      requestId: 'req-chunk-2',
      vssId: '.en',
      kind: '',
      videoId: 'chunkVid',
      languageCode: 'en',
      format: 'json3',
      totalChunks: 2,
      responseCharacters: json2.length
    });

    assert.equal(testHooks.captionBodyTransfers.size, 2, 'Both transfers must remain active concurrently without cross-deletion');

    // Deliver chunks interleaved / out-of-order:
    // Transfer 2 chunk 0
    deliverMain({ type: 'CAPTION_BODY_CHUNK', transferId: 't2', index: 0, chunk: json2.slice(0, 30) });
    // Transfer 1 chunk 1
    deliverMain({ type: 'CAPTION_BODY_CHUNK', transferId: 't1', index: 1, chunk: json1.slice(30) });
    // Transfer 2 chunk 1 (finishes transfer 2 first)
    deliverMain({ type: 'CAPTION_BODY_CHUNK', transferId: 't2', index: 1, chunk: json2.slice(30) });

    const res2 = await p2;
    assert.equal(res2.requestId, 'req-chunk-2');
    assert.equal(res2.body, json2);

    // Now finish Transfer 1 chunk 0
    deliverMain({ type: 'CAPTION_BODY_CHUNK', transferId: 't1', index: 0, chunk: json1.slice(0, 30) });

    const res1 = await p1;
    assert.equal(res1.requestId, 'req-chunk-1');
    assert.equal(res1.body, json1);

    clearTimeout(timer1);
    clearTimeout(timer2);
  });
});

// -----------------------------------------------------------------------------
// Suite 5: Track Selection Verification
// -----------------------------------------------------------------------------
test('Suite 5: Track Selection Policy & Retrieval Verification', async (t) => {
  const { testHooks, outgoingMessages, runtimeListener, deliverMain } = setupIsolatedWorld('policyVid');
  const pickBestCaptionTrack = testHooks.pickBestCaptionTrack;

  await t.test('Policy evaluation: English manual > English ASR > Hindi manual > Hindi ASR', () => {
    const allTracks = [
      { languageCode: 'hi', kind: 'asr', vssId: 'a.hi', name: 'Hindi (auto)' },
      { languageCode: 'hi', vssId: '.hi', name: 'Hindi (manual)' },
      { languageCode: 'en', kind: 'asr', vssId: 'a.en', name: 'English (auto)' },
      { languageCode: 'en', vssId: '.en', name: 'English (manual)' }
    ];
    assert.equal(pickBestCaptionTrack(allTracks).vssId, '.en', 'Must pick English manual first');

    const noEnManual = allTracks.filter(t => t.vssId !== '.en');
    assert.equal(pickBestCaptionTrack(noEnManual).vssId, 'a.en', 'Must pick English ASR next');

    const onlyHindi = allTracks.filter(t => t.languageCode === 'hi');
    assert.equal(pickBestCaptionTrack(onlyHindi).vssId, '.hi', 'Must pick Hindi manual before Hindi ASR in standard policy');

    const onlyHindiAsr = [{ languageCode: 'hi', kind: 'asr', vssId: 'a.hi' }];
    assert.equal(pickBestCaptionTrack(onlyHindiAsr).vssId, 'a.hi', 'Must pick Hindi ASR when sole Hindi track');
  });

  await t.test('getFullTranscript passes selected vssId and kind to REQUEST_CAPTION_BODY', async () => {
    deliverMain({
      type: 'CAPTION_TRACKS',
      videoId: 'policyVid',
      tracks: [
        { languageCode: 'hi', kind: 'asr', vssId: 'a.hi', name: 'Hindi (auto)' },
        { languageCode: 'hi', vssId: '.hi', name: 'Hindi (manual)' }
      ]
    });

    runtimeListener({ action: 'GET_TRANSCRIPT_SLICE', payload: { startTime: 0, endTime: 30 } }, {}, () => {});
    await new Promise(r => setTimeout(r, 10));

    const req = outgoingMessages.find(m => m.type === 'REQUEST_CAPTION_BODY');
    assert.ok(req);
    assert.equal(req.vssId, '.hi', 'Requested vssId must match policy output');
    assert.equal(req.languageCode, 'hi');
    for (const w of testHooks.captionBodyWaiters.values()) clearTimeout(w.timer);
    testHooks.captionBodyWaiters.clear();
  });
});

// -----------------------------------------------------------------------------
// Suite 6: Out-of-Order Fetch/XHR Initiation Snapshotting
// -----------------------------------------------------------------------------
test('Suite 6: Out-of-Order Fetch/XHR Network Initiation Snapshotting', async (t) => {
  await t.test('Snapshots requestContext at fetch initiation time, resilient to out-of-order completion', async () => {
    // Deferred promises for responses
    let resolveNet1, resolveNet2;
    const netPromise1 = new Promise(r => { resolveNet1 = r; });
    const netPromise2 = new Promise(r => { resolveNet2 = r; });

    const customFetch = function (url) {
      if (typeof url === 'string' && url.includes('req1')) {
        return netPromise1;
      }
      if (typeof url === 'string' && url.includes('req2')) {
        return netPromise2;
      }
      return Promise.reject(new Error('Unknown URL in test: ' + url));
    };

    const { ctx, emitted, postInbound } = setupMainWorld({ fetch: customFetch });
    const windowMock = ctx.window;

    // Request 1 initiated (Hindi manual .hi)
    postInbound({
      type: 'REQUEST_CAPTION_BODY',
      requestId: 'req-net-1',
      videoId: 'vNet',
      languageCode: 'hi',
      vssId: '.hi'
    });

    // Network request 1 starts fetching (URL has .hi)
    const url1 = 'https://www.youtube.com/api/timedtext?v=vNet&lang=hi&vss_id=.hi&fmt=json3&req=req1';
    windowMock.fetch(url1);

    // Request 2 initiated (English .en) - updates activeCaptionRequests
    postInbound({
      type: 'REQUEST_CAPTION_BODY',
      requestId: 'req-net-2',
      videoId: 'vNet',
      languageCode: 'en',
      vssId: '.en'
    });

    // Network request 2 starts fetching (URL has .en)
    const url2 = 'https://www.youtube.com/api/timedtext?v=vNet&lang=en&vss_id=.en&fmt=json3&req=req2';
    windowMock.fetch(url2);

    // Complete Network Request 2 FIRST
    resolveNet2({
      status: 200,
      headers: { get: () => 'application/json' },
      clone: () => ({ text: async () => '{"events":[{"tStartMs":0,"dDurationMs":1000,"segs":[{"utf8":"Net2 text"}]}]}' })
    });
    await new Promise(r => setTimeout(r, 20));

    const msg2 = emitted.find(m => m.type === 'CAPTION_BODY' && m.requestId === 'req-net-2');
    assert.ok(msg2, 'Network request 2 must resolve to req-net-2');
    assert.equal(msg2.vssId, '.en');
    assert.ok(msg2.body.includes('Net2 text'));

    // Complete Network Request 1 SECOND
    resolveNet1({
      status: 200,
      headers: { get: () => 'application/json' },
      clone: () => ({ text: async () => '{"events":[{"tStartMs":0,"dDurationMs":1000,"segs":[{"utf8":"Net1 text"}]}]}' })
    });
    await new Promise(r => setTimeout(r, 20));

    const msg1 = emitted.find(m => m.type === 'CAPTION_BODY' && m.requestId === 'req-net-1');
    assert.ok(msg1, 'Network request 1 must resolve to req-net-1 even though it completed later');
    assert.equal(msg1.vssId, '.hi');
    assert.ok(msg1.body.includes('Net1 text'));
  });
});
