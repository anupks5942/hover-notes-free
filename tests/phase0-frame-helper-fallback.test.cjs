const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const serviceWorker = fs.readFileSync(path.join(root, 'background/service-worker.js'), 'utf8');
const content = fs.readFileSync(path.join(root, 'content/content.js'), 'utf8');
const sidebar = fs.readFileSync(path.join(root, 'sidebar/sidebar.js'), 'utf8');

const injection = serviceWorker.match(/chrome\.scripting\.executeScript\([\s\S]*?files:\s*\[([^\]]+)\]/);
assert.ok(injection, 'service worker should declare a fallback content-script injection list');
const files = [...injection[1].matchAll(/'([^']+)'/g)].map(match => match[1]);
assert.deepEqual(
  files,
  ['content/caption-parser.js', 'content/frame-quality.js', 'content/content.js'],
  'fallback injection must load frame-quality.js after caption-parser.js and before content.js'
);

assert.match(content, /function getTranscriptRelevance\(transcriptText\)/,
  'visual frame filtering should use a guarded transcript-relevance helper');
assert.match(content, /function areStudyFramesNearDuplicate\(first,\s*second,\s*thresholds\)/,
  'visual deduplication should fail safely if its helper is unavailable');
assert.doesNotMatch(content, /window\.HoverNotesFrameQuality\.analyzeTranscriptRelevance/,
  'no unguarded transcript-relevance helper calls should remain');
assert.doesNotMatch(content, /window\.HoverNotesFrameQuality\.areNearDuplicateFingerprints/,
  'no unguarded duplicate-helper calls should remain');

assert.match(sidebar, /try\s*\{\s*frameData\s*=\s*await captureFrameData/,
  'screenshot capture should be isolated in a try block');
assert.match(sidebar, /Frame capture failed; continuing without screenshot/,
  'screenshot errors must be non-fatal to transcript-grounded AI generation');

console.log('PASS: fallback injection loads frame-quality dependency in order');
console.log('PASS: visual helper calls are guarded');
console.log('PASS: screenshot failure does not abort note generation');
