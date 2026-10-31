const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const base = path.join(__dirname, '..');
const content = fs.readFileSync(path.join(base, 'content', 'content.js'), 'utf8');
const sidebar = fs.readFileSync(path.join(base, 'sidebar', 'sidebar.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(base, 'manifest.json'), 'utf8'));
const isolated = manifest.content_scripts.find(entry => entry.js.includes('content/content.js'));

assert.ok(isolated, 'isolated YouTube content script must be present');
assert.ok(isolated.js.indexOf('content/frame-quality.js') < isolated.js.indexOf('content/content.js'),
  'frame-quality helper must load before content.js');
assert.match(content, /setInterval\(\(\) => \{ void considerStudyFrame\(getVideoElement\(\)\); \}, 2500\)/,
  'sampler must run at the documented 2.5-second cadence');
assert.match(content, /video\.paused/);
assert.match(content, /video\.readyState < 2/);
const samplerStart = content.indexOf('async function considerStudyFrame');
const samplerEnd = content.indexOf('function startStudyFrameSampler', samplerStart);
const samplerSource = content.slice(samplerStart, samplerEnd);
assert.doesNotMatch(samplerSource, /video\.pause\s*\(/, 'sampler must not pause playback');
assert.doesNotMatch(samplerSource, /video\.currentTime\s*=/, 'sampler must not seek playback');
assert.match(content, /MAX_STUDY_FRAME_BUCKETS = 20/);
assert.match(content, /usedStudyFrameFingerprints = \[\]/);
assert.match(content, /getBestStudyFrame\(payload\?\.startTime, payload\?\.endTime, payload\?\.transcriptText/);
assert.match(content, /MARK_STUDY_FRAME_USED/);
assert.match(content, /STUDY_FRAME_DUPLICATE_DISTANCE = 10/);
assert.match(content, /STUDY_FRAME_MOTION_DUPLICATE_DISTANCE = 25/);
assert.match(content, /STUDY_FRAME_REGION_DUPLICATE_DISTANCE = 21/);
assert.match(content, /areNearDuplicateFingerprints/);
assert.match(content, /selectionScore/);
assert.match(content, /upperSlideOcclusionRatio/);
assert.match(content, /getBestStudyFrame\(startTime, endTime, transcriptText = ''\)/);
assert.match(sidebar, /selectBestStudyFrame: true, startTime, endTime,[\s\S]*?transcriptText: sliceRes\.transcriptText/);
assert.match(sidebar, /MARK_STUDY_FRAME_USED/);
assert.match(sidebar, /regionFingerprints: frameData\.quality\.regionFingerprints/);
assert.match(sidebar, /frameData\.quality\?\.isStudyRelevant/,
  'automatic screenshot persistence must require a passing quality assessment');
assert.match(sidebar, /screenshotSkipped/);
console.log('Study-frame sampler selection and no-playback-interference tests passed.');
