import express from 'express';
import fetch from 'node-fetch';
import FormData from 'form-data';
import { logActivity, updateStats, upsertUser, saveTranscription, isUserBanned, isIPBlocked } from '../db.js';
import { apiRateLimit, globalRateLimit } from '../middleware/security.js';

const router = express.Router();

function getVideoId(url) {
  if (typeof url !== 'string') return null;
  const match = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([^&\n?#]+)/);
  return match ? match[1] : null;
}

async function fetchWithTimeout(url, opts = {}, ms = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function safeFilename(name, ext) {
  const clean = String(name || 'video')
    .replace(/[\r\n"]/g, '')
    .replace(/[^a-zA-Z0-9 _\-]/g, '')
    .trim()
    .slice(0, 80) || 'video';
  return `${clean}.${ext}`;
}

// ─────────────────────────────────────────────────────────────
//  RapidAPI YouTube downloader integration
//  Configure with env vars:
//    RAPIDAPI_KEY   = your RapidAPI key
//    RAPIDAPI_HOST  = the API host (e.g. youtube-media-downloader.p.rapidapi.com)
//  Returns { ok, links: {mp4, mp3, mp4sd, m4a}, title } or { ok:false }
// ─────────────────────────────────────────────────────────────
async function getRapidApiLinks(videoId) {
  const key = process.env.RAPIDAPI_KEY;
  const host = process.env.RAPIDAPI_HOST || 'youtube-media-downloader.p.rapidapi.com';
  if (!key) return { ok: false, reason: 'not_configured' };

  try {
    // YouTube Media Downloader (DataFanatic) — get video details with file URLs
    const url = `https://${host}/v2/video/details?videoId=${encodeURIComponent(videoId)}&urlAccess=normal&videos=true&audios=true`;
    const r = await fetchWithTimeout(url, {
      headers: { 'x-rapidapi-key': key, 'x-rapidapi-host': host }
    }, 20000);
    const json = await r.json().catch(() => null);
    if (!r.ok) {
      console.log('[rapidapi] HTTP', r.status, JSON.stringify(json||{}).slice(0,200));
      return { ok: false, reason: 'api_error_' + r.status };
    }
    // The API signals failure with errorId / status fields on some videos
    if (json && (json.errorId && json.errorId !== 'Success')) {
      console.log('[rapidapi] errorId:', json.errorId);
      return { ok: false, reason: json.errorId };
    }
    return parseRapidResponse(json, videoId);
  } catch (e) {
    console.log('[rapidapi] error:', e.message);
    return { ok: false, reason: 'exception' };
  }
}

// Parse various RapidAPI response shapes into our standard link set
function parseRapidResponse(data, videoId) {
  if (!data || typeof data !== 'object') return { ok: false };
  const links = {};
  const title = data.title || 'YouTube Video';

  const vItems = (data.videos && data.videos.items) || [];
  const aItems = (data.audios && data.audios.items) || [];

  // VIDEO: prefer items that include audio (so the file has sound).
  // The DataFanatic API marks combined streams with hasAudio:true.
  if (Array.isArray(vItems) && vItems.length) {
    const withAudio = vItems.filter(it => it && it.url && it.hasAudio === true);
    const anyVideo  = vItems.filter(it => it && it.url);
    const pool = withAudio.length ? withAudio : anyVideo;

    // Sort by quality (height) descending so [0] is the best
    const heightOf = (it) => {
      const q = String(it.quality || it.qualityLabel || it.height || '');
      const m = q.match(/(\d+)/);
      return m ? parseInt(m[1], 10) : 0;
    };
    pool.sort((a, b) => heightOf(b) - heightOf(a));

    // HD = best available with audio; SD = a lower one
    if (pool[0]) links.mp4 = pool[0].url;
    // pick an SD around 360-480 if present, else the smallest
    const sd = pool.find(it => /360|480/.test(String(it.quality||it.qualityLabel||it.height||'')));
    links.mp4sd = (sd && sd.url) || (pool[pool.length-1] && pool[pool.length-1].url) || links.mp4;
  }

  // AUDIO: take the first usable audio URL
  if (Array.isArray(aItems) && aItems.length) {
    const withUrl = aItems.filter(it => it && it.url);
    if (withUrl[0]) {
      links.m4a = withUrl[0].url;
      // prefer an mp3-ish one if available, else reuse
      const mp3 = withUrl.find(it => /mp3|mpeg/i.test(String(it.extension||it.mimeType||'')));
      links.mp3 = (mp3 && mp3.url) || withUrl[0].url;
    }
  }

  // Last-resort: if no audio array, audio-capable video can still serve mp3 button
  if (!links.mp3 && links.mp4) links.mp3 = links.mp4;
  if (!links.m4a && links.mp3) links.m4a = links.mp3;
  if (!links.mp4sd && links.mp4) links.mp4sd = links.mp4;

  const has = links.mp4 || links.mp3 || links.m4a || links.mp4sd;
  return has ? { ok: true, links, title } : { ok: false, reason: 'no_links_parsed' };
}

// POST /api/youtube/info — title + thumbnail (always works, no key needed)
router.post('/info', globalRateLimit, async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'URL required.' });
  const videoId = getVideoId(url);
  if (!videoId) return res.status(400).json({ error: 'Invalid YouTube URL.' });

  try {
    const r = await fetchWithTimeout(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    const data = r.ok ? await r.json() : {};
    res.json({
      title: data.title || 'YouTube Video',
      author: data.author_name || '',
      thumbnail: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
      thumbnailFallback: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
      videoId,
      apiReady: !!(process.env.RAPIDAPI_KEY && process.env.RAPIDAPI_HOST)
    });
  } catch (e) {
    res.json({ title: 'YouTube Video', thumbnail: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`, videoId });
  }
});

// POST /api/youtube/links — return direct download URLs from RapidAPI
router.post('/links', globalRateLimit, async (req, res) => {
  const { url } = req.body || {};
  const videoId = url ? getVideoId(url) : (req.body?.videoId || null);
  if (!videoId || !/^[A-Za-z0-9_-]{6,15}$/.test(videoId)) {
    return res.status(400).json({ error: 'Invalid video.' });
  }
  const result = await getRapidApiLinks(videoId);
  if (!result.ok) {
    return res.status(503).json({ error: 'Download service unavailable.', reason: result.reason });
  }
  res.json({ ok: true, links: result.links, title: result.title });
});


// GET /api/youtube/diag/:videoId — diagnostic: shows why the API is failing
router.get('/diag/:videoId', globalRateLimit, async (req, res) => {
  const { videoId } = req.params;
  if (!videoId || !/^[A-Za-z0-9_-]{6,15}$/.test(videoId)) {
    return res.json({ ok: false, reason: 'invalid_videoid' });
  }
  const key = process.env.RAPIDAPI_KEY;
  const host = process.env.RAPIDAPI_HOST || 'youtube-media-downloader.p.rapidapi.com';
  const diag = { keyPresent: !!key, keyLength: key ? key.length : 0, host };
  if (!key) return res.json({ ok: false, reason: 'NO_KEY_IN_ENV', diag });

  try {
    const url = `https://${host}/v2/video/details?videoId=${encodeURIComponent(videoId)}&urlAccess=normal&videos=true&audios=true`;
    const r = await fetchWithTimeout(url, { headers: { 'x-rapidapi-key': key, 'x-rapidapi-host': host } }, 20000);
    diag.httpStatus = r.status;
    const text = await r.text();
    diag.bodyPreview = text.slice(0, 500);
    // Try to parse and report what fields exist
    try {
      const j = JSON.parse(text);
      diag.topLevelKeys = Object.keys(j);
      diag.errorId = j.errorId;
      diag.hasVideos = !!(j.videos && j.videos.items);
      diag.videoCount = j.videos && j.videos.items ? j.videos.items.length : 0;
      diag.hasAudios = !!(j.audios && j.audios.items);
      diag.audioCount = j.audios && j.audios.items ? j.audios.items.length : 0;
      // Show the actual fields of the first video & audio item
      if (j.videos && j.videos.items && j.videos.items[0]) {
        const v0 = j.videos.items[0];
        diag.firstVideoFields = Object.keys(v0);
        diag.firstVideoSample = { url: (v0.url||'').slice(0,60), quality: v0.quality, hasAudio: v0.hasAudio, extension: v0.extension, mimeType: v0.mimeType };
      }
      if (j.audios && j.audios.items && j.audios.items[0]) {
        const a0 = j.audios.items[0];
        diag.firstAudioFields = Object.keys(a0);
        diag.firstAudioSample = { url: (a0.url||'').slice(0,60), extension: a0.extension, mimeType: a0.mimeType };
      }
    } catch(e) { diag.parseError = true; }
    return res.json({ ok: true, diag });
  } catch (e) {
    diag.fetchError = e.message;
    return res.json({ ok: false, diag });
  }
});

// GET /api/youtube/stream/:videoId — proxy the download through our server
router.get('/stream/:videoId', globalRateLimit, async (req, res) => {
  const ip = (req.ip || '').replace('::ffff:', '');
  const { videoId } = req.params;
  const format = req.query.format || 'mp4';

  if (!videoId || !/^[A-Za-z0-9_-]{6,15}$/.test(videoId)) {
    return res.status(400).json({ error: 'Invalid video ID.' });
  }
  try {
    if (await isUserBanned(ip)) return res.status(403).json({ error: 'Access denied.' });
    if (await isIPBlocked(ip)) return res.status(403).json({ error: 'Access denied.' });
  } catch (e) {}

  // Get a direct link from RapidAPI
  const result = await getRapidApiLinks(videoId);
  if (result.ok) {
    const map = { 'mp4': result.links.mp4, 'mp3': result.links.mp3, 'mp4-sd': result.links.mp4sd, 'm4a': result.links.m4a };
    const direct = map[format] || result.links.mp4 || result.links.mp3;
    if (direct) {
      // Redirect the browser straight to the googlevideo URL.
      // (We can't proxy it server-side — Google ties the URL to the requester,
      // so the browser must fetch it directly. The frontend fetches this as a
      // blob and forces the download, so it saves instead of playing.)
      return res.redirect(302, direct);
    }
  }

  // Fallback: try ytdl-core streaming (works sometimes)
  try {
    const ytdlModule = await import('@distube/ytdl-core').catch(() => null);
    if (!ytdlModule) return res.status(503).json({ error: 'Download unavailable. Please try again later.' });
    const ytdl = ytdlModule.default;
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    let info;
    try { info = await ytdl.getInfo(url); }
    catch (e) { return res.status(502).json({ error: 'Could not access this video. It may be restricted.' }); }

    const rawTitle = info.videoDetails.title;
    let stream, mime, filename;
    if (format === 'mp3' || format === 'm4a') {
      stream = ytdl(url, { quality: 'highestaudio', filter: 'audioonly' });
      mime = 'audio/mpeg'; filename = safeFilename(rawTitle, format === 'mp3' ? 'mp3' : 'm4a');
    } else {
      stream = ytdl(url, { quality: format === 'mp4-sd' ? 'lowest' : 'highestvideo', filter: 'videoandaudio' });
      mime = 'video/mp4'; filename = safeFilename(rawTitle, 'mp4');
    }
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', mime);
    stream.pipe(res);
    stream.on('error', (err) => {
      console.error('[youtube stream]', err.message);
      if (!res.headersSent) res.status(502).json({ error: 'Could not stream this video.' });
      else res.end();
    });
  } catch (err) {
    console.error('[youtube stream]', err.message);
    if (!res.headersSent) res.status(502).json({ error: 'Could not download this video.' });
  }
});

// POST /api/youtube — transcribe a YouTube video
router.post('/', apiRateLimit, async (req, res) => {
  const ip = (req.ip || '').replace('::ffff:', '');
  const { url, timestamps, speakers, language } = req.body || {};
  if (!url) return res.status(400).json({ error: 'YouTube URL required.' });

  try {
    if (await isUserBanned(ip)) return res.status(403).json({ error: 'Your account has been suspended.' });
    if (await isIPBlocked(ip)) return res.status(403).json({ error: 'Access denied.' });
  } catch (e) {}

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'Service temporarily unavailable.' });

  const isYouTube = /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)/.test(url);
  if (!isYouTube) return res.status(400).json({ error: 'Please provide a valid YouTube URL.' });
  const videoId = getVideoId(url);
  if (!videoId) return res.status(400).json({ error: 'Could not extract video ID.' });

  try {
    await logActivity('youtube_transcription_started', ip, { url });

    let title = 'YouTube video';
    try {
      const oembed = await fetchWithTimeout(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`);
      if (oembed.ok) { const d = await oembed.json(); title = d.title || title; }
    } catch (e) {}

    // Get the audio: prefer RapidAPI direct link (smaller m4a downloads faster), fall back to ytdl
    let audioBuffer = null;
    const rapid = await getRapidApiLinks(videoId);
    if (rapid.ok && (rapid.links.m4a || rapid.links.mp3)) {
      try {
        // m4a is typically smaller than mp3 → faster download, same transcription quality
        const audioUrl = rapid.links.m4a || rapid.links.mp3;
        const ar = await fetchWithTimeout(audioUrl, {}, 30000);
        if (ar.ok) audioBuffer = Buffer.from(await ar.arrayBuffer());
      } catch (e) { console.log('[youtube] rapid audio fetch failed:', e.message); }
    }
    if (!audioBuffer) {
      try {
        const ytdlModule = await import('@distube/ytdl-core').catch(() => null);
        if (ytdlModule) {
          const ytdl = ytdlModule.default;
          const stream = ytdl(url, { quality: 'lowestaudio', filter: 'audioonly' });
          const chunks = [];
          await new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error('timeout')), 25000);
            stream.on('data', c => chunks.push(c));
            stream.on('end', () => { clearTimeout(t); resolve(); });
            stream.on('error', e => { clearTimeout(t); reject(e); });
          });
          audioBuffer = Buffer.concat(chunks);
        }
      } catch (e) { console.log('[youtube] ytdl audio failed:', e.message); }
    }

    if (!audioBuffer || audioBuffer.length === 0) {
      return res.status(400).json({ error: 'Could not get audio from this video. Try downloading it as MP3 first, then upload the file.' });
    }
    if (audioBuffer.length > 25 * 1024 * 1024) {
      return res.status(413).json({ error: 'Audio too large (max 25MB). Try a shorter video.' });
    }

    const fd = new FormData();
    fd.append('file', audioBuffer, { filename: 'audio.mp3', contentType: 'audio/mpeg' });
    fd.append('model', 'whisper-1');
    fd.append('response_format', timestamps === 'true' ? 'verbose_json' : 'json');
    if (language && language !== 'auto') fd.append('language', language);

    const whisperRes = await fetchWithTimeout('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, ...fd.getHeaders() },
      body: fd
    }, 45000);

    if (!whisperRes.ok) {
      await logActivity('youtube_transcription_error', ip, { status: whisperRes.status });
      if (whisperRes.status === 429) return res.status(429).json({ error: 'Service busy. Try again shortly.' });
      return res.status(502).json({ error: 'Transcription failed. Please try again.' });
    }

    const data = await whisperRes.json();
    let transcript = data.text || '';
    if (timestamps === 'true' && data.segments) {
      transcript = '';
      data.segments.forEach((seg, i) => {
        const mm = String(Math.floor(seg.start / 60)).padStart(2, '0');
        const ss = String(Math.floor(seg.start % 60)).padStart(2, '0');
        const spk = speakers === 'true' ? `Speaker ${String.fromCharCode(65 + (i % 2))}: ` : '';
        transcript += `[${mm}:${ss}] ${spk}${seg.text.trim()}\n\n`;
      });
    }

    const wordCount = transcript.trim().split(/\s+/).filter(Boolean).length;
    await saveTranscription({ ip, filename: `YouTube: ${title}`, transcript: transcript.trim(), language: data.language, duration: data.duration, wordCount, summary: '' });
    await updateStats('transcribe', { duration: data.duration, language: data.language });
    await upsertUser(ip, 'transcribe', { duration: data.duration });

    res.json({ transcript: transcript.trim(), language: data.language, duration: data.duration, wordCount, title });
  } catch (err) {
    console.error('[youtube]', err.message);
    res.status(500).json({ error: 'Could not transcribe this video.' });
  }
});

export default router;
