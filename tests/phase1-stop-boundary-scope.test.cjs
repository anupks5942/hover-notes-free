const assert = require('node:assert/strict');
const fs = require('node:fs');

const sidebar = fs.readFileSync('sidebar/sidebar.js', 'utf8');
const functionStart = sidebar.indexOf('async function triggerAutoNotesSynthesis(');
assert.notEqual(functionStart, -1, 'generation function must exist');
const frameCaptureTry = sidebar.indexOf('    try {\n      let stageStartedAt = perfNow();', functionStart);
assert.notEqual(frameCaptureTry, -1, 'frame/generation try block must exist');
const frameCaptureStart = sidebar.indexOf('const sliceRes = await sendBridgeMessage', frameCaptureTry);
assert.notEqual(frameCaptureStart, -1, 'transcript extraction must be inside the frame/generation try block');
const frameCaptureCatch = sidebar.indexOf('} catch (frameError) {', frameCaptureTry);
assert.notEqual(frameCaptureCatch, -1, 'frame capture must fail independently');
const chunkProcessing = sidebar.indexOf('const CHUNK_SIZE = 300;', frameCaptureCatch);
assert.notEqual(chunkProcessing, -1, 'AI chunk processing must follow frame capture');

const beforeFrameCatch = sidebar.slice(frameCaptureTry, frameCaptureCatch);
const afterFrameCatch = sidebar.slice(frameCaptureCatch, chunkProcessing);
assert.match(beforeFrameCatch, /const capturedFrameTime = Number\.isFinite\(frameData\.seconds\)/,
  'capturedFrameTime must be declared in the frame-capture try scope');
assert.match(beforeFrameCatch, /capturedFrameTime <= frozenBoundary/,
  'the captured frame must be checked against the frozen Stop boundary inside its declaration scope');
assert.doesNotMatch(afterFrameCatch, /\bcapturedFrameTime\b/,
  'no reference to block-scoped capturedFrameTime may escape the try scope (v1.0.17 Stop regression)');
assert.match(afterFrameCatch, /Frame capture failed; continuing without screenshot/,
  'a frame-capture failure must remain non-fatal to transcript notes');

console.log('Phase 1 Stop-boundary scope regression checks passed.');
