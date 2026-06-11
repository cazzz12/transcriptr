import express from 'express';
import multer from 'multer';
import fetch from 'node-fetch';
import FormData from 'form-data';
import { logActivity, updateStats, upsertUser, isUserBanned, isIPBlocked, saveTranscription, getSettings, getUserFromToken, getUserTranscriptions, getUserTranscriptById, countTodayTranscriptions, createUploadUrl, downloadFromStorage, removeFromStorage, createSignedDownloadUrl, createJob, getJob, markJob, countTodayRunningJobs, getTranscriptionById, deleteUserTranscript } from '../db.js';
import { apiRateLimit, convertLogRateLimit } from '../middleware/security.js';

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, true)
});

function fixFilename(originalname, mimetype) {
  const extRemap = {
    'mov':'mp4','avi':'mp4','mkv':'mp4','wmv':'mp4','flv':'mp4',
    'aac':'m4a','wma':'mp3','opus':'ogg','3gp':'mp4','ts':'mp4',
    'mts':'mp4','m2ts':'mp4','webp':'mp4'
  };
  const mimeRemap = {
    'video/quicktime':'mp4','video/x-msvideo':'mp4','video/x-matroska':'mp4',
    'audio/aac':'m4a','audio/x-m4a':'m4a','audio/x-flac':'flac'
  };
  const supported = ['flac','m4a','mp3','mp4','mpeg','mpga','oga','ogg','wav','webm'];
  let name = originalname;
  const ext = name.split('.').pop().toLowerCase();
  const fixExt = extRemap[ext] || mimeRemap[mimetype] ||
    (supported.includes(ext) ? ext : (mimetype.startsWith('video') ? 'mp4' : 'mp3'));
  if (fixExt !== ext) name = name.slice(0, name.lastIndexOf('.')) + '.' + fixExt;
  return name;
}

// FIX #11: Daily limit is now counted in the database (see countTodayTranscriptions in db.js),
// so it's reliable on Vercel's serverless setup instead of an in-memory map that resets.

// Hand the browser a one-time URL to upload a file straight to Supabase Storage.
// This bypasses Vercel's 4.5MB request-body limit. We check the daily limit here too,
// so we don't hand out an upload slot to someone who's already out of transcripts.
router.post('/upload-url', apiRateLimit, async (req, res) => {
  const ip = (req.ip || '').replace('::ffff:', '');
  try {
    if (await isUserBanned(ip)) return res.status(403).json({ error: 'Your account has been suspended.' });
    if (await isIPBlocked(ip)) return res.status(403).json({ error: 'Access denied.' });

    let userId = null;
    try {
      const authHeader = req.headers.authorization || '';
      const tok = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
      if (tok) { const u = await getUserFromToken(tok); userId = u?.id || null; }
    } catch (e) {}

    const FREE_ANON_DAILY = 1;
    const FREE_USER_DAILY = 3;
    const usedToday = await countTodayTranscriptions({ userId, ip });
    if (!userId && usedToday >= FREE_ANON_DAILY) {
      return res.status(429).json({ error: "You've used your free transcript for today. Sign in with Google to get 3 per day, free.", needsAuth: true });
    }
    if (userId && usedToday >= FREE_USER_DAILY) {
      return res.status(429).json({ error: "You've reached your 3 free transcripts for today. Please come back tomorrow." });
    }

    const { path, token } = await createUploadUrl();
    res.json({ bucket: 'transcribe-uploads', path, token });
  } catch (e) {
    res.status(500).json({ error: 'Could not start upload. Please try again.' });
  }
});

// ===== GPU transcription via RunPod serverless Whisper (no file-size cap) =====
const RUNPOD_BASE = 'https://api.runpod.ai/v2';

