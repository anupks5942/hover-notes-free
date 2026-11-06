const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const base = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(base, 'content', 'content.js'), 'utf8');
const mainSource = fs.readFileSync(path.join(base, 'content', 'youtube-main.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(base, 'manifest.json'), 'utf8'));

assert(source.includes("message.source !== '__HOVERNOTES_MAIN__'"), 'isolated script must receive MAIN-world bridge messages');
assert(source.includes("type: 'REQUEST_CAPTION_BODY'"), 'isolated script must request the selected player caption track');
assert(source.includes('waitForPlayerCaptionBody'), 'caption request must wait for the player-issued response');
assert(!source.includes("document.createElement('script')"), 'no CSP-blocked inline script injection may remain');
assert(!source.includes('await fetch(jsonUrl)'), 'must not fetch a token-less base URL directly');
assert(!source.includes('await fetch(bestTrack.baseUrl)'), 'must not directly fetch captionTracks[].baseUrl');
assert(mainSource.includes("url.pathname !== '/api/timedtext'"), 'MAIN observer must restrict interception to YouTube timedtext');
assert(mainSource.includes('response.clone()'), 'fetch observer must not consume the response used by YouTube');
assert(mainSource.includes("player.setOption('captions', 'track', match)"), 'must activate captions through YouTube player API');
assert(!mainSource.includes('pot='), 'PO token values must never be synthesized or embedded in source');
assert(manifest.content_scripts.some(entry => entry.world === 'MAIN' && entry.run_at === 'document_start' && entry.js.includes('content/youtube-main.js')), 'MAIN observer must be a static document_start content script');
assert(manifest.version === '1.0.32', 'manifest version must match this build');
assert(manifest.minimum_chrome_version === '111', 'MAIN world manifest content scripts require Chrome 111+');

const ui = fs.readFileSync(path.join(base, 'sidebar', 'sidebar.html'), 'utf8');
assert(ui.includes(`v${manifest.version}`), 'visible UI version must match manifest');
assert(mainSource.includes('CAPTION_BODY_START') && mainSource.includes('CAPTION_BODY_CHUNK'), 'large player caption bodies must use chunked transfer');
assert(source.includes('CAPTION_BODY_START') && source.includes('CAPTION_BODY_CHUNK'), 'isolated script must reassemble chunked caption bodies');
console.log('PASS: current-build static MAIN-world observer, chunked large-body relay and no token-less caption refetch.');
