const assert = require('node:assert/strict');
const { analyzeRgbaPixels } = require('../content/frame-quality.js');

function createFrame(width, height, withSlideText) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      let value = 90;
      if (withSlideText) {
        const lineBand = (y % 17) < 2;
        const textStroke = (x % 23) < 2 && ((Math.floor(x / 23) + Math.floor(y / 17)) % 3 !== 0);
        value = lineBand || textStroke ? 230 : 150;
      } else {
        const inSubject = x > width * 0.30 && x < width * 0.70 && y > height * 0.12 && y < height * 0.96;
        value = inSubject ? 65 : 125;
      }
      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = value;
      data[offset + 3] = 255;
    }
  }
  return data;
}

const width = 320;
const height = 180;
const talkingHead = analyzeRgbaPixels(createFrame(width, height, false), width, height);
const slide = analyzeRgbaPixels(createFrame(width, height, true), width, height);
const invalid = analyzeRgbaPixels(new Uint8ClampedArray(4), 1, 1);
assert.equal(talkingHead.isStudyRelevant, false, 'low-detail talking-head frame should be rejected');
assert.equal(slide.isStudyRelevant, true, 'distributed high-contrast slide-like frame should be accepted');
assert.ok(slide.score > talkingHead.score);
assert.equal(invalid.reason, 'insufficient-image-data');
console.log('Study-frame quality heuristic tests passed.');
