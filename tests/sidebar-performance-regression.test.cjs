const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('sidebar/sidebar.js', 'utf8');
const contentSource = fs.readFileSync('content/content.js', 'utf8');

assert.match(source, /async function handleAutoNotesButtonClick\(\)/);
assert.match(source, /state\.stopRequestedAt = Math\.max\(0, stopAtTime\)/);
assert.match(source, /state\.stopBoundaryReady = true/);
assert.match(source, /state\.stopBoundaryReady &&/);
assert.match(source, /generationWasActiveAtStop && !\['saved', 'no-new-interval'\]\.includes\(state\.lastGenerationOutcome\)/,
  'a generation that failed during stop-position capture must not be silently retried');
assert.match(source, /Stop handler is still awaiting the exact player timestamp/,
  'active generation completion must not close the run before the Stop boundary is ready');
assert.match(source, /const video = await queryVideoState\(\);\s+\/\/ Stop can be clicked while this interval[\s\S]*?if \(!state\.isAutoNotesActive\) return;/);
assert.match(source, /endTimeLimit = null/);
assert.match(source, /Math\.min\(endTime, Math\.floor\(endTimeLimit\)\)/);
assert.match(source, /Keep transcript boundaries independent of the selected screenshot timestamp/,
  'screenshot capture timing must not shorten the transcript interval');
assert.match(source, /isFinalFlush: true/);
assert.match(source, /Generating remaining notes through/);
assert.match(source, /Finishing…/);
assert.match(source, /report\.outcome === 'saved' \|\| report\.outcome === 'no-new-interval'/,
  'a failed active generation must not silently trigger an automatic duplicate retry');
assert.match(source, /scheduleMarkdownPreviewRender\(\)/);
assert.match(source, /frameTimestamp: seg === segmentCount - 1 && includeCapturedFrame \? frameData\.timestamp : null/);
assert.match(source, /sanitizePreviousNotes\(generated\)/, 'model-emitted managed screenshot blocks must be removed before note persistence');
assert.match(source, /sortTimestampedSections\(/, 'generated timestamped sections must be sorted before persistence');
assert.match(source, /regionFingerprints: frameData\.quality\.regionFingerprints/);
assert.match(source, /}, 150\)/, 'streamed Markdown preview is batched at 150ms');
assert.match(source, /flushMarkdownPreviewRender\(\)/);
assert.match(source, /\[HoverNotes Performance\]/);
assert.match(source, /Gemini attempt/);
assert.match(source, /captionLoadMs/);
assert.match(contentSource, /Caption transcript load finished/);
assert.match(contentSource, /captionParseMs/);
assert.match(contentSource, /playerWaitMs/);
assert.match(contentSource, /sliceFilterMs/);

console.log('Sidebar Stop-boundary and performance-instrumentation regression tests passed.');
