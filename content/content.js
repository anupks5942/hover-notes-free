/**
 * HoverNotes Clone - Production Content Script
 * Handles YouTube MAIN-world transcript extraction, compressed JPEG frame capture,
 * split-screen UI integration, and bidirectional bridge messaging.
 */

(() => {
  if (window.__hoverNotesLoaded) return;
  window.__hoverNotesLoaded = true;

  let sidebarIframe = null;
  let isSplitActive = false;
  let currentVideoId = '';
  
  // Transcript cache: videoId -> Array<{ start: number, duration: number, text: string }>
  const transcriptCache = new Map();
  const transcriptPerformanceCache = new Map();
  // Caption tracks cache: videoId -> Array<CaptionTrack>
  const captionTracksCache = new Map();
  const transcriptDiagnostics = new Map();
  const captionBodyWaiters = new Map();
  const lastCaptionBodies = new Map();
  const captionBodyTransfers = new Map();
  const MAX_CAPTION_BODY_CHARS = 40 * 1024 * 1024;
  const captionActivationDiagnostics = new Map();
  let studyFrameSamplerTimer = null;
  let studyFrameSamplerActive = false;
  let studyFrameSamplingBusy = false;
  const studyFrameCandidates = new Map(); // minute bucket -> best visually useful frame
  const usedStudyFrameFingerprints = []; // compact perceptual fingerprints of saved slides
  const MAX_STUDY_FRAME_BUCKETS = 20;
  const STUDY_FRAME_DUPLICATE_DISTANCE = 10;
  const STUDY_FRAME_MOTION_DUPLICATE_DISTANCE = 25;
  const STUDY_FRAME_REGION_DUPLICATE_DISTANCE = 21;

  function performanceNow() {
    return (typeof performance !== 'undefined' && typeof performance.now === 'function')
      ? performance.now()
      : Date.now();
  }

  // =========================================================================
  // Time and String Utilities
  // =========================================================================

  function formatTime(seconds) {
    if (isNaN(seconds) || seconds === null || seconds === undefined) return '00:00';
    const s = Math.floor(Math.max(0, seconds));
    const hrs = Math.floor(s / 3600);
    const mins = Math.floor((s % 3600) / 60);
    const secs = s % 60;
    if (hrs > 0) {
      return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  function decodeHtmlEntities(str) {
    if (!str) return '';
    const txt = document.createElement('textarea');
    txt.innerHTML = str;
    return txt.value
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\n+/g, ' ')
      .trim();
  }

  function extractVideoId(url = window.location.href) {
    try {
      const parsed = new URL(url);
      if (parsed.searchParams.has('v')) {
        return parsed.searchParams.get('v');
      }
      const parts = parsed.pathname.split('/');
      if (parts.includes('embed') || parts.includes('v') || parts.includes('live')) {
        return parts[parts.length - 1];
      }
      if (parsed.hostname === 'youtu.be') {
        return parts[1];
      }
    } catch (e) {}
    return '';
  }

  function getVideoElement() {
    return document.querySelector('video.html5-main-video') || document.querySelector('video');
  }

  function getVideoMetadata() {
    const video = getVideoElement();
    const videoId = extractVideoId();

    let videoTitle = '';
    const titleEl = document.querySelector('h1.ytd-watch-metadata yt-formatted-string') ||
                    document.querySelector('#title h1 yt-formatted-string') ||
                    document.querySelector('meta[name="title"]');
    if (titleEl) {
      videoTitle = titleEl.textContent || titleEl.getAttribute('content') || '';
    }
    if (!videoTitle) {
      videoTitle = document.title.replace(' - YouTube', '').trim();
    }

    let channelName = '';
    const channelEl = document.querySelector('#owner #channel-name yt-formatted-string a') ||
                      document.querySelector('ytd-channel-name yt-formatted-string a') ||
                      document.querySelector('#upload-info #channel-name a') ||
                      document.querySelector('meta[itemprop="channelId"]');
    if (channelEl) {
      channelName = channelEl.textContent ? channelEl.textContent.trim() : '';
    }

    const curTime = video ? video.currentTime : 0;
    const durTime = video ? (video.duration || 0) : 0;

    return {
      videoId: videoId || currentVideoId,
      videoTitle: videoTitle.trim() || 'Untitled YouTube Video',
      channelName: channelName || 'YouTube Creator',
      videoUrl: videoId ? `https://www.youtube.com/watch?v=${videoId}` : window.location.href,
      currentTime: curTime,
      timestampStr: formatTime(curTime),
      duration: durTime,
      durationStr: formatTime(durTime),
      paused: video ? video.paused : true,
      playbackRate: video ? video.playbackRate : 1.0
    };
  }

  // =========================================================================
  // Spec 1: Reliable MAIN-World Transcript Extraction & TimedText Parser
  // =========================================================================

  function deliverCaptionBody(payload) {
    const videoId = String(payload.videoId || '');
    const languageCode = String(payload.languageCode || '');
    if (!videoId || (currentVideoId && videoId !== currentVideoId)) return;
    const key = `${videoId}::${languageCode}`;
    const normalized = {
      status: Number(payload.status || 0),
      contentType: String(payload.contentType || ''),
      body: typeof payload.body === 'string' ? payload.body : '',
      responseCharacters: Number(payload.responseCharacters || 0),
      transport: String(payload.transport || 'unknown'),
      bodyTooLarge: Boolean(payload.bodyTooLarge),
      readError: String(payload.readError || '')
    };
    lastCaptionBodies.set(key, normalized);
    while (lastCaptionBodies.size > 2) {
      lastCaptionBodies.delete(lastCaptionBodies.keys().next().value);
    }
    const waiters = captionBodyWaiters.get(key) || [];
    if (normalized.body.trim() || normalized.status >= 400 || normalized.bodyTooLarge || normalized.readError) {
      captionBodyWaiters.delete(key);
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.resolve(normalized);
      }
    }
  }

  // MAIN-world bridge responses. The MAIN-world file is declared statically in
  // manifest.json at document_start; no inline script injection is used (YouTube CSP blocks it).
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const message = event.data;
    if (!message || message.source !== '__HOVERNOTES_MAIN__') return;

    if (message.type === 'CAPTION_TRACKS') {
      if (message.videoId && Array.isArray(message.tracks)) {
        captionTracksCache.set(message.videoId, message.tracks);
        console.info('[HoverNotes Captions] Player track metadata received', {
          videoId: message.videoId,
          trackCount: message.tracks.length,
          languages: message.tracks.map(t => t.languageCode).filter(Boolean)
        });
      }
      return;
    }

    if (message.type === 'CAPTION_ACTIVATION') {
      if (message.videoId) {
        captionActivationDiagnostics.set(message.videoId, message.ok
          ? `Player activation requested (${message.languageCode || 'selected track'}).`
          : String(message.reason || 'The YouTube player could not activate captions.'));
      }
      return;
    }

    if (message.type === 'CAPTION_TRANSFER_REJECTED') {
      deliverCaptionBody({
        videoId: String(message.videoId || ''), languageCode: String(message.languageCode || ''),
        status: 0, body: '', responseCharacters: 0,
        readError: String(message.reason || 'Caption transfer was rejected.')
      });
      return;
    }

    if (message.type === 'CAPTION_BODY_START') {
      const videoId = String(message.videoId || '');
      const languageCode = String(message.languageCode || '');
      const transferId = String(message.transferId || '');
      const totalChunks = Number(message.totalChunks || 0);
      const responseCharacters = Number(message.responseCharacters || 0);
      if (!videoId || !transferId || (currentVideoId && videoId !== currentVideoId)) return;
      if (!Number.isInteger(totalChunks) || totalChunks < 1 || totalChunks > 512 ||
          !Number.isFinite(responseCharacters) || responseCharacters < 1 || responseCharacters > MAX_CAPTION_BODY_CHARS) {
        deliverCaptionBody({
          videoId, languageCode, status: 0, body: '', responseCharacters: 0,
          readError: 'Invalid chunked caption transfer metadata.'
        });
        return;
      }
      // Keep only the active transfer to bound memory if YouTube emits multiple formats.
      for (const [oldId, oldTransfer] of captionBodyTransfers) {
        clearTimeout(oldTransfer.timer);
        captionBodyTransfers.delete(oldId);
      }
      const transfer = {
        videoId,
        languageCode,
        status: Number(message.status || 0),
        contentType: String(message.contentType || ''),
        transport: String(message.transport || 'unknown'),
        responseCharacters,
        totalChunks,
        chunks: new Array(totalChunks),
        received: new Set(),
        receivedCharacters: 0,
        timer: setTimeout(() => {
          captionBodyTransfers.delete(transferId);
          deliverCaptionBody({
            videoId, languageCode, status: transfer.status, contentType: transfer.contentType,
            transport: transfer.transport, body: '', responseCharacters: transfer.receivedCharacters,
            readError: `Chunked caption transfer timed out (${transfer.received.size}/${totalChunks} chunks).`
          });
        }, 60000)
      };
      captionBodyTransfers.set(transferId, transfer);
      console.info('[HoverNotes Captions] Receiving chunked player caption response', {
        videoId, languageCode, responseCharacters, totalChunks
      });
      return;
    }

    if (message.type === 'CAPTION_BODY_CHUNK') {
      const transferId = String(message.transferId || '');
      const transfer = captionBodyTransfers.get(transferId);
      if (!transfer || (currentVideoId && transfer.videoId !== currentVideoId)) return;
      const index = Number(message.index);
      const chunk = typeof message.chunk === 'string' ? message.chunk : '';
      if (!Number.isInteger(index) || index < 0 || index >= transfer.totalChunks ||
          !chunk || transfer.received.has(index)) return;
      transfer.chunks[index] = chunk;
      transfer.received.add(index);
      transfer.receivedCharacters += chunk.length;
      if (transfer.receivedCharacters > transfer.responseCharacters ||
          transfer.receivedCharacters > MAX_CAPTION_BODY_CHARS) {
        clearTimeout(transfer.timer);
        captionBodyTransfers.delete(transferId);
        deliverCaptionBody({
          videoId: transfer.videoId, languageCode: transfer.languageCode,
          status: transfer.status, contentType: transfer.contentType, transport: transfer.transport,
          body: '', responseCharacters: transfer.receivedCharacters,
          readError: 'Chunked caption transfer exceeded its declared response size.'
        });
        return;
      }
      if (transfer.received.size === transfer.totalChunks) {
        clearTimeout(transfer.timer);
        captionBodyTransfers.delete(transferId);
        const body = transfer.chunks.join('');
        if (body.length !== transfer.responseCharacters) {
          deliverCaptionBody({
            videoId: transfer.videoId, languageCode: transfer.languageCode,
            status: transfer.status, contentType: transfer.contentType, transport: transfer.transport,
            body: '', responseCharacters: body.length,
            readError: `Chunked caption length mismatch (${body.length}/${transfer.responseCharacters}).`
          });
        } else {
          console.info('[HoverNotes Captions] Chunked player caption response reassembled', {
            videoId: transfer.videoId, languageCode: transfer.languageCode,
            responseCharacters: body.length, totalChunks: transfer.totalChunks
          });
          deliverCaptionBody({
            videoId: transfer.videoId, languageCode: transfer.languageCode,
            status: transfer.status, contentType: transfer.contentType, transport: transfer.transport,
            body, responseCharacters: body.length
          });
        }
      }
      return;
    }

    if (message.type === 'CAPTION_BODY') {
      deliverCaptionBody({
        videoId: String(message.videoId || ''),
        languageCode: String(message.languageCode || ''),
        status: Number(message.status || 0),
        contentType: String(message.contentType || ''),
        body: typeof message.body === 'string' ? message.body : '',
        responseCharacters: Number(message.responseCharacters || 0),
        transport: String(message.transport || 'unknown'),
        bodyTooLarge: Boolean(message.bodyTooLarge),
        readError: String(message.readError || '')
      });
      return;
    }
  });

  function requestMainWorldCaptionTracks(targetVideoId) {
    try {
      window.postMessage({
        source: '__HOVERNOTES_ISOLATED__',
        type: 'GET_CAPTION_TRACKS',
        videoId: targetVideoId
      }, window.location.origin);
    } catch (error) {
      console.warn('[HoverNotes Captions] Could not request player caption tracks', error);
    }
  }

  function waitForPlayerCaptionBody(videoId, languageCode, timeoutMs = 20000) {
    const key = `${videoId}::${languageCode || ''}`;
    const previous = lastCaptionBodies.get(key);
    if (previous && previous.body.trim()) return Promise.resolve(previous);

    return new Promise(resolve => {
      const waiters = captionBodyWaiters.get(key) || [];
      const waiter = {
        resolve,
        timer: setTimeout(() => {
          const current = captionBodyWaiters.get(key) || [];
          captionBodyWaiters.set(key, current.filter(item => item !== waiter));
          resolve(lastCaptionBodies.get(key) || {
            status: 0, body: '', responseCharacters: 0,
            timeout: true, contentType: '', transport: 'none'
          });
        }, timeoutMs)
      };
      waiters.push(waiter);
      captionBodyWaiters.set(key, waiters);
    });
  }

  function requestPlayerCaptionBody(videoId, track) {
    window.postMessage({
      source: '__HOVERNOTES_ISOLATED__',
      type: 'REQUEST_CAPTION_BODY',
      videoId,
      languageCode: track?.languageCode || '',
      vssId: track?.vssId || ''
    }, window.location.origin);
  }

  // Fallback: scrape watch page HTML if MAIN world is not yet initialized
  async function fetchCaptionTracksFromPageHtml(videoId) {
    try {
      const response = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
        headers: { 'Accept-Language': 'en-US,en;q=0.9,hi;q=0.8' }
      });
      if (!response.ok) return [];
      const html = await response.text();

      const regex = /ytInitialPlayerResponse\s*=\s*({.+?});(?:var\s+meta|<\/script|\n)/s;
      const match = html.match(regex);
      if (match && match[1]) {
        try {
          const parsed = JSON.parse(match[1]);
          const tracks = parsed?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
          if (Array.isArray(tracks) && tracks.length > 0) {
            return tracks;
          }
        } catch (e) {}
      }

      const secondaryMatch = html.match(/"captionTracks":\s*(\[[^\]]+\])/);
      if (secondaryMatch && secondaryMatch[1]) {
        return JSON.parse(secondaryMatch[1]);
      }
    } catch (err) {
      console.warn('[HoverNotes] HTML caption scrape fallback error:', err);
    }
    return [];
  }

  // Select the best track: English manual > English ASR > Hindi > first available
  function pickBestCaptionTrack(tracks) {
    if (!tracks || tracks.length === 0) return null;

    // 1. English manual
    const enManual = tracks.find(t => (t.languageCode === 'en' || t.languageCode?.startsWith('en-')) && t.kind !== 'asr');
    if (enManual) return enManual;

    // 2. English auto-generated (ASR)
    const enAsr = tracks.find(t => t.languageCode === 'en' || t.languageCode?.startsWith('en-'));
    if (enAsr) return enAsr;

    // 3. Hindi track
    const hiTrack = tracks.find(t => t.languageCode === 'hi' || t.languageCode?.startsWith('hi-'));
    if (hiTrack) return hiTrack;

    // 4. Fallback to first available
    return tracks[0];
  }


  // Delegate format parsing to the separately tested caption parser.
  function parseJson3TimedText(jsonObj) {
    return globalThis.HoverNotesCaptionParser?.parseJson3TimedText(jsonObj) || [];
  }

  function parseXmlTimedText(xmlStr) {
    return globalThis.HoverNotesCaptionParser?.parseXmlTimedText(xmlStr) || [];
  }

  // Get captions from the actual YouTube player request. Current YouTube Web
  // caption requests may require a player-issued PO token; the static baseUrl can
  // return HTTP 200 with an empty body. We observe the player's response instead
  // of constructing or logging a token ourselves.
  async function getFullTranscript(videoId) {
    const retrievalStartedAt = performanceNow();
    if (!videoId) {
      transcriptDiagnostics.set('unknown', 'The current YouTube video ID could not be detected.');
      return [];
    }
    if (transcriptCache.has(videoId)) {
      const cachedItems = transcriptCache.get(videoId);
      const cacheMetrics = {
        cacheHit: true,
        totalLoadMs: Math.round(performanceNow() - retrievalStartedAt),
        trackDiscoveryMs: 0,
        playerWaitMs: 0,
        captionParseMs: 0,
        cueCount: cachedItems.length
      };
      transcriptPerformanceCache.set(videoId, cacheMetrics);
      console.info('[HoverNotes Performance] Caption transcript cache hit', {
        videoId,
        ...cacheMetrics
      });
      return cachedItems;
    }

    const trackDiscoveryStartedAt = performanceNow();
    let tracks = captionTracksCache.get(videoId);
    if (!tracks || tracks.length === 0) {
      requestMainWorldCaptionTracks(videoId);
      // Player data may be late (especially after pre-roll ads).
      const trackDeadline = Date.now() + 26000;
      while ((!tracks || tracks.length === 0) && Date.now() < trackDeadline) {
        await new Promise(resolve => setTimeout(resolve, 200));
        tracks = captionTracksCache.get(videoId);
      }
    }

    // HTML fallback is used only to discover track metadata. Its baseUrl is not
    // fetched directly because that token-less URL can return an empty 200.
    if (!tracks || tracks.length === 0) {
      tracks = await fetchCaptionTracksFromPageHtml(videoId);
      if (tracks && tracks.length > 0) captionTracksCache.set(videoId, tracks);
    }

    if (!tracks || tracks.length === 0) {
      const diagnostic = `No caption tracks were exposed by the YouTube player for video ${videoId}.`;
      transcriptDiagnostics.set(videoId, diagnostic);
      const metrics = {
        cacheHit: false,
        totalLoadMs: Math.round(performanceNow() - retrievalStartedAt),
        trackDiscoveryMs: Math.round(performanceNow() - trackDiscoveryStartedAt),
        playerWaitMs: 0,
        captionParseMs: 0,
        outcome: 'no-caption-tracks'
      };
      transcriptPerformanceCache.set(videoId, metrics);
      console.info('[HoverNotes Performance] Caption transcript load finished', { videoId, ...metrics });
      console.warn('[HoverNotes Captions] No caption tracks available', { videoId });
      return [];
    }

    const bestTrack = pickBestCaptionTrack(tracks);
    if (!bestTrack || !bestTrack.languageCode) {
      const diagnostic = `Found ${tracks.length} caption track(s), but none had a usable language identifier.`;
      transcriptDiagnostics.set(videoId, diagnostic);
      const metrics = {
        cacheHit: false,
        totalLoadMs: Math.round(performanceNow() - retrievalStartedAt),
        trackDiscoveryMs: Math.round(performanceNow() - trackDiscoveryStartedAt),
        playerWaitMs: 0,
        captionParseMs: 0,
        outcome: 'invalid-caption-track'
      };
      transcriptPerformanceCache.set(videoId, metrics);
      console.info('[HoverNotes Performance] Caption transcript load finished', { videoId, ...metrics });
      console.warn('[HoverNotes Captions] Track metadata was incomplete', { videoId, trackCount: tracks.length });
      return [];
    }
    const trackDiscoveryMs = Math.round(performanceNow() - trackDiscoveryStartedAt);

    // Register the waiter BEFORE asking the player to activate captions because
    // the resulting fetch/XHR can complete quickly.
    const bodyPromise = waitForPlayerCaptionBody(videoId, bestTrack.languageCode, 32000);
    const playerWaitStartedAt = performanceNow();
    requestPlayerCaptionBody(videoId, bestTrack);
    const response = await bodyPromise;
    const playerWaitMs = Math.round(performanceNow() - playerWaitStartedAt);

    if (!response.body?.trim()) {
      const reason = response.timeout
        ? 'The player did not issue a timed-text request for the selected caption track within 32 seconds.'
        : response.bodyTooLarge
          ? `The player caption response was too large (${response.responseCharacters} characters).`
          : response.readError
            ? `Could not read the player caption response: ${response.readError}`
            : `The player caption request returned no body (HTTP ${response.status || 'unknown'}, ${response.contentType || 'unknown content type'}, ${response.responseCharacters || 0} characters).`;
      const activation = captionActivationDiagnostics.get(videoId);
      const activationDetail = activation && !activation.startsWith('Player activation requested') ? ` Player activation: ${activation}` : '';
      const diagnostic = `Found ${tracks.length} caption track(s) (${bestTrack.languageCode}), but no caption text was captured. ${reason}${activationDetail}`;
      transcriptDiagnostics.set(videoId, diagnostic);
      const metrics = {
        cacheHit: false,
        trackDiscoveryMs,
        playerWaitMs,
        captionParseMs: 0,
        totalLoadMs: Math.round(performanceNow() - retrievalStartedAt),
        responseCharacters: response.responseCharacters || 0,
        outcome: 'empty-player-response'
      };
      transcriptPerformanceCache.set(videoId, metrics);
      console.info('[HoverNotes Performance] Caption transcript load finished', { videoId, ...metrics });
      console.error('[HoverNotes Captions] Player caption response was empty or unavailable', {
        videoId,
        languageCode: bestTrack.languageCode,
        status: response.status,
        contentType: response.contentType,
        responseCharacters: response.responseCharacters,
        timeout: Boolean(response.timeout),
        transport: response.transport
      });
      return [];
    }

    let parsedItems = [];
    const body = response.body;
    const captionParseStartedAt = performanceNow();
    try {
      parsedItems = parseJson3TimedText(JSON.parse(body));
    } catch (_) {
      parsedItems = parseXmlTimedText(body);
    }
    if (parsedItems.length === 0) {
      // Some player builds return JSON3 even when the content type is HTML-ish.
      try { parsedItems = parseJson3TimedText(JSON.parse(body)); } catch (_) {}
    }

    if (parsedItems.length === 0) {
      const diagnostic = `Captured ${body.length} characters from the YouTube player (${bestTrack.languageCode}), but the response contained no supported caption cues.`;
      transcriptDiagnostics.set(videoId, diagnostic);
      const metrics = {
        cacheHit: false,
        trackDiscoveryMs,
        playerWaitMs,
        captionParseMs: Math.round(performanceNow() - captionParseStartedAt),
        totalLoadMs: Math.round(performanceNow() - retrievalStartedAt),
        responseCharacters: body.length,
        outcome: 'zero-parsed-cues'
      };
      transcriptPerformanceCache.set(videoId, metrics);
      console.info('[HoverNotes Performance] Caption transcript load finished', { videoId, ...metrics });
      console.error('[HoverNotes Captions] Player response captured but parsed to zero cues', {
        videoId, languageCode: bestTrack.languageCode, responseCharacters: body.length,
        contentType: response.contentType, transport: response.transport
      });
      return [];
    }

    parsedItems.sort((a, b) => a.start - b.start);
    transcriptCache.set(videoId, parsedItems);
    const metrics = {
      cacheHit: false,
      trackCount: tracks.length,
      languageCode: bestTrack.languageCode,
      trackDiscoveryMs,
      playerWaitMs,
      captionParseMs: Math.round(performanceNow() - captionParseStartedAt),
      totalLoadMs: Math.round(performanceNow() - retrievalStartedAt),
      responseCharacters: body.length,
      cueCount: parsedItems.length,
      outcome: 'success'
    };
    transcriptPerformanceCache.set(videoId, metrics);
    console.info('[HoverNotes Performance] Caption transcript load finished', { videoId, ...metrics });
    transcriptDiagnostics.set(videoId,
      `Loaded ${parsedItems.length} caption cues from the YouTube player (${bestTrack.languageCode}).`);
    console.info('[HoverNotes Captions] Player caption retrieval succeeded', {
      videoId,
      languageCode: bestTrack.languageCode,
      cueCount: parsedItems.length,
      responseCharacters: body.length,
      firstCueTime: parsedItems[0]?.start ?? null,
      lastCueTime: parsedItems[parsedItems.length - 1]?.start ?? null
    });
    return parsedItems;
  }

  // Extract transcript slice between startTime and endTime
  async function extractTranscriptSlice(startTime, endTime) {
    const meta = getVideoMetadata();
    const videoId = meta.videoId;
    const fullTranscript = await getFullTranscript(videoId);
    const transcriptPerformance = transcriptPerformanceCache.get(videoId) || null;

    let start = Math.max(0, typeof startTime === 'number' ? startTime : 0);
    let end = typeof endTime === 'number' ? endTime : (meta.currentTime || 0);

    // Do not silently widen or shift a requested interval. The caller owns the
    // processing cursor and must receive exactly the interval it asked for.
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      return {
        success: true, videoId, videoTitle: meta.videoTitle, videoUrl: meta.videoUrl,
        currentTime: meta.currentTime, timestampStr: meta.timestampStr,
        duration: meta.duration, sliceStart: start, sliceEnd: end,
        itemCount: 0, lines: [], transcriptText: '', diagnostic: transcriptDiagnostics.get(videoId) || 'Invalid transcript interval.',
        performance: { ...transcriptPerformance, sliceFilterMs: 0, fullCueCount: fullTranscript.length }
      };
    }

    // Preserve original caption-overlap semantics: include cues that began before
    // the interval but continue into it. This avoids dropping boundary-crossing speech.
    const sliceStartedAt = performanceNow();
    const sliceItems = fullTranscript.filter(
      item => item.start + item.duration >= start && item.start <= end
    );

    const lines = sliceItems.map(item => `[${formatTime(item.start)}] ${item.text}`);
    const transcriptText = lines.join('\n');

    return {
      success: true,
      videoId,
      videoTitle: meta.videoTitle,
      videoUrl: meta.videoUrl,
      currentTime: meta.currentTime,
      timestampStr: meta.timestampStr,
      duration: meta.duration,
      sliceStart: start,
      sliceEnd: end,
      itemCount: sliceItems.length,
      lines,
      transcriptText,
      diagnostic: transcriptDiagnostics.get(videoId) || '',
      performance: {
        ...transcriptPerformance,
        sliceFilterMs: Math.round(performanceNow() - sliceStartedAt),
        fullCueCount: fullTranscript.length,
        sliceCueCount: sliceItems.length
      }
    };
  }

  // =========================================================================
  // Spec 2: Fast JPEG Frame Capture (max width 1280px, quality 0.75)
  // =========================================================================

  async function captureVideoFrame() {
    const video = getVideoElement();
    if (!video) throw new Error('No HTML5 video element found');

    const MAX_WIDTH = 1280;
    const vWidth = video.videoWidth || 1280;
    const vHeight = video.videoHeight || 720;
    let targetW = vWidth;
    let targetH = vHeight;

    if (targetW > MAX_WIDTH) {
      targetH = Math.round((vHeight * MAX_WIDTH) / vWidth);
      targetW = MAX_WIDTH;
    }

    // Attempt 1: Direct Canvas draw with JPEG compression
    try {
      const canvas = document.createElement('canvas');
      canvas.width = targetW;
      canvas.height = targetH;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, 0, targetW, targetH);

      const dataUrl = canvas.toDataURL('image/jpeg', 0.75);
      if (dataUrl && dataUrl.length > 100) {
        return dataUrl;
      }
    } catch (corsErr) {
      console.warn('[HoverNotes] Canvas tainted by CORS, using visible tab capture:', corsErr);
    }

    // Attempt 2: Background tab capture fallback
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action: 'CAPTURE_VISIBLE_TAB' }, (response) => {
        if (!response || !response.success || !response.dataUrl) {
          return reject(new Error(response?.error || 'Failed to capture visible tab'));
        }

        const img = new Image();
        img.onload = () => {
          try {
            const rect = video.getBoundingClientRect();
            const dpr = window.devicePixelRatio || 1;
            let cropW = Math.max(1, rect.width * dpr);
            let cropH = Math.max(1, rect.height * dpr);

            if (cropW > MAX_WIDTH) {
              cropH = Math.round((cropH * MAX_WIDTH) / cropW);
              cropW = MAX_WIDTH;
            }

            const cropCanvas = document.createElement('canvas');
            cropCanvas.width = cropW;
            cropCanvas.height = cropH;
            const cropCtx = cropCanvas.getContext('2d');
            cropCtx.drawImage(
              img,
              rect.left * dpr,
              rect.top * dpr,
              cropW,
              cropH,
              0,
              0,
              cropW,
              cropH
            );
            resolve(cropCanvas.toDataURL('image/jpeg', 0.75));
          } catch (e) {
            resolve(response.dataUrl);
          }
        };
        img.onerror = () => reject(new Error('Failed to load tab screenshot'));
        img.src = response.dataUrl;
      });
    });
  }

  // Passive study-frame sampling. It never seeks or pauses YouTube: while AI Notes
  // is active, a low-resolution frame is scored every 2.5 seconds. Only the best
  // qualifying frame in each video-minute bucket is retained.
  function analyzeCurrentStudyFrame(video) {
    try {
      if (!window.HoverNotesFrameQuality) throw new Error('Frame-quality helper is unavailable.');
      const canvas = document.createElement('canvas');
      canvas.width = 320; canvas.height = 180;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      return window.HoverNotesFrameQuality.analyzeRgbaPixels(pixels.data, pixels.width, pixels.height);
    } catch (error) {
      return { method: 'slide-detail-occlusion-dhash-v3', isStudyRelevant: false, score: 0, selectionScore: 0,
        edgeDensity: 0, detailedTileCount: 0, upperSlideOcclusionRatio: 0, occlusionPenalty: 0, fingerprint: '', reason: 'quality-check-unavailable' };
    }
  }

  async function considerStudyFrame(video) {
    if (!studyFrameSamplerActive || studyFrameSamplingBusy || !video || video.paused ||
        video.readyState < 2 || video.videoWidth < 1 || video.videoHeight < 1) return;
    studyFrameSamplingBusy = true;
    try {
      const sampleTime = Number(video.currentTime) || 0;
      const quality = analyzeCurrentStudyFrame(video);
      if (!quality.isStudyRelevant) return;
      const minuteBucket = Math.floor(sampleTime / 60);
      const previous = studyFrameCandidates.get(minuteBucket);
      if (previous && (previous.quality.selectionScore ?? previous.quality.score) >= (quality.selectionScore ?? quality.score)) return;
      const dataUrl = await captureVideoFrame();
      if (!studyFrameSamplerActive || !dataUrl) return;
      studyFrameCandidates.set(minuteBucket, { time: sampleTime, dataUrl, quality, minuteBucket });
      while (studyFrameCandidates.size > MAX_STUDY_FRAME_BUCKETS) {
        studyFrameCandidates.delete(studyFrameCandidates.keys().next().value);
      }
    } catch (error) {
      console.debug('[HoverNotes Frames] A frame sample was skipped:', error?.message || error);
    } finally { studyFrameSamplingBusy = false; }
  }

  function startStudyFrameSampler() {
    if (studyFrameSamplerTimer) clearInterval(studyFrameSamplerTimer);
    studyFrameCandidates.clear();
    usedStudyFrameFingerprints.length = 0;
    studyFrameSamplerActive = true;
    studyFrameSamplingBusy = false;
    studyFrameSamplerTimer = setInterval(() => { void considerStudyFrame(getVideoElement()); }, 2500);
    console.info('[HoverNotes Frames] Study-frame sampler started', { intervalMs: 2500, qualityMethod: 'slide-detail-occlusion-dhash-v3', duplicateDistance: STUDY_FRAME_DUPLICATE_DISTANCE, motionDuplicateDistance: STUDY_FRAME_MOTION_DUPLICATE_DISTANCE, regionDuplicateDistance: STUDY_FRAME_REGION_DUPLICATE_DISTANCE });
    return { success: true, active: true };
  }

  function stopStudyFrameSampler() {
    studyFrameSamplerActive = false;
    if (studyFrameSamplerTimer) clearInterval(studyFrameSamplerTimer);
    studyFrameSamplerTimer = null;
    const retainedCandidateCount = studyFrameCandidates.size;
    studyFrameCandidates.clear();
    return { success: true, active: false, retainedCandidateCount };
  }

  function extractTranscriptWindowNearTime(transcriptText, targetSeconds, radiusSeconds = 12) {
    const lines = String(transcriptText || '').split(/\r?\n/);
    const selected = [];
    for (const line of lines) {
      const match = line.match(/^\[(?:(\d{1,2}):)?(\d{2}):(\d{2})\]/);
      if (!match) continue;
      const hours = match[1] ? Number(match[1]) : 0;
      const minutes = Number(match[2]);
      const seconds = Number(match[3]);
      const absolute = hours * 3600 + minutes * 60 + seconds;
      if (Math.abs(absolute - targetSeconds) <= radiusSeconds) selected.push(line);
    }
    return selected.join('\n');
  }

  // Keep visual selection optional: AI text generation must continue even when
  // a content-script fallback path has not loaded the frame-quality helper.
  function getTranscriptRelevance(transcriptText) {
    const analyzer = window.HoverNotesFrameQuality?.analyzeTranscriptRelevance;
    if (typeof analyzer === 'function') return analyzer(transcriptText);
    return {
      isPromotional: false,
      shouldSuppressFrames: false,
      promotionalSignals: 0,
      instructionalSignals: 0,
      reason: 'transcript-relevance-helper-unavailable'
    };
  }

  function areStudyFramesNearDuplicate(first, second, thresholds) {
    const compare = window.HoverNotesFrameQuality?.areNearDuplicateFingerprints;
    return typeof compare === 'function' ? compare(first, second, thresholds) : false;
  }

  async function getBestStudyFrame(startTime, endTime, transcriptText = '') {
    const start = Math.max(0, Number(startTime) || 0);
    const end = Math.max(start, Number(endTime) || 0);
    const relevance = getTranscriptRelevance(transcriptText);
    if (relevance.shouldSuppressFrames) {
      const quality = {
        method: 'transcript-gated-slide-detail-occlusion-dhash-v3', isStudyRelevant: false,
        score: 0, fingerprint: '', transcriptRelevance: relevance,
        reason: 'promotional-segment-no-study-screenshot'
      };
      console.info('[HoverNotes Frames] Screenshot selection skipped for promotional interval', {
        startTime: Math.floor(start), endTime: Math.floor(end),
        promotionalSignals: relevance.promotionalSignals,
        instructionalSignals: relevance.instructionalSignals
      });
      return { dataUrl: null, time: null, quality };
    }

    const matches = Array.from(studyFrameCandidates.values()).filter(candidate => {
      const candidateSecond = Math.floor(candidate.time);
      if (candidateSecond < start || candidateSecond > end || !candidate.quality?.isStudyRelevant) return false;
      const nearbyTranscript = extractTranscriptWindowNearTime(transcriptText, candidateSecond, 12);
      const nearbyRelevance = getTranscriptRelevance(nearbyTranscript);
      candidate.transcriptRelevance = nearbyRelevance;
      return !nearbyRelevance.shouldSuppressFrames;
    });
    // Include the current frame as a final candidate. This catches a slide that
    // appears just before Stop without seeking or disturbing playback.
    const video = getVideoElement();
    if (video && Number.isFinite(video.currentTime) && Math.floor(video.currentTime) >= start &&
        Math.floor(video.currentTime) <= end && video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
      const sampleTime = Number(video.currentTime);
      const quality = analyzeCurrentStudyFrame(video);
      const nearbyTranscript = extractTranscriptWindowNearTime(transcriptText, Math.floor(sampleTime), 12);
      const nearbyRelevance = getTranscriptRelevance(nearbyTranscript);
      quality.transcriptRelevance = nearbyRelevance;
      if (quality.isStudyRelevant && !nearbyRelevance.shouldSuppressFrames) {
        try {
          const dataUrl = await captureVideoFrame();
          if (dataUrl) matches.push({ time: sampleTime, dataUrl, quality });
        } catch (error) {
          console.debug('[HoverNotes Frames] Current-frame candidate was skipped:', error?.message || error);
        }
      }
    }

    matches.sort((a, b) => (b.quality.selectionScore ?? b.quality.score) - (a.quality.selectionScore ?? a.quality.score) || b.time - a.time);
    const chosen = [];
    let duplicateOfSaved = false;
    for (const candidate of matches) {
      const fingerprint = candidate.quality?.fingerprint || '';
      if (!fingerprint) continue;
      const duplicatesSaved = usedStudyFrameFingerprints.some(used =>
        areStudyFramesNearDuplicate(candidate.quality, used, {
          globalThreshold: STUDY_FRAME_DUPLICATE_DISTANCE,
          motionGlobalThreshold: STUDY_FRAME_MOTION_DUPLICATE_DISTANCE,
          regionThreshold: STUDY_FRAME_REGION_DUPLICATE_DISTANCE
        })
      );
      if (duplicatesSaved) { duplicateOfSaved = true; continue; }
      const duplicatesCandidate = chosen.some(previous =>
        areStudyFramesNearDuplicate(candidate.quality, previous.quality, {
          globalThreshold: STUDY_FRAME_DUPLICATE_DISTANCE,
          motionGlobalThreshold: STUDY_FRAME_MOTION_DUPLICATE_DISTANCE,
          regionThreshold: STUDY_FRAME_REGION_DUPLICATE_DISTANCE
        })
      );
      if (duplicatesCandidate) continue;
      chosen.push(candidate);
    }
    const best = chosen[0] || null;
    const quality = best?.quality || {
      method: 'slide-detail-occlusion-dhash-v3', isStudyRelevant: false, score: 0, selectionScore: 0, fingerprint: '',
      transcriptRelevance: relevance,
      reason: duplicateOfSaved ? 'duplicate-of-previously-saved-slide' : 'no-study-relevant-frame-found'
    };
    if (best) quality.transcriptRelevance = relevance;
    console.info('[HoverNotes Frames] Study-frame selection completed', {
      startTime: Math.floor(start), endTime: Math.floor(end),
      sampledCandidates: studyFrameCandidates.size, eligibleCandidates: matches.length,
      uniqueCandidates: chosen.length, previouslySavedDuplicate: duplicateOfSaved,
      selected: Boolean(best), selectedTime: best ? Number(best.time.toFixed(2)) : null,
      qualityScore: best?.quality.score ?? null, selectionScore: best?.quality.selectionScore ?? best?.quality.score ?? null,
      upperSlideOcclusionRatio: best?.quality.upperSlideOcclusionRatio ?? null, occlusionPenalty: best?.quality.occlusionPenalty ?? null,
      qualityMethod: 'slide-detail-occlusion-dhash-v3',
      transcriptRelevance: relevance
    });
    return best ? { ...best, quality } : { dataUrl: null, time: null, quality };
  }

  // =========================================================================
  // Playback Operations & Split-Screen Management
  // =========================================================================

  function controlPlayback(payload) {
    const video = getVideoElement();
    if (!video) return { success: false, error: 'No video element' };

    const { type, delta, time, rate } = payload;
    switch (type) {
      case 'play':
        video.play();
        break;
      case 'pause':
        video.pause();
        break;
      case 'toggle':
        video.paused ? video.play() : video.pause();
        break;
      case 'scrub':
        if (typeof delta === 'number') {
          video.currentTime = Math.max(0, Math.min(video.duration || Infinity, video.currentTime + delta));
        }
        break;
      case 'seek':
        if (typeof time === 'number') {
          video.currentTime = Math.max(0, Math.min(video.duration || Infinity, time));
        }
        break;
      case 'setPlaybackRate':
        if (typeof rate === 'number' && rate > 0) {
          video.playbackRate = rate;
        }
        break;
    }

    return {
      success: true,
      currentTime: video.currentTime,
      timestampStr: formatTime(video.currentTime),
      paused: video.paused,
      playbackRate: video.playbackRate
    };
  }

  function ensureSidebarIframe() {
    if (!sidebarIframe) {
      let existing = document.getElementById('hovernotes-sidebar-iframe');
      if (existing) {
        sidebarIframe = existing;
      } else {
        sidebarIframe = document.createElement('iframe');
        sidebarIframe.id = 'hovernotes-sidebar-iframe';
        sidebarIframe.className = 'hovernotes-hidden';
        sidebarIframe.src = chrome.runtime.getURL('sidebar/sidebar.html');
        sidebarIframe.allow = 'clipboard-read; clipboard-write; microphone; camera';
        document.body.appendChild(sidebarIframe);
      }
    }
    return sidebarIframe;
  }

  function triggerPlayerResize() {
    [0, 50, 150, 300, 500].forEach((delay) => {
      setTimeout(() => {
        window.dispatchEvent(new Event('resize'));
        const player = document.querySelector('#movie_player');
        if (player && typeof player.setInternalSize === 'function') {
          try { player.setInternalSize(); } catch (e) {}
        }
      }, delay);
    });
  }

  function toggleSplitScreen(forceState) {
    const iframe = ensureSidebarIframe();
    const newState = (forceState !== undefined) ? forceState : !isSplitActive;
    isSplitActive = newState;

    if (isSplitActive) {
      document.body.classList.add('hovernotes-split-active');
      iframe.classList.remove('hovernotes-hidden');
    } else {
      document.body.classList.remove('hovernotes-split-active');
      iframe.classList.add('hovernotes-hidden');
    }

    const btn = document.querySelector('.ytp-hovernotes-btn');
    if (btn) {
      btn.classList.toggle('active', isSplitActive);
      btn.setAttribute('aria-pressed', isSplitActive ? 'true' : 'false');
    }

    triggerPlayerResize();
    sendToSidebar({
      action: 'SPLIT_STATE_CHANGED',
      active: isSplitActive,
      videoState: getVideoMetadata()
    });
  }

  function sendToSidebar(msg) {
    if (sidebarIframe && sidebarIframe.contentWindow) {
      sidebarIframe.contentWindow.postMessage(msg, '*');
    }
  }

  // Inject sleek button into YouTube player controls
  function injectPlayerControlsButton() {
    const rightControls = document.querySelector('.ytp-right-controls');
    if (!rightControls || document.querySelector('.ytp-hovernotes-btn')) return;

    const btn = document.createElement('button');
    btn.className = 'ytp-button ytp-hovernotes-btn';
    btn.setAttribute('title', 'HoverNotes Split Screen');
    btn.setAttribute('aria-label', 'HoverNotes Split Screen');
    btn.setAttribute('aria-pressed', isSplitActive ? 'true' : 'false');
    if (isSplitActive) btn.classList.add('active');

    btn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path>
        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path>
        <line x1="9" y1="7" x2="15" y2="7"></line>
        <line x1="9" y1="11" x2="15" y2="11"></line>
        <circle cx="16" cy="16" r="2" fill="currentColor"></circle>
      </svg>
      <div class="ytp-hovernotes-tooltip">HoverNotes (Split Mode)</div>
    `;

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleSplitScreen();
    });

    try {
      const settingsBtn = rightControls.querySelector('.ytp-settings-button');
      if (settingsBtn && settingsBtn.parentNode) {
        settingsBtn.parentNode.insertBefore(btn, settingsBtn);
      } else {
        rightControls.prepend(btn);
      }
    } catch (e) {
      rightControls.prepend(btn);
    }
  }

  // =========================================================================
  // Master Action Handler
  // =========================================================================

  async function handleAction(action, payload) {
    switch (action) {
      case 'TOGGLE_SIDEBAR':
        toggleSplitScreen(payload?.state);
        return { success: true, active: isSplitActive };

      case 'CLOSE_SIDEBAR':
        toggleSplitScreen(false);
        return { success: true, active: false };

      case 'GET_VIDEO_STATE':
        return { success: true, state: getVideoMetadata() };

      case 'START_STUDY_FRAME_SAMPLER':
        return startStudyFrameSampler();

      case 'STOP_STUDY_FRAME_SAMPLER':
        return stopStudyFrameSampler();

      case 'MARK_STUDY_FRAME_USED': {
        const fingerprint = String(payload?.fingerprint || '').toLowerCase();
        if (/^[0-9a-f]{16}$/.test(fingerprint)) {
          const regionFingerprints = Array.isArray(payload?.regionFingerprints) ? payload.regionFingerprints : [];
          usedStudyFrameFingerprints.push({ fingerprint, regionFingerprints });
          if (usedStudyFrameFingerprints.length > 100) usedStudyFrameFingerprints.shift();
          return { success: true, usedFrameCount: usedStudyFrameFingerprints.length };
        }
        return { success: false, error: 'Invalid study-frame fingerprint.' };
      }

      case 'CAPTURE_FRAME': {
        try {
          if (payload?.selectBestStudyFrame) {
            const state = getVideoMetadata();
            const best = await getBestStudyFrame(payload?.startTime, payload?.endTime, payload?.transcriptText || '');
            return {
              success: true, dataUrl: best?.dataUrl || null,
              frameTime: best?.time ?? null,
              frameQuality: best?.quality || {
                method: 'slide-detail-occlusion-dhash-v3', isStudyRelevant: false, score: 0, selectionScore: 0, fingerprint: '',
                reason: 'no-study-relevant-frame-found'
              },
              videoState: state
            };
          }
          const dataUrl = await captureVideoFrame();
          const state = getVideoMetadata();
          return { success: true, dataUrl, videoState: state, frameTime: state.currentTime };
        } catch (err) { return { success: false, error: err.message }; }
      }

      case 'GET_TRANSCRIPT_SLICE': {
        try {
          const sliceResult = await extractTranscriptSlice(payload?.startTime, payload?.endTime);
          return sliceResult;
        } catch (err) {
          return { success: false, error: err.message };
        }
      }

      case 'CONTROL_PLAYBACK':
        return controlPlayback(payload);

      default:
        return { success: false, error: `Unknown action: ${action}` };
    }
  }

  // Chrome Extension Runtime Message Listener
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.action) return false;

    handleAction(message.action, message.payload || message).then((res) => {
      sendResponse(res);
    }).catch((err) => {
      sendResponse({ success: false, error: err.message });
    });

    return true; // Keep channel open for async response
  });

  // Window postMessage Listener from Sidebar Iframe
  window.addEventListener('message', async (event) => {
    if (!sidebarIframe || event.source !== sidebarIframe.contentWindow) return;
    if (!event.data || typeof event.data !== 'object') return;
    const { action, payload, requestId } = event.data;
    if (!action) return;

    const result = await handleAction(action, payload);
    if (requestId && sidebarIframe && sidebarIframe.contentWindow) {
      sidebarIframe.contentWindow.postMessage({
        responseToId: requestId,
        ...result
      }, '*');
    }
  });

  // Global Hotkey Interception (Space, J/L scrub, S/D speed, I screenshot, T timestamp)
  window.addEventListener('keydown', (e) => {
    const target = e.target;
    const tag = (target && target.tagName) ? target.tagName.toUpperCase() : '';
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) || (target && target.isContentEditable)) {
      return;
    }
    if (document.activeElement === sidebarIframe) {
      return;
    }

    const key = e.key;

    if (e.code === 'Space' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      controlPlayback({ type: 'toggle' });
      return;
    }

    if ((key === 'j' || key === 'J') && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      controlPlayback({ type: 'scrub', delta: -10 });
      return;
    }

    if ((key === 'l' || key === 'L') && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      controlPlayback({ type: 'scrub', delta: 10 });
      return;
    }

    if ((key === 's' || key === 'S') && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const video = getVideoElement();
      if (video) {
        e.preventDefault();
        e.stopPropagation();
        const nextRate = Math.max(0.25, Math.round((video.playbackRate - 0.25) * 100) / 100);
        controlPlayback({ type: 'setPlaybackRate', rate: nextRate });
      }
      return;
    }

    if ((key === 'd' || key === 'D') && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const video = getVideoElement();
      if (video) {
        e.preventDefault();
        e.stopPropagation();
        const nextRate = Math.min(3.0, Math.round((video.playbackRate + 0.25) * 100) / 100);
        controlPlayback({ type: 'setPlaybackRate', rate: nextRate });
      }
      return;
    }

    if ((key === 'i' || key === 'I') && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      if (!isSplitActive) toggleSplitScreen(true);
      sendToSidebar({ action: 'TRIGGER_CAPTURE' });
      return;
    }

    if ((key === 't' || key === 'T') && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      if (!isSplitActive) toggleSplitScreen(true);
      sendToSidebar({ action: 'TRIGGER_TIMESTAMP' });
      return;
    }
  }, true);

  // SPA Navigation and Player Reset
  function checkUrlAndReset() {
    const newVideoId = extractVideoId();
    if (newVideoId && newVideoId !== currentVideoId) {
      currentVideoId = newVideoId;
      studyFrameCandidates.clear();
      if (studyFrameSamplerTimer) clearInterval(studyFrameSamplerTimer);
      studyFrameSamplerTimer = null;
      studyFrameSamplerActive = false;
      requestMainWorldCaptionTracks(newVideoId);
      sendToSidebar({
        action: 'VIDEO_CHANGED',
        state: getVideoMetadata()
      });
    }
    injectPlayerControlsButton();
  }

  window.addEventListener('yt-navigate-finish', () => {
    setTimeout(checkUrlAndReset, 150);
    setTimeout(injectPlayerControlsButton, 600);
  });

  window.addEventListener('yt-page-data-updated', () => {
    setTimeout(checkUrlAndReset, 150);
    setTimeout(injectPlayerControlsButton, 600);
  });

  const observer = new MutationObserver(() => {
    if (!document.querySelector('.ytp-hovernotes-btn')) {
      injectPlayerControlsButton();
    }
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });

  currentVideoId = extractVideoId();
  if (currentVideoId) {
    requestMainWorldCaptionTracks(currentVideoId);
  }
  injectPlayerControlsButton();
})();
