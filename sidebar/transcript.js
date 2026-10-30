/**
 * HoverNotes Clone - YouTube Transcript Fetcher & Sliding Window Extractor
 * Fetches and parses timedtext captions (JSON3 and XML) from YouTube.
 */

class YouTubeTranscriptFetcher {
  constructor() {
    this.cache = new Map(); // videoId -> parsed transcript array
  }

  // Format seconds to [MM:SS] or [HH:MM:SS]
  formatTime(sec) {
    if (isNaN(sec) || sec === null || sec === undefined) return '00:00';
    const s = Math.floor(sec);
    const hours = Math.floor(s / 3600);
    const minutes = Math.floor((s % 3600) / 60);
    const seconds = s % 60;
    if (hours > 0) {
      return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  // Decode HTML entities
  decodeHtml(str) {
    if (!str) return '';
    const txt = document.createElement('textarea');
    txt.innerHTML = str;
    return txt.value
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\n/g, ' ')
      .trim();
  }

  // Extract caption tracks by fetching YouTube watch page or using player metadata
  async getCaptionTracks(videoId, existingTracks = null) {
    if (existingTracks && Array.isArray(existingTracks) && existingTracks.length > 0) {
      return existingTracks;
    }

    try {
      const response = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
        headers: { 'Accept-Language': 'en-US,en;q=0.9,hi;q=0.8' }
      });
      const html = await response.text();

      // Extract ytInitialPlayerResponse from HTML
      const regex = /ytInitialPlayerResponse\s*=\s*({.+?});(?:var\s+meta|<\/script|\n)/s;
      const match = html.match(regex);
      if (match && match[1]) {
        try {
          const playerResponse = JSON.parse(match[1]);
          const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
          if (tracks && tracks.length > 0) {
            return tracks;
          }
        } catch (e) {
          // JSON parse error on regex match
        }
      }

      // Secondary match for embedded captionTracks
      const captionTracksRegex = /"captionTracks":\s*(\[[^\]]+\])/;
      const tracksMatch = html.match(captionTracksRegex);
      if (tracksMatch && tracksMatch[1]) {
        return JSON.parse(tracksMatch[1]);
      }
    } catch (err) {
      console.warn('Failed to scrape caption tracks from YouTube page:', err);
    }

    return [];
  }

  // Pick the best available track (priority: English manual > English ASR > Hindi > First available)
  selectBestCaptionTrack(tracks) {
    if (!tracks || tracks.length === 0) return null;

    // 1. English manual track
    const enManual = tracks.find(t => (t.languageCode === 'en' || t.languageCode?.startsWith('en-')) && t.kind !== 'asr');
    if (enManual) return enManual;

    // 2. English auto-generated (ASR)
    const enAsr = tracks.find(t => t.languageCode === 'en' || t.languageCode?.startsWith('en-'));
    if (enAsr) return enAsr;

    // 3. Hindi track (for bilingual translation)
    const hiTrack = tracks.find(t => t.languageCode === 'hi' || t.languageCode?.startsWith('hi-'));
    if (hiTrack) return hiTrack;

    // 4. Default to first available track
    return tracks[0];
  }

  // Parse JSON3 timedtext format
  parseJson3TimedText(jsonObj) {
    const events = jsonObj.events || [];
    const items = [];

    for (const event of events) {
      if (!event.segs || !event.tStartMs) continue;
      const text = event.segs.map(s => s.utf16 || '').join('').trim();
      if (!text || text === '\n') continue;

      const start = event.tStartMs / 1000.0;
      const duration = (event.dDurationMs || 0) / 1000.0;
      items.push({
        start,
        duration,
        text: this.decodeHtml(text)
      });
    }

    return items;
  }

  // Parse XML timedtext format
  parseXmlTimedText(xmlStr) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlStr, 'text/xml');
    const textNodes = doc.querySelectorAll('text');
    const items = [];

    textNodes.forEach((node) => {
      const start = parseFloat(node.getAttribute('start') || '0');
      const duration = parseFloat(node.getAttribute('dur') || '0');
      const rawText = node.textContent || '';
      const cleanText = this.decodeHtml(rawText);
      if (cleanText) {
        items.push({
          start,
          duration,
          text: cleanText
        });
      }
    });

    return items;
  }

  // Fetch and parse full transcript for a video
  async fetchTranscript(videoId, captionTracksHint = null) {
    if (!videoId) return [];
    if (this.cache.has(videoId)) {
      return this.cache.get(videoId);
    }

    const tracks = await this.getCaptionTracks(videoId, captionTracksHint);
    if (!tracks || tracks.length === 0) {
      console.warn(`No caption tracks found for video: ${videoId}`);
      return [];
    }

    const track = this.selectBestCaptionTrack(tracks);
    if (!track || !track.baseUrl) {
      return [];
    }

    // Try fetching with fmt=json3
    try {
      const jsonUrl = track.baseUrl.includes('fmt=json3') ? track.baseUrl : `${track.baseUrl}&fmt=json3`;
      const res = await fetch(jsonUrl);
      if (res.ok) {
        const text = await res.text();
        try {
          const json = JSON.parse(text);
          const parsed = this.parseJson3TimedText(json);
          if (parsed.length > 0) {
            this.cache.set(videoId, parsed);
            return parsed;
          }
        } catch (e) {
          // If JSON parse fails, try XML parsing on response text
          const xmlParsed = this.parseXmlTimedText(text);
          if (xmlParsed.length > 0) {
            this.cache.set(videoId, xmlParsed);
            return xmlParsed;
          }
        }
      }
    } catch (err) {
      console.warn('JSON3 timedtext fetch failed, trying standard XML:', err);
    }

    // Fallback: Fetch plain XML timedtext
    try {
      const res = await fetch(track.baseUrl);
      if (res.ok) {
        const xmlStr = await res.text();
        const parsed = this.parseXmlTimedText(xmlStr);
        this.cache.set(videoId, parsed);
        return parsed;
      }
    } catch (err) {
      console.error('Failed to fetch XML timedtext:', err);
    }

    return [];
  }

  // Get transcript text within a sliding window (e.g. past 180 seconds up to current + 15s)
  getContextTranscript(transcriptList, currentTimeSeconds, windowSeconds = 180) {
    if (!transcriptList || transcriptList.length === 0) {
      return '[No automated or manual captions available for this video]';
    }

    const startTime = Math.max(0, currentTimeSeconds - windowSeconds);
    const endTime = currentTimeSeconds + 15;

    const windowSnippets = transcriptList.filter(
      item => item.start >= startTime && item.start <= endTime
    );

    if (windowSnippets.length === 0) {
      // Find the closest snippet before current time
      const priorSnippets = transcriptList.filter(item => item.start <= currentTimeSeconds);
      if (priorSnippets.length > 0) {
        const lastFew = priorSnippets.slice(-5);
        return lastFew.map(s => `[${this.formatTime(s.start)}] ${s.text}`).join('\n');
      }
      return '[No dialogue recorded within current time window]';
    }

    // Merge adjacent lines cleanly with timestamps
    return windowSnippets
      .map(item => `[${this.formatTime(item.start)}] ${item.text}`)
      .join('\n');
  }
}

// Global instance for sidebar
window.transcriptFetcher = new YouTubeTranscriptFetcher();
