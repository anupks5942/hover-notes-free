const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const stored = {
  gemini_keys: ['test-key-1', 'test-key-2'],
  active_key_index: 0,
  gemini_model: 'gemini-3.8-flash'
};

global.chrome = {
  storage: { local: {
    get(_keys, callback) { callback({ ...stored }); },
    async set(values) { Object.assign(stored, values); }
  } }
};
global.window = {};
vm.runInThisContext(fs.readFileSync('sidebar/gemini-client.js', 'utf8'), {
  filename: 'sidebar/gemini-client.js'
});

function sseResponse(text) {
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(
        `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] })}\n\n`
      ));
      controller.close();
    }
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

(async () => {
  const client = window.geminiClient;
  assert.equal(client.firstTokenTimeoutMs, 30000, 'production first-token timeout must be 30 seconds');
  client.firstTokenTimeoutMs = 1000;
  const events = [];
  const requestedModels = [];

  global.fetch = async (url, options) => {
    const model = String(url).match(/models\/([^:]+)/)?.[1];
    requestedModels.push(model);
    if (model === client.primaryModel) {
      return new Promise((_resolve, reject) => {
        if (options.signal.aborted) {
          reject(new DOMException('Aborted', 'AbortError'));
          return;
        }
        options.signal.addEventListener('abort', () => {
          reject(new DOMException('Aborted by first-token timeout', 'AbortError'));
        }, { once: true });
      });
    }
    const payload = JSON.parse(options.body);
    assert.equal(Object.hasOwn(payload.generationConfig || {}, 'thinkingConfig'), false,
      'fallback model must not receive unsupported thinkingConfig');
    return sseResponse('Fallback response after primary first-token timeout.');
  };

  const generated = await client.generateNotesStream({
    videoTitle: 'Timeout regression',
    currentTimestamp: '00:00–01:00',
    transcriptChunk: '[00:10] Grounded lecture evidence.',
    onChunk() {},
    onDiagnostics(event) { events.push(event); }
  });

  assert.match(generated, /Fallback response/);
  assert.deepEqual(requestedModels, [client.primaryModel, client.fallbackModel]);
  assert.ok(events.some(event => event.type === 'first-token-timeout' && event.timeoutMs === 1000));
  assert.ok(events.some(event => event.type === 'attempt-failed' && event.errorName === 'FirstTokenTimeoutError'));
  assert.ok(events.some(event => event.type === 'attempt-success' && event.model === client.fallbackModel));
  assert.ok(!JSON.stringify(events).includes('test-key-1'));

  // A successful fallback is sticky for later segments in the same extension session.
  requestedModels.length = 0;
  global.fetch = async (url, options) => {
    requestedModels.push(String(url).match(/models\/([^:]+)/)?.[1]);
    return sseResponse('Second interval uses the session-preferred fallback.');
  };
  await client.generateNotesStream({
    videoTitle: 'Second interval', currentTimestamp: '01:00–02:00',
    transcriptChunk: '[01:10] Follow-on evidence.', onChunk() {}
  });
  assert.deepEqual(requestedModels, [client.fallbackModel],
    'second interval must not repeat a slow primary request after a fallback succeeded');

  // When the fallback model is selected first, it is sent without thinkingConfig.
  stored.gemini_model = client.fallbackModel;
  requestedModels.length = 0;
  global.fetch = async (url, options) => {
    requestedModels.push(String(url).match(/models\/([^:]+)/)?.[1]);
    const payload = JSON.parse(options.body);
    assert.equal(Object.hasOwn(payload.generationConfig || {}, 'thinkingConfig'), false);
    return sseResponse('Direct fallback response.');
  };
  const directFallback = await client.generateNotesStream({
    videoTitle: 'Fallback config regression',
    currentTimestamp: '01:00–02:00',
    transcriptChunk: '[01:10] More grounded evidence.',
    onChunk() {}
  });
  assert.match(directFallback, /Direct fallback response/);
  assert.deepEqual(requestedModels, [client.fallbackModel]);

  console.log('Gemini first-token timeout and model-specific config tests passed.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
