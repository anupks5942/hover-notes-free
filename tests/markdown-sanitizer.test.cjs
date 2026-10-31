const assert = require('node:assert/strict');
const test = require('node:test');
const sanitizer = require('../sidebar/markdown-sanitizer.js');

const baseUrl = 'chrome-extension://abcdefghijklmnop/sidebar/sidebar.html';

test('allows ordinary external links and mailto links', () => {
  assert.equal(sanitizer.isSafeLinkUrl('https://www.youtube.com/watch?v=abc', baseUrl), true);
  assert.equal(sanitizer.isSafeLinkUrl('http://example.com/path', baseUrl), true);
  assert.equal(sanitizer.isSafeLinkUrl('mailto:notes@example.com', baseUrl), true);
});

test('rejects executable and non-web link schemes', () => {
  for (const value of [
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///C:/Windows/win.ini',
    'vbscript:msgbox(1)',
    'chrome-extension://abcdefghijklmnop/sidebar/sidebar.html'
  ]) {
    assert.equal(sanitizer.isSafeLinkUrl(value, baseUrl), false, value);
  }
});

test('allows raster image data URLs, HTTP(S), and same-extension assets', () => {
  assert.equal(sanitizer.isSafeImageUrl('data:image/png;base64,AAAA', baseUrl), true);
  assert.equal(sanitizer.isSafeImageUrl('data:image/jpeg;base64,AAAA', baseUrl), true);
  assert.equal(sanitizer.isSafeImageUrl('https://example.com/slide.jpg', baseUrl), true);
  assert.equal(sanitizer.isSafeImageUrl('images/slide.png', baseUrl), true);
  assert.equal(sanitizer.isSafeImageUrl('blob:chrome-extension://abcdefghijklmnop/frame-id', baseUrl), true);
});

test('rejects active SVG data, script schemes, file URLs, and cross-origin Blob URLs', () => {
  for (const value of [
    'data:image/svg+xml;base64,PHN2Zz4=',
    'javascript:alert(1)',
    'file:///C:/secret.png',
    'blob:https://attacker.example/id'
  ]) {
    assert.equal(sanitizer.isSafeImageUrl(value, baseUrl), false, value);
  }
});
