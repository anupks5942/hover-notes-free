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
  let expectedVideoId = '';
  let expectedLanguage = '';

  // Active caption requests waiting for correlated network responses.
  // requestId -> { requestId, videoId, languageCode, vssId, kind, format, activatedAt }
  const activeCaptionRequests = new Map();

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
      const fmtParam = url.searchParams.get('fmt');
      return {
        videoId: url.searchParams.get('v') || url.searchParams.get('video_id') || expectedVideoId || currentVideoId(),
        languageCode: url.searchParams.get('lang') || '',
        format: fmtParam !== null ? String(fmtParam).trim() : '',
        vssId: url.searchParams.get('vss_id') || url.searchParams.get('vssId') || '',
        kind: url.searchParams.get('kind') || ''
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

  const REQUEST_TTL_MS = 60000;

  function findMatchingRequestContext(meta) {
    if (!meta) return null;
    const now = Date.now();
    const candidates = [];
    for (const [id, req] of activeCaptionRequests) {
      if (req.activatedAt && (now - req.activatedAt > REQUEST_TTL_MS)) {
        activeCaptionRequests.delete(id);
        continue;
      }
      if (!req.videoId || !meta.videoId || req.videoId === meta.videoId) {
        candidates.push(req);
      }
    }
    if (candidates.length === 0) return null;

    // Rule 1: Explicit vssId in URL
    // When meta.vssId is present, require an exact vssId match.
    // If no exact match exists, return null immediately.
    // Never fall back to language or kind after an explicit vssId mismatch!
    if (meta.vssId) {
      const vssMatch = candidates.find(c => c.vssId && c.vssId === meta.vssId);
      if (vssMatch) {
        if (meta.languageCode && vssMatch.languageCode && meta.languageCode !== vssMatch.languageCode) {
          log('Explicit vssId matched but languageCode conflicted; rejected', {
            vssId: meta.vssId, urlLang: meta.languageCode, reqLang: vssMatch.languageCode
          });
          return null;
        }
        return vssMatch;
      }
      log('Explicit URL vssId did not match any active request; rejected', {
        urlVssId: meta.vssId,
        candidateVssIds: candidates.map(c => c.vssId)
      });
      return null;
    }

    // Rule 2: Explicit kind in URL
    // When meta.kind is present and language metadata is available:
    // Require compatible kind and language. If explicit metadata conflicts with the active request, reject it.
    if (meta.kind) {
      const kindMatches = candidates.filter(c => {
        if (c.kind && c.kind !== meta.kind) return false;
        if (meta.languageCode && c.languageCode && meta.languageCode !== c.languageCode) return false;
        return true;
      });
      if (kindMatches.length === 1) return kindMatches[0];
      if (kindMatches.length > 1) {
        log('Ambiguous active caption requests for explicit kind; rejected', { kind: meta.kind, count: kindMatches.length });
        return null;
      }
      log('Explicit URL kind conflicted with active request(s); rejected', { urlKind: meta.kind });
      return null;
    }

    // Rule 3: URL does not expose vssId or kind
    // Language fallback is permissible only when exactly one valid, unexpired active context exists for that video/language.
    // More than one candidate means reject as ambiguous.
    // Never select the first candidate merely because it appears first in the Map.
    const langMatches = candidates.filter(c => {
      if (meta.languageCode && c.languageCode && meta.languageCode !== c.languageCode) return false;
      return true;
    });

    if (langMatches.length === 1) {
      return langMatches[0];
    }

    if (langMatches.length > 1) {
      log('Ambiguous active caption requests for timed-text response without track identity; correlation rejected', {
        videoId: meta.videoId,
        languageCode: meta.languageCode,
        candidatesCount: langMatches.length
      });
      return null;
    }

    return null;
  }

  function captureTimedText(rawUrl, responseMeta, bodyPromise) {
    const meta = parseTimedTextUrl(rawUrl);
    if (!meta) return;
    const reqCtx = responseMeta?.requestContext;
    if (expectedVideoId && meta.videoId && meta.videoId !== expectedVideoId) return;

    if (reqCtx) {
      // Check if the request was cancelled before reading the body
      if (reqCtx.requestId && !activeCaptionRequests.has(reqCtx.requestId)) {
        log('Timed-text response ignored: request context was cancelled or expired before body read', {
          requestId: reqCtx.requestId
        });
        return;
      }

      // Preserve actual response identity & reject explicit metadata conflicts
      if (meta.vssId && reqCtx.vssId && meta.vssId !== reqCtx.vssId) {
        log('Timed-text response rejected: URL vssId conflicts with request context', {
          requestId: reqCtx.requestId,
          observedVssId: meta.vssId,
          requestedVssId: reqCtx.vssId
        });
        if (reqCtx.requestId) activeCaptionRequests.delete(reqCtx.requestId);
        return;
      }
      if (meta.kind && reqCtx.kind && meta.kind !== reqCtx.kind) {
        log('Timed-text response rejected: URL kind conflicts with request context', {
          requestId: reqCtx.requestId,
          observedKind: meta.kind,
          requestedKind: reqCtx.kind
        });
        if (reqCtx.requestId) activeCaptionRequests.delete(reqCtx.requestId);
        return;
      }
      if (meta.languageCode && reqCtx.languageCode && meta.languageCode !== reqCtx.languageCode) {
        log('Timed-text response rejected: URL language conflicts with request context', {
          requestId: reqCtx.requestId,
          observedLang: meta.languageCode,
          requestedLang: reqCtx.languageCode
        });
        if (reqCtx.requestId) activeCaptionRequests.delete(reqCtx.requestId);
        return;
      }
    }

    Promise.resolve(bodyPromise).then(body => {
      // Check again after body promise resolves: request may have been cancelled during network read!
      if (reqCtx && reqCtx.requestId) {
        if (!activeCaptionRequests.has(reqCtx.requestId)) {
          log('Timed-text response ignored: request context was cancelled while reading body', {
            requestId: reqCtx.requestId
          });
          return;
        }
        activeCaptionRequests.delete(reqCtx.requestId);
      }

      const text = typeof body === 'string' ? body : '';
      const payload = {
        requestId: reqCtx?.requestId || '',
        vssId: meta.vssId || reqCtx?.vssId || '',
        observedVssId: meta.vssId || '',
        requestedVssId: reqCtx?.vssId || '',
        kind: meta.kind || reqCtx?.kind || '',
        observedKind: meta.kind || '',
        requestedKind: reqCtx?.kind || '',
        videoId: meta.videoId || reqCtx.videoId || expectedVideoId || '',
        languageCode: meta.languageCode || reqCtx.languageCode || expectedLanguage || '',
        format: typeof meta.format === 'string' ? meta.format : '',
        status: Number(responseMeta?.status || 0),
        contentType: String(responseMeta?.contentType || ''),
        transport: String(responseMeta?.transport || 'unknown'),
        body: text.length <= MAX_BODY_CHARS ? text : '',
        bodyTooLarge: text.length > MAX_BODY_CHARS,
        responseCharacters: text.length,
        capturedAt: Date.now()
      };

      log('Timed-text response observed', {
        requestId: payload.requestId,
        vssId: payload.vssId || 'unknown',
        kind: payload.kind || 'unknown',
        videoId: payload.videoId,
        languageCode: payload.languageCode,
        format: payload.format || 'absent',
        status: payload.status,
        contentType: payload.contentType,
        responseCharacters: text.length,
        chunked: text.length > CHUNK_BODY_CHARS && text.length <= MAX_BODY_CHARS,
        transport: payload.transport
      });

      sendCaptionBody(payload);
    }).catch(error => {
      if (reqCtx?.requestId) {
        if (!activeCaptionRequests.has(reqCtx.requestId)) {
          return;
        }
        activeCaptionRequests.delete(reqCtx.requestId);
      }
      log('Could not read observed timed-text response', {
        requestId: reqCtx?.requestId || 'none',
        videoId: meta.videoId || expectedVideoId || '',
        languageCode: meta.languageCode || expectedLanguage || '',
        format: meta.format || 'absent',
        error: String(error?.message || error)
      });
      send('CAPTION_BODY', {
        requestId: reqCtx?.requestId || '',
        vssId: meta.vssId || reqCtx?.vssId || '',
        observedVssId: meta.vssId || '',
        requestedVssId: reqCtx?.vssId || '',
        kind: meta.kind || reqCtx?.kind || '',
        observedKind: meta.kind || '',
        requestedKind: reqCtx?.kind || '',
        videoId: meta.videoId || expectedVideoId || '',
        languageCode: meta.languageCode || expectedLanguage || '',
        format: typeof meta.format === 'string' ? meta.format : '',
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
      const meta = parseTimedTextUrl(rawUrl);
      const matchedReq = meta ? findMatchingRequestContext(meta) : null;
      const requestSnapshot = matchedReq ? { ...matchedReq } : null;
      const result = Reflect.apply(nativeFetch, this, args);
      if (meta) {
        result.then(response => {
          let clone;
          try { clone = response.clone(); } catch (_) { return; }
          const contentType = response.headers?.get?.('content-type') || '';
          captureTimedText(rawUrl, {
            status: response.status,
            contentType,
            transport: 'fetch',
            requestContext: requestSnapshot
          }, clone.text());
        }).catch(error => {
          captureTimedText(rawUrl, { status: 0, transport: 'fetch', requestContext: requestSnapshot }, Promise.reject(error));
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
      const meta = parseTimedTextUrl(rawUrl);
      if (meta) {
        const matchedReq = findMatchingRequestContext(meta);
        this.__hoverNotesRequestContext = matchedReq ? { ...matchedReq } : null;
        this.addEventListener('loadend', () => {
          const reqSnapshot = this.__hoverNotesRequestContext;
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
            transport: 'xhr',
            requestContext: reqSnapshot
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

  function activateCaptionTrack(videoId, languageCode, vssId, kind, requestId, forceReactivation = false) {
    expectedVideoId = videoId || currentVideoId();
    expectedLanguage = languageCode || '';
    const deadline = Date.now() + 25000;

    const attempt = () => {
      if (expectedVideoId !== (videoId || currentVideoId())) return;
      const player = getPlayer();
      const trackList = getPlayerTrackList(player);

      let match = null;
      if (vssId) {
        // When an explicit vssId is requested: search for exact vssId first.
        // Never let a language-only match override it!
        match = trackList.find(t => t.vssId === vssId);
        if (!match) {
          // Exact track is unavailable: report track-selection failure.
          // Do not silently select a different track merely because it shares the language.
          log('Explicit vssId not found in player tracklist', { vssId, languageCode, availableCount: trackList.length });
          send('CAPTION_ACTIVATION', {
            requestId: requestId || '',
            videoId: expectedVideoId,
            ok: false,
            reason: `Requested caption track (${vssId}) was not found in the YouTube player tracklist.`,
            trackCount: trackList.length
          });
          if (requestId) activeCaptionRequests.delete(requestId);
          return;
        }
      } else {
        // Deterministic language/kind fallback when no vssId is available:
        match = trackList.find(t => t.languageCode === languageCode && t.kind !== 'asr');
        if (!match) match = trackList.find(t => t.languageCode === languageCode);
        if (!match) match = trackList.find(t => languageCode && String(t.languageCode || '').startsWith(languageCode.split('-')[0]));
      }

      if (!player || typeof player.setOption !== 'function' || !match) {
        if (Date.now() < deadline) {
          setTimeout(attempt, 500);
        } else {
          send('CAPTION_ACTIVATION', {
            requestId: requestId || '',
            videoId: expectedVideoId,
            ok: false,
            reason: !player || typeof player.setOption !== 'function'
              ? 'YouTube player caption controls did not become available.'
              : 'The YouTube player did not expose the selected caption track.',
            trackCount: trackList.length
          });
          if (requestId) activeCaptionRequests.delete(requestId);
        }
        return;
      }

      try {
        try { player.loadModule?.('captions'); } catch (_) {}
        if (forceReactivation) {
          // Safe player-supported reactivation sequence: clear track, then set desired track to trigger player request
          try { player.setOption('captions', 'track', {}); } catch (_) {}
          setTimeout(() => {
            try { player.loadModule?.('captions'); } catch (_) {}
            player.setOption('captions', 'track', match);
          }, 50);
        } else {
          player.setOption('captions', 'track', match);
        }

        send('CAPTION_ACTIVATION', {
          requestId: requestId || '',
          videoId: expectedVideoId,
          ok: true,
          languageCode: match.languageCode || languageCode || '',
          vssId: match.vssId || vssId || '',
          kind: match.kind || kind || '',
          trackCount: trackList.length
        });
        log('Requested captions through the YouTube player', {
          requestId: requestId || 'none',
          videoId: expectedVideoId,
          languageCode: match.languageCode || languageCode || '',
          vssId: match.vssId || vssId || '',
          kind: match.kind || kind || '',
          trackCount: trackList.length,
          forceReactivation
        });
      } catch (error) {
        send('CAPTION_ACTIVATION', {
          requestId: requestId || '',
          videoId: expectedVideoId,
          ok: false,
          reason: String(error?.message || error),
          trackCount: trackList.length
        });
        if (requestId) activeCaptionRequests.delete(requestId);
      }
    };

    attempt();
    return true;
  }

  let lastObservedVideoId = '';
  function handleVideoTransition(newVid) {
    if (newVid && newVid !== lastObservedVideoId) {
      lastObservedVideoId = newVid;
      if (activeCaptionRequests.size > 0) {
        log('Clearing all active caption requests due to video transition', { newVideo: newVid, count: activeCaptionRequests.size });
        activeCaptionRequests.clear();
      }
    }
  }

  window.addEventListener('yt-navigate-finish', () => {
    handleVideoTransition(currentVideoId());
  });
  window.addEventListener('yt-navigate-start', () => {
    handleVideoTransition(currentVideoId());
  });

  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data;
    if (!message || message.source !== IN) return;

    if (message.type === 'GET_CAPTION_TRACKS') {
      sendTracks(String(message.videoId || currentVideoId()));
      return;
    }

    if (message.type === 'CANCEL_CAPTION_REQUEST') {
      const requestId = String(message.requestId || '');
      const videoId = String(message.videoId || '');
      if (requestId && activeCaptionRequests.has(requestId)) {
        const req = activeCaptionRequests.get(requestId);
        if (!videoId || !req.videoId || req.videoId === videoId) {
          activeCaptionRequests.delete(requestId);
          log('Active caption request cancelled by isolated script', { requestId, videoId });
        }
      }
      return;
    }

    if (message.type === 'REQUEST_CAPTION_BODY') {
      const requestId = String(message.requestId || ('req-bridge-' + Math.random().toString(36).slice(2)));
      const videoId = String(message.videoId || currentVideoId());
      const languageCode = String(message.languageCode || '');
      const vssId = String(message.vssId || '');
      const kind = String(message.kind || '');
      const requestedFormat = String(message.format || '');
      const forceReactivation = Boolean(message.forceReactivation);

      expectedVideoId = videoId;
      expectedLanguage = languageCode;

      if (requestId) {
        activeCaptionRequests.set(requestId, {
          requestId,
          videoId,
          languageCode,
          vssId,
          kind,
          format: requestedFormat,
          activatedAt: Date.now()
        });
        const expireThreshold = Date.now() - 120000;
        for (const [id, req] of activeCaptionRequests) {
          if (req.activatedAt < expireThreshold) activeCaptionRequests.delete(id);
        }
      }

      log('Caption body requested through player', {
        requestId: requestId || 'none',
        videoId,
        languageCode,
        vssId: vssId || 'none',
        kind: kind || 'none',
        format: requestedFormat || 'any',
        forceReactivation
      });

      // No unvalidated raw response reuse! Always perform fresh track activation.
      activateCaptionTrack(videoId, languageCode, vssId, kind, requestId, forceReactivation);
    }
  });

  if (typeof window !== 'undefined' && window.__HOVERNOTES_MAIN_TEST_HOOKS__) {
    window.__HOVERNOTES_MAIN_TEST_HOOKS__.activeCaptionRequests = activeCaptionRequests;
    window.__HOVERNOTES_MAIN_TEST_HOOKS__.findMatchingRequestContext = findMatchingRequestContext;
    window.__HOVERNOTES_MAIN_TEST_HOOKS__.captureTimedText = captureTimedText;
    window.__HOVERNOTES_MAIN_TEST_HOOKS__.parseTimedTextUrl = parseTimedTextUrl;
    window.__HOVERNOTES_MAIN_TEST_HOOKS__.handleVideoTransition = handleVideoTransition;
    Object.defineProperty(window.__HOVERNOTES_MAIN_TEST_HOOKS__, 'expectedVideoId', {
      get() { return expectedVideoId; },
      set(v) { expectedVideoId = v; }
    });
  }

  // Expose only diagnostics, not tokens, URLs, cookies, or response bodies.
  log('MAIN-world observer installed', { runAt: 'document_start', bridge: 'v1' });
})();
