/**
 * HoverNotes MAIN-world YouTube caption observer.
 * Runs as a static Chrome MV3 MAIN-world content script at document_start.
 * It never creates inline <script> elements and never exposes/logs PO tokens.
 * The isolated content script requests tracks and caption activation over postMessage.
 */
(() => {
  'use strict';

  if (window.__HOVERNOTES_MAIN_BRIDGE_V1__) return;
  window.__HOVERNOTES_MAIN_BRIDGE_V1__ = true;

  const OUT = '__HOVERNOTES_MAIN__';
  const IN = '__HOVERNOTES_ISOLATED__';
  // YouTube JSON3 caption responses can be large (the user's 60-minute Hindi
  // lecture returned ~14 MB). Relay large bodies in small same-window chunks.
  const MAX_BODY_CHARS = 40 * 1024 * 1024;
  const CHUNK_BODY_CHARS = 192 * 1024;
  const MAX_CACHED_BODIES = 2;
  let expectedVideoId = '';
  let expectedLanguage = '';
  const capturedCaptionBodies = new Map();

  const log = (label, details = {}) => {
    // Deliberately omit full URLs and all query values (including PO tokens).
    console.info(`[HoverNotes Player Bridge] ${label}`, details);
  };

  function getPlayer() {
    return document.getElementById('movie_player') ||
      document.querySelector('ytd-player #movie_player') ||
      document.querySelector('ytd-player');
  }

  function getPlayerResponse() {
    const player = getPlayer();
    try {
      const fromPlayer = player?.getPlayerResponse?.();
      if (fromPlayer) return fromPlayer;
    } catch (_) {}
    try {
      const fromApp = document.querySelector('ytd-app')?.__data?.playerResponse;
      if (fromApp) return fromApp;
    } catch (_) {}
    try {
      const raw = window.ytplayer?.config?.args?.raw_player_response;
      if (raw) return JSON.parse(raw);
    } catch (_) {}
    return window.ytInitialPlayerResponse || null;
  }

  function currentVideoId() {
    try {
      const fromUrl = new URL(location.href).searchParams.get('v');
      if (fromUrl) return fromUrl;
    } catch (_) {}
    return getPlayerResponse()?.videoDetails?.videoId || expectedVideoId || '';
  }

  function getCaptionTracks() {
    const candidates = [];
    try { candidates.push(getPlayer()?.getPlayerResponse?.()); } catch (_) {}
    try { candidates.push(document.querySelector('ytd-app')?.__data?.playerResponse); } catch (_) {}
    candidates.push(window.ytInitialPlayerResponse || null);
    try {
      const raw = window.ytplayer?.config?.args?.raw_player_response;
      if (raw) candidates.push(JSON.parse(raw));
    } catch (_) {}

    for (const response of candidates) {
      const tracks = response?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      if (Array.isArray(tracks) && tracks.length) return tracks;
    }
    return [];
  }

  function safeTrack(track) {
    return {
      languageCode: String(track?.languageCode || ''),
      kind: String(track?.kind || ''),
      vssId: String(track?.vssId || ''),
      name: String(track?.name?.simpleText || track?.name?.runs?.map(r => r.text || '').join('') || '')
    };
  }

  function send(type, payload = {}) {
    window.postMessage({ source: OUT, type, ...payload }, location.origin);
  }

  function parseTimedTextUrl(rawUrl) {
    try {
      const url = new URL(rawUrl, location.href);
      if (!/(^|\.)youtube\.com$/i.test(url.hostname) || url.pathname !== '/api/timedtext') return null;
      return {
        videoId: url.searchParams.get('v') || url.searchParams.get('video_id') || expectedVideoId || currentVideoId(),
        languageCode: url.searchParams.get('lang') || '',
        format: url.searchParams.get('fmt') || 'default'
      };
    } catch (_) {
      return null;
    }
  }

  function sendCaptionBody(payload) {
    const body = typeof payload.body === 'string' ? payload.body : '';
    if (!body || body.length <= CHUNK_BODY_CHARS) {
      send('CAPTION_BODY', payload);
      return;
    }

    const transferId = (globalThis.crypto?.randomUUID?.() ||
      `${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const totalChunks = Math.ceil(body.length / CHUNK_BODY_CHARS);
    const metadata = { ...payload };
    delete metadata.body;
    send('CAPTION_BODY_START', {
      ...metadata,
      transferId,
      totalChunks,
      chunkCharacters: CHUNK_BODY_CHARS
    });

    let index = 0;
    const sendNextChunk = () => {
      if (index >= totalChunks) {
        log('Chunked caption body relay completed', {
          videoId: payload.videoId,
          languageCode: payload.languageCode,
          responseCharacters: body.length,
          totalChunks
        });
        return;
      }
      const start = index * CHUNK_BODY_CHARS;
      const chunk = body.slice(start, start + CHUNK_BODY_CHARS);
      send('CAPTION_BODY_CHUNK', { transferId, index, chunk });
      index += 1;
      // Yield between chunks so the page/player remains responsive.
      setTimeout(sendNextChunk, 0);
    };
    sendNextChunk();
  }

  function captureTimedText(rawUrl, responseMeta, bodyPromise) {
    const meta = parseTimedTextUrl(rawUrl);
    if (!meta) return;
    if (expectedVideoId && meta.videoId && meta.videoId !== expectedVideoId) return;
    if (expectedLanguage && meta.languageCode && meta.languageCode !== expectedLanguage) return;

    Promise.resolve(bodyPromise).then(body => {
      const text = typeof body === 'string' ? body : '';
      const payload = {
        videoId: meta.videoId || expectedVideoId || '',
        languageCode: meta.languageCode || expectedLanguage || '',
        status: Number(responseMeta?.status || 0),
        contentType: String(responseMeta?.contentType || ''),
        transport: String(responseMeta?.transport || 'unknown'),
        body: text.length <= MAX_BODY_CHARS ? text : '',
        bodyTooLarge: text.length > MAX_BODY_CHARS,
        responseCharacters: text.length
      };
      if (payload.body.trim() && payload.status >= 200 && payload.status < 300) {
        const cacheKey = `${payload.videoId}::${payload.languageCode}`;
        capturedCaptionBodies.set(cacheKey, { ...payload, capturedAt: Date.now() });
        while (capturedCaptionBodies.size > MAX_CACHED_BODIES) {
          capturedCaptionBodies.delete(capturedCaptionBodies.keys().next().value);
        }
      }
      log('Timed-text response observed', {
        videoId: meta.videoId || expectedVideoId || '',
        languageCode: meta.languageCode || expectedLanguage || '',
        format: meta.format,
        status: Number(responseMeta?.status || 0),
        contentType: String(responseMeta?.contentType || ''),
        responseCharacters: text.length,
        chunked: text.length > CHUNK_BODY_CHARS && text.length <= MAX_BODY_CHARS,
        transport: responseMeta?.transport || 'unknown'
      });

      sendCaptionBody(payload);
    }).catch(error => {
      log('Could not read observed timed-text response', {
        videoId: meta.videoId || expectedVideoId || '',
        languageCode: meta.languageCode || expectedLanguage || '',
        error: String(error?.message || error)
      });
      send('CAPTION_BODY', {
        videoId: meta.videoId || expectedVideoId || '',
        languageCode: meta.languageCode || expectedLanguage || '',
        status: Number(responseMeta?.status || 0),
        contentType: String(responseMeta?.contentType || ''),
        transport: String(responseMeta?.transport || 'unknown'),
        body: '',
        responseCharacters: 0,
        readError: String(error?.message || error)
      });
    });
  }

  // Observe native fetch responses without consuming the response used by YouTube.
  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function (...args) {
      let rawUrl = '';
      try {
        rawUrl = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
      } catch (_) {}
      const result = Reflect.apply(nativeFetch, this, args);
      if (parseTimedTextUrl(rawUrl)) {
        result.then(response => {
          let clone;
          try { clone = response.clone(); } catch (_) { return; }
          const contentType = response.headers?.get?.('content-type') || '';
          captureTimedText(rawUrl, {
            status: response.status,
            contentType,
            transport: 'fetch'
          }, clone.text());
        }).catch(error => {
          captureTimedText(rawUrl, { status: 0, transport: 'fetch' }, Promise.reject(error));
        });
      }
      return result;
    };
  }

  // Observe XHR timed-text responses as a fallback for player versions using XHR.
  const xhrProto = window.XMLHttpRequest?.prototype;
  if (xhrProto && !xhrProto.__hoverNotesPatched) {
    const nativeOpen = xhrProto.open;
    const nativeSend = xhrProto.send;
    xhrProto.open = function (method, url, ...rest) {
      this.__hoverNotesTimedTextUrl = String(url || '');
      return Reflect.apply(nativeOpen, this, [method, url, ...rest]);
    };
    xhrProto.send = function (...args) {
      const rawUrl = this.__hoverNotesTimedTextUrl || '';
      if (parseTimedTextUrl(rawUrl)) {
        this.addEventListener('loadend', () => {
          let body = '';
          try {
            if (this.responseType === '' || this.responseType === 'text') body = this.responseText || '';
            else if (this.responseType === 'json') body = JSON.stringify(this.response || {});
            else if (this.responseType === 'arraybuffer' && this.response) body = new TextDecoder().decode(this.response);
            else if (this.responseType === 'blob' && this.response?.text) body = this.response.text();
          } catch (_) {}
          let contentType = '';
          try { contentType = this.getResponseHeader('content-type') || ''; } catch (_) {}
          captureTimedText(rawUrl, {
            status: this.status,
            contentType,
            transport: 'xhr'
          }, body);
        }, { once: true });
      }
      return Reflect.apply(nativeSend, this, args);
    };
    Object.defineProperty(xhrProto, '__hoverNotesPatched', { value: true });
  }

  function sendTracks(videoId) {
    const targetVideoId = videoId || currentVideoId();
    expectedVideoId = targetVideoId;
    expectedLanguage = '';
    const requestedAt = Date.now();
    const deadline = requestedAt + 25000;
    const attempt = () => {
      if (currentVideoId() && currentVideoId() !== targetVideoId) return;
      const tracks = getCaptionTracks();
      if (tracks.length > 0 || Date.now() >= deadline) {
        send('CAPTION_TRACKS', {
          videoId: targetVideoId,
          tracks: tracks.map(safeTrack),
          trackCount: tracks.length
        });
        log('Caption track metadata returned', {
          videoId: targetVideoId,
          trackCount: tracks.length,
          languages: tracks.map(t => t.languageCode).filter(Boolean),
          waitedMs: Date.now() - requestedAt
        });
        return;
      }
      // During a pre-roll ad, YouTube can temporarily expose an ad player with
      // no lecture caption tracks. Retry until the actual video player is ready.
      setTimeout(attempt, 500);
    };
    attempt();
  }

  function getPlayerTrackList(player) {
    try {
      const list = player?.getOption?.('captions', 'tracklist');
      if (Array.isArray(list) && list.length) return list;
    } catch (_) {}
    return getCaptionTracks();
  }

  function activateCaptionTrack(videoId, languageCode, vssId) {
    expectedVideoId = videoId || currentVideoId();
    expectedLanguage = languageCode || '';
    const deadline = Date.now() + 25000;

    const attempt = () => {
      if (expectedVideoId !== (videoId || currentVideoId())) return;
      const player = getPlayer();
      let trackList = getPlayerTrackList(player);
      const match = trackList.find(track =>
        (languageCode && track.languageCode === languageCode) ||
        (vssId && track.vssId === vssId)
      ) || trackList.find(track => languageCode && String(track.languageCode || '').startsWith(languageCode.split('-')[0]));

      if (!player || typeof player.setOption !== 'function' || !match) {
        if (Date.now() < deadline) {
          // The player can be temporarily owned by a pre-roll ad. Wait for the
          // lecture's own caption tracks/player API to become available.
          setTimeout(attempt, 500);
        } else {
          send('CAPTION_ACTIVATION', {
            videoId: expectedVideoId,
            ok: false,
            reason: !player || typeof player.setOption !== 'function'
              ? 'YouTube player caption controls did not become available.'
              : 'The YouTube player did not expose the selected caption track.',
            trackCount: trackList.length
          });
        }
        return;
      }

      try {
        // Ask YouTube's own player to load the selected track. The observer
        // captures its token-bearing response; we never synthesize PO tokens.
        try { player.loadModule?.('captions'); } catch (_) {}
        player.setOption('captions', 'track', match);
        send('CAPTION_ACTIVATION', {
          videoId: expectedVideoId,
          ok: true,
          languageCode: match.languageCode || languageCode || '',
          trackCount: trackList.length
        });
        log('Requested captions through the YouTube player', {
          videoId: expectedVideoId,
          languageCode: match.languageCode || languageCode || '',
          trackCount: trackList.length
        });
      } catch (error) {
        send('CAPTION_ACTIVATION', {
          videoId: expectedVideoId,
          ok: false,
          reason: String(error?.message || error),
          trackCount: trackList.length
        });
      }
    };

    attempt();
    return true;
  }

  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data;
    if (!message || message.source !== IN) return;

    if (message.type === 'GET_CAPTION_TRACKS') {
      sendTracks(String(message.videoId || currentVideoId()));
      return;
    }

    if (message.type === 'REQUEST_CAPTION_BODY') {
      const videoId = String(message.videoId || currentVideoId());
      const languageCode = String(message.languageCode || '');
      const vssId = String(message.vssId || '');
      expectedVideoId = videoId;
      expectedLanguage = languageCode;
      log('Caption body requested through player', { videoId, languageCode });
      const cached = capturedCaptionBodies.get(`${videoId}::${languageCode}`);
      if (cached?.body?.trim() && Date.now() - cached.capturedAt < 10 * 60 * 1000) {
        log('Reusing already observed player caption response', {
          videoId,
          languageCode,
          responseCharacters: cached.responseCharacters
        });
        sendCaptionBody(cached);
        return;
      }
      activateCaptionTrack(videoId, languageCode, vssId);
    }
  });

  // Expose only diagnostics, not tokens, URLs, cookies, or response bodies.
  log('MAIN-world observer installed', { runAt: 'document_start', bridge: 'v1' });
})();
