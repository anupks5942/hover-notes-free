const assert = require('node:assert/strict');
const { analyzeRgbaPixels, analyzeTranscriptRelevance, hammingDistanceHex, areNearDuplicateFingerprints } = require('../content/frame-quality.js');

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
const slideAt238 = {
  fingerprint: '33ca1696b7352535',
  regionFingerprints: ['1502010047cd0102', '5f1e3ab5bcbcb4b8', 'd6eac9add5a5dbaa', '3c34797b72353731']
};
const sameSlideAt401 = {
  fingerprint: '33cb53d3c3a7e747',
  regionFingerprints: ['050212224bcd3019', '5f1eae2f1e9f9e9e', 'e8e8e2d6b6d2d9e1', '1e5e3e3f5f3f3e3f']
};
const sameSlideAt338 = {
  fingerprint: '33ca1e96b6342535',
  regionFingerprints: ['0502120147cd0101', '5f1faa35b8b9b02d', 'd6eac9add5a5dbaa', '3474796373656436']
};
const promoFrame = {
  fingerprint: '24290485492e960b',
  regionFingerprints: ['422b829c84a01264', 'a99561cef0b4b792', '9691ed4e55a545c5', 'e5c9217169a8cc4e']
};
assert.equal(areNearDuplicateFingerprints(slideAt238, sameSlideAt338), true,
  'full-frame hash should identify the same slide with a small presenter movement');
assert.equal(areNearDuplicateFingerprints(slideAt238, sameSlideAt401), true,
  'regional hashes should identify the same slide despite larger instructor movement');
assert.equal(areNearDuplicateFingerprints(slideAt238, promoFrame), false,
  'a promotional image must not be collapsed into the study slide');

const promotionalIntro = `पिछले 15 सालों से बड़ी-बड़ी कोचिंग्स में हजारों बच्चों को पढ़ाने का एक्सपीरियंस है। इस कोर्स में कंप्लीट प्रिपरेशन, सिलेबस, नोट्स का लिंक डिस्क्रिप्शन में मिलेगा। लाइक, सब्सक्राइब और चैनल को सपोर्ट करिए।`;
const instructionalIntro = `डेटा स्ट्रक्चर और एल्गोरिथम बहुत महत्वपूर्ण हैं। एरे, स्टैक या क्यू पर सीधे नहीं जा रहे। पहले समझते हैं कि डेटा स्ट्रक्चर क्या है और कैसे काम करता है।`;
assert.equal(analyzeTranscriptRelevance(promotionalIntro).shouldSuppressFrames, true,
  'a clearly promotional segment with no instructional signal must not produce an automatic study screenshot');
assert.equal(analyzeTranscriptRelevance(instructionalIntro).shouldSuppressFrames, false,
  'an instructional segment must remain eligible for frame selection');
console.log('Study-frame scoring, transcript promotion gate and perceptual duplicate tests passed.');