async function runpodFetch(path, opts = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 20000);
  try {
    return await fetch(`${RUNPOD_BASE}/${process.env.RUNPOD_ENDPOINT_ID}${path}`, {
      ...opts,
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.RUNPOD_API_KEY}`, ...(opts.headers || {}) },
      signal: ac.signal
    });
  } finally { clearTimeout(t); }
}

// Parse an SRT string (from the GPU's translate pass) back into timed segments,
// so "Translate to English" keeps real subtitle timings.
function parseSrtToSegments(srt) {
  const segs = [];
  const blocks = String(srt || '').split(/\r?\n\r?\n+/);
  for (const b of blocks) {
    const m = b.match(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/);
    if (!m) continue;
    const start = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 1000;
    const end = (+m[5]) * 3600 + (+m[6]) * 60 + (+m[7]) + (+m[8]) / 1000;
    const text = b.slice(b.indexOf(m[0]) + m[0].length).replace(/^\s+/, '').replace(/\s*\n\s*/g, ' ').trim();
    if (text) segs.push({ start: Math.round(start * 100) / 100, end: Math.round(end * 100) / 100, text });
  }
  return segs;
}

// Start a GPU transcription job for a file the browser already uploaded to Supabase Storage.
router.post('/start', apiRateLimit, async (req, res) => {
  const ip = (req.ip || '').replace('::ffff:', '');
  try {
    if (!process.env.RUNPOD_API_KEY || !process.env.RUNPOD_ENDPOINT_ID) {
      return res.status(503).json({ error: 'Service temporarily unavailable.' });
    }
    if (await isUserBanned(ip)) return res.status(403).json({ error: 'Your account has been suspended.' });
    if (await isIPBlocked(ip)) return res.status(403).json({ error: 'Access denied.' });

    let userId = null;
    try {
      const ah = req.headers.authorization || '';
      const tok = ah.startsWith('Bearer ') ? ah.slice(7) : '';
      if (tok) { const u = await getUserFromToken(tok); userId = u?.id || null; }
    } catch (e) {}

    // Daily limit: finished transcripts today + jobs still running right now.
    const FREE_ANON_DAILY = 1;
    const FREE_USER_DAILY = 3;
    const used = (await countTodayTranscriptions({ userId, ip })) + (await countTodayRunningJobs({ userId, ip }));
    if (!userId && used >= FREE_ANON_DAILY) {
      return res.status(429).json({ error: "You've used your free transcript for today. Sign in with Google to get 3 per day, free.", needsAuth: true });
    }
    if (userId && used >= FREE_USER_DAILY) {
      return res.status(429).json({ error: "You've reached your 3 free transcripts for today. Please come back tomorrow." });
    }

    const sp = String(req.body?.storagePath || '');
    if (!/^[A-Za-z0-9._-]{6,80}$/.test(sp)) return res.status(400).json({ error: 'Invalid upload reference.' });
    const originalName = (req.body?.originalName ? String(req.body.originalName) : 'audio').slice(0, 200);
    const language = req.body?.language && req.body.language !== 'auto' ? String(req.body.language).slice(0, 10) : null;
    const opts = {
      timestamps: req.body?.timestamps === 'true' || req.body?.timestamps === true,
      speakers: req.body?.speakers === 'true' || req.body?.speakers === true,
      summary: req.body?.summary === 'true' || req.body?.summary === true,
      translateEn: req.body?.translateEn === 'true' || req.body?.translateEn === true
    };

    // Signed 6-hour link the GPU uses to fetch the file from the private bucket.
    let audioUrl;
    try { audioUrl = await createSignedDownloadUrl(sp, 21600); }
    catch (e) { return res.status(400).json({ error: 'Uploaded file not found. Please try again.' }); }

    const input = {
      audio: audioUrl,
      model: process.env.RUNPOD_WHISPER_MODEL || 'large-v3',
      transcription: 'plain_text',
      translate: !!opts.translateEn
    };
    // Translated output is requested as SRT so the English text keeps real timings.
    if (opts.translateEn) input.translation = 'srt';
    if (language) input.language = language;

    const rp = await runpodFetch('/run', { method: 'POST', body: JSON.stringify({ input }) });
    if (!rp.ok) {
      await logActivity('transcription_error', ip, { stage: 'runpod_start', status: rp.status });
      return res.status(502).json({ error: 'Could not start transcription. Please try again.' });
    }
    const rj = await rp.json().catch(() => ({}));
    const jobId = rj?.id;
    if (!jobId) return res.status(502).json({ error: 'Could not start transcription. Please try again.' });

    await createJob({ id: jobId, ip, userId, filename: originalName, storagePath: sp, options: opts });
    await logActivity('transcription_started', ip, { filename: originalName, jobId, engine: 'runpod' });
    res.json({ jobId });
  } catch (err) {
    await logActivity('transcription_error', ip, { error: err.message, stage: 'start' });
    res.status(500).json({ error: 'Could not start transcription. Please try again.' });
  }
});

// Poll a GPU job. When it completes, this formats the transcript, makes the
// summary if asked, saves everything, and deletes the uploaded file.
router.get('/status/:jobId', async (req, res) => {
  const ip = (req.ip || '').replace('::ffff:', '');
  try {
    const jobId = String(req.params.jobId || '');
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(jobId)) return res.status(400).json({ error: 'Invalid job.' });
    const job = await getJob(jobId);
    if (!job) return res.status(404).json({ error: 'Job not found.' });

    // Finished earlier (e.g. the page was refreshed) — return the saved result.
    if (job.status === 'done' && job.result_id) {
      const t = await getTranscriptionById(job.result_id);
      if (t) return res.json({ status: 'done', transcript: t.transcript, summary: t.summary || '', language: t.language, duration: t.duration_seconds, wordCount: t.word_count, segments: t.segments || [] });
      return res.status(410).json({ error: 'This transcript is no longer available.' });
    }
    if (job.status === 'failed') return res.status(502).json({ status: 'failed', error: 'Transcription failed. Please try again.' });

    const rp = await runpodFetch(`/status/${jobId}`, { method: 'GET' });
    if (!rp.ok) {
      if (rp.status === 404) {
        await markJob(jobId, { status: 'failed', error: 'expired' });
        await removeFromStorage(job.storage_path);
        return res.status(502).json({ status: 'failed', error: 'This transcription expired. Please try again.' });
      }
      return res.json({ status: 'processing' });
    }
    const rj = await rp.json().catch(() => ({}));
    const st = rj?.status;

    if (st === 'IN_QUEUE') return res.json({ status: 'queued' });
    if (st === 'IN_PROGRESS') return res.json({ status: 'processing' });

    if (st === 'COMPLETED') {
      const out = rj.output || {};
      const jopts = job.options || {};

      // Build clean segments with REAL timings. For "Translate to English" jobs
      // the English text arrives as SRT (to keep timings) — parse it back.
      let segs = [];
      const hasTranslation = !!(jopts.translateEn && typeof out.translation === 'string' && out.translation.trim());
      if (hasTranslation) segs = parseSrtToSegments(out.translation);
      const usedTranslation = hasTranslation && segs.length > 0;
      if (!segs.length && Array.isArray(out.segments)) {
        segs = out.segments.map(sgm => ({
          start: Math.round((sgm.start || 0) * 100) / 100,
          end: Math.round((sgm.end || 0) * 100) / 100,
          text: String(sgm.text || '').trim()
        })).filter(sgm => sgm.text);
      }

      let transcript = '';
      if (jopts.timestamps && segs.length) {
        segs.forEach((seg, i) => {
          const mm = String(Math.floor((seg.start || 0) / 60)).padStart(2, '0');
          const ss = String(Math.floor((seg.start || 0) % 60)).padStart(2, '0');
          const spk = jopts.speakers ? `Speaker ${String.fromCharCode(65 + (i % 2))}: ` : '';
          transcript += `[${mm}:${ss}] ${spk}${seg.text}\n\n`;
        });
      } else {
        const raw = usedTranslation
          ? segs.map(sgm => sgm.text).join(' ')
          : ((typeof out.transcription === 'string' && out.transcription)
              ? out.transcription
              : segs.map(sgm => sgm.text).join(' '));
        if (jopts.speakers) {
          (raw.match(/[^.!?]+[.!?]+/g) || [raw]).forEach((sx, i) => {
            transcript += `Speaker ${String.fromCharCode(65 + (i % 2))}: ${sx.trim()}\n\n`;
          });
        } else { transcript = raw; }
      }
      transcript = transcript.trim();

      if (!transcript) {
        await markJob(jobId, { status: 'failed', error: 'empty' });
        await removeFromStorage(job.storage_path);
        return res.status(502).json({ status: 'failed', error: 'No speech could be detected in this file.' });
      }

      const duration = segs.length ? Math.round(segs[segs.length - 1].end || 0) : 0;
      const detectedLang = usedTranslation ? 'en' : (out.detected_language || null);

      let summaryText = '';
      if (jopts.summary) {
        try {
          const ck = process.env.ANTHROPIC_API_KEY;
          if (ck) {
            const sc = new AbortController();
            const stm = setTimeout(() => sc.abort(), 30000);
            try {
              const sr = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-api-key': ck, 'anthropic-version': '2023-06-01' },
                body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 300,
                  messages: [{ role: 'user', content: `Summarise in 3 sentences:\n\n${transcript.slice(0, 3000)}` }] }),
                signal: sc.signal
              });
              if (sr.ok) { const sd = await sr.json(); summaryText = sd.content?.[0]?.text || ''; }
            } finally { clearTimeout(stm); }
          }
        } catch (e) {}
      }

      const wordCount = transcript.split(/\s+/).filter(Boolean).length;
      const saved = await saveTranscription({ ip: job.ip || ip, filename: job.filename, transcript, summary: summaryText, language: detectedLang, duration, wordCount, userId: job.user_id, segments: segs.length ? segs : null });
      await markJob(jobId, { status: 'done', result_id: saved?.id || null });
      await updateStats('transcribe', { duration, language: detectedLang });
      await upsertUser(job.ip || ip, 'transcribe', { duration });
      await logActivity('transcription_complete', ip, { filename: job.filename, duration, language: detectedLang, words: wordCount, engine: 'runpod' });
      await removeFromStorage(job.storage_path);

      return res.json({ status: 'done', transcript, summary: summaryText, language: detectedLang, duration, wordCount, segments: segs });
    }

    // FAILED / CANCELLED / TIMED_OUT
    await markJob(jobId, { status: 'failed', error: String(st || 'failed') });
    await removeFromStorage(job.storage_path);
    await logActivity('transcription_error', ip, { jobId, stage: 'runpod', status: st });
    return res.status(502).json({ status: 'failed', error: st === 'TIMED_OUT' ? 'This recording took too long to transcribe. Please try a shorter file.' : 'Transcription failed. Please try again.' });
  } catch (err) {
    // Transient hiccup (network/db): tell the page to just keep polling.
    return res.json({ status: 'processing' });
  }
});

router.post('/', apiRateLimit, upload.single('file'), async (req, res) => {
  const ip = (req.ip || '').replace('::ffff:', '');
  let cleanupPath = null;
  try {
    // FIX #4: Check both isUserBanned AND isIPBlocked
    if (await isUserBanned(ip)) return res.status(403).json({ error: 'Your account has been suspended.' });
    if (await isIPBlocked(ip)) return res.status(403).json({ error: 'Access denied.' });

    const apiKey = process.env.OPENAI_API_KEY;
    // FIX #2: Remove x-openai-key header acceptance — key is server-side only
    if (!apiKey) return res.status(503).json({ error: 'Service temporarily unavailable.' });

    // Identify the user first (if signed in) — needed for the daily limit below.
    let userId = null;
    try {
      const authHeader = req.headers.authorization || '';
      const tok = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
      if (tok) { const u = await getUserFromToken(tok); userId = u?.id || null; }
    } catch (e) {}

    // Daily free limit: 1/day for anonymous (must sign in for more), 3/day for signed-in free accounts.
    const FREE_ANON_DAILY = 1;
    const FREE_USER_DAILY = 3;
    const usedToday = await countTodayTranscriptions({ userId, ip });
    if (!userId && usedToday >= FREE_ANON_DAILY) {
      return res.status(429).json({ error: "You've used your free transcript for today. Sign in with Google to get 3 per day, free.", needsAuth: true });
    }
    if (userId && usedToday >= FREE_USER_DAILY) {
      return res.status(429).json({ error: "You've reached your 3 free transcripts for today. Please come back tomorrow." });
    }

    const settings = await getSettings();

    // Resolve the audio source. New path: the browser uploaded straight to Supabase
    // Storage (bypassing Vercel's 4.5MB limit) and sent us the path. Legacy path:
    // a normal multipart upload (still accepted for small files / backward compat).
    let fileBuffer, srcName, srcMime, srcSize;
    if (req.body && req.body.storagePath) {
      const sp = String(req.body.storagePath);
      if (!/^[A-Za-z0-9._-]{6,80}$/.test(sp)) return res.status(400).json({ error: 'Invalid upload reference.' });
      cleanupPath = sp;
      try { fileBuffer = await downloadFromStorage(sp); }
      catch (e) { return res.status(400).json({ error: 'Uploaded file not found. Please try again.' }); }
      srcName = (req.body.originalName ? String(req.body.originalName) : 'audio.mp3').slice(0, 200);
      srcMime = (req.body.mimeType ? String(req.body.mimeType) : '') || 'audio/mpeg';
      srcSize = fileBuffer.length;
    } else if (req.file) {
      fileBuffer = req.file.buffer;
      srcName = req.file.originalname;
      srcMime = req.file.mimetype;
      srcSize = req.file.size;
    } else {
      return res.status(400).json({ error: 'No file uploaded.' });
    }

    // OpenAI Whisper rejects anything over 25MB on every model — hard cap here.
    const OPENAI_MAX = 25 * 1024 * 1024;
    if (srcSize > OPENAI_MAX) {
      if (cleanupPath) await removeFromStorage(cleanupPath);
      return res.status(413).json({ error: 'File too large. The most we can transcribe is 25 MB — try a shorter clip or compress the audio first.' });
    }

    const { timestamps, speakers, summary, language } = req.body;
    const fixedName = fixFilename(srcName, srcMime);

    await logActivity('transcription_started', ip, { filename: fixedName, size: srcSize });

    const formData = new FormData();
    formData.append('file', fileBuffer, { filename: fixedName, contentType: srcMime });
    formData.append('model', settings.whisper_model || 'whisper-1');
    formData.append('response_format', timestamps === 'true' ? 'verbose_json' : 'json');
    if (language && language !== 'auto') formData.append('language', language);

    // Vercel's free plan kills any function at 60s, so abort at 50s — that lets us
    // clean up and return a clear message instead of an opaque gateway timeout.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 50000);

    let whisperRes;
    try {
      whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, ...formData.getHeaders() },
        body: formData,
        signal: controller.signal
      });
    } catch (e) {
      if (cleanupPath) await removeFromStorage(cleanupPath);
      if (e.name === 'AbortError') return res.status(504).json({ error: 'This recording is taking too long to transcribe. Please try a shorter clip (under about 20 minutes).' });
      throw e;
    } finally {
      clearTimeout(timeout);
    }

    if (!whisperRes.ok) {
      if (cleanupPath) await removeFromStorage(cleanupPath);
      const err = await whisperRes.json().catch(() => ({}));
      await logActivity('transcription_error', ip, { status: whisperRes.status });
      if (whisperRes.status === 401) return res.status(503).json({ error: 'Service configuration error.' });
      if (whisperRes.status === 429) return res.status(429).json({ error: 'Service busy. Try again shortly.' });
      return res.status(whisperRes.status).json({ error: err?.error?.message || 'Transcription failed.' });
    }

    const data = await whisperRes.json();
    let transcript = '';

    if (timestamps === 'true' && data.segments) {
      data.segments.forEach((seg, i) => {
        const mm = String(Math.floor(seg.start/60)).padStart(2,'0');
        const ss = String(Math.floor(seg.start%60)).padStart(2,'0');
        const spk = speakers === 'true' ? `Speaker ${String.fromCharCode(65+(i%2))}: ` : '';
        transcript += `[${mm}:${ss}] ${spk}${seg.text.trim()}\n\n`;
      });
    } else {
      const raw = data.text || '';
      if (speakers === 'true') {
        (raw.match(/[^.!?]+[.!?]+/g) || [raw]).forEach((s, i) => {
          transcript += `Speaker ${String.fromCharCode(65+(i%2))}: ${s.trim()}\n\n`;
        });
      } else { transcript = raw; }
    }

    let summaryText = '';
    if (summary === 'true' && transcript.trim()) {
      try {
        const ck = process.env.ANTHROPIC_API_KEY;
        if (ck) {
          const sc = new AbortController();
          const st = setTimeout(() => sc.abort(), 30000);
          try {
            const sr = await fetch('https://api.anthropic.com/v1/messages', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-api-key': ck, 'anthropic-version': '2023-06-01' },
              body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 300,
                messages: [{ role: 'user', content: `Summarise in 3 sentences:\n\n${transcript.slice(0, 3000)}` }] }),
              signal: sc.signal
            });
            if (sr.ok) { const sd = await sr.json(); summaryText = sd.content?.[0]?.text || ''; }
          } finally { clearTimeout(st); }
        }
      } catch (e) {}
    }

    const wordCount = transcript.trim().split(/\s+/).filter(Boolean).length;
    await saveTranscription({ ip, filename: fixedName, transcript: transcript.trim(), summary: summaryText, language: data.language, duration: data.duration, wordCount, userId });
    await updateStats('transcribe', { duration: data.duration, language: data.language });
    await upsertUser(ip, 'transcribe', { duration: data.duration });
    await logActivity('transcription_complete', ip, { filename: fixedName, duration: data.duration, language: data.language, words: wordCount });

    if (cleanupPath) await removeFromStorage(cleanupPath);
    res.json({ transcript: transcript.trim(), summary: summaryText, language: data.language, duration: data.duration, wordCount });
  } catch (err) {
    if (cleanupPath) await removeFromStorage(cleanupPath);
    await logActivity('transcription_error', ip, { error: err.message });
    // FIX: Never expose internal error details
    res.status(500).json({ error: 'An error occurred. Please try again.' });
  }
});

// FIX #3: convert-log now has rate limiting and input validation
router.post('/convert-log', convertLogRateLimit, async (req, res) => {
  const ip = (req.ip || '').replace('::ffff:', '');
  // Only log safe fields, ignore anything else
  const { format, size } = req.body || {};
  await updateStats('convert', {});
  await upsertUser(ip, 'convert', {});
  await logActivity('conversion_complete', ip, {
    format: typeof format === 'string' ? format.slice(0, 20) : 'unknown',
    size: typeof size === 'number' ? size : 0
  });
  res.json({ success: true });
});

// ===== End-user account: "My Transcripts" =====
async function requireUser(req, res) {
  const authHeader = req.headers.authorization || '';
  const tok = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!tok) { res.status(401).json({ error: 'Please sign in.' }); return null; }
  const user = await getUserFromToken(tok);
  if (!user) { res.status(401).json({ error: 'Your session expired. Please sign in again.' }); return null; }
  return user;
}

// List my transcripts (newest first)
router.get('/mine', async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const items = await getUserTranscriptions(user.id, { limit: 100 });
    res.json({ items });
  } catch (e) {
    res.status(500).json({ error: 'Could not load your transcripts.' });
  }
});

// Get one of my transcripts, with the full text
router.get('/mine/:id', async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const item = await getUserTranscriptById(user.id, req.params.id);
    if (!item) return res.status(404).json({ error: 'Transcript not found.' });
    res.json({ item });
  } catch (e) {
    res.status(500).json({ error: 'Could not load that transcript.' });
  }
});

// Delete one of my transcripts permanently (GDPR right to erasure)
router.delete('/mine/:id', async (req, res) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const ok = await deleteUserTranscript(user.id, req.params.id);
    if (!ok) return res.status(404).json({ error: 'Transcript not found.' });
    await logActivity('transcript_deleted', (req.ip || '').replace('::ffff:', ''), { id: String(req.params.id) });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Could not delete that transcript.' });
  }
});

export default router;
