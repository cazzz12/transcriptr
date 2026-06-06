import express from 'express';
import multer from 'multer';
import fetch from 'node-fetch';
import FormData from 'form-data';
import { logActivity, updateStats, upsertUser, isUserBanned, isIPBlocked, saveTranscription, getSettings, getUserFromToken, getUserTranscriptions, getUserTranscriptById } from '../db.js';
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

// FIX #11: Server-side daily limit
const dailyUsage = new Map();
// Clean up at midnight
setInterval(() => {
  const today = new Date().toISOString().split('T')[0];
  for (const [key] of dailyUsage) {
    if (!key.endsWith(today)) dailyUsage.delete(key);
  }
}, 60 * 60 * 1000);

function checkServerDailyLimit(ip) {
  const today = new Date().toISOString().split('T')[0];
  const key = `${ip}:${today}`;
  const count = dailyUsage.get(key) || 0;
  if (count >= 3) return false;
  dailyUsage.set(key, count + 1);
  return true;
}

router.post('/', apiRateLimit, upload.single('file'), async (req, res) => {
  const ip = (req.ip || '').replace('::ffff:', '');
  try {
    // FIX #4: Check both isUserBanned AND isIPBlocked
    if (await isUserBanned(ip)) return res.status(403).json({ error: 'Your account has been suspended.' });
    if (await isIPBlocked(ip)) return res.status(403).json({ error: 'Access denied.' });

    const apiKey = process.env.OPENAI_API_KEY;
    // FIX #2: Remove x-openai-key header acceptance — key is server-side only
    if (!apiKey) return res.status(503).json({ error: 'Service temporarily unavailable.' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

    // FIX #5: Server-side daily limit enforcement
    if (!checkServerDailyLimit(ip)) {
      return res.status(429).json({ error: 'Daily free limit reached (3/day). Come back tomorrow or upgrade to Pro.' });
    }

    const settings = await getSettings();
    const maxSize = (settings.max_file_size_mb || 500) * 1024 * 1024;
    if (req.file.size > maxSize) return res.status(413).json({ error: `File too large. Max: ${settings.max_file_size_mb || 500}MB` });

    const { timestamps, speakers, summary, language } = req.body;
    const fixedName = fixFilename(req.file.originalname, req.file.mimetype);

    // End-user account (optional): if a signed-in user's token is sent, tag this transcript to them.
    let userId = null;
    try {
      const authHeader = req.headers.authorization || '';
      const tok = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
      if (tok) { const u = await getUserFromToken(tok); userId = u?.id || null; }
    } catch (e) {}

    await logActivity('transcription_started', ip, { filename: fixedName, size: req.file.size });

    const formData = new FormData();
    formData.append('file', req.file.buffer, { filename: fixedName, contentType: req.file.mimetype });
    formData.append('model', settings.whisper_model || 'whisper-1');
    formData.append('response_format', timestamps === 'true' ? 'verbose_json' : 'json');
    if (language && language !== 'auto') formData.append('language', language);

    // FIX #9: Add timeout to fetch calls
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000); // 2 min timeout

    let whisperRes;
    try {
      whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, ...formData.getHeaders() },
        body: formData,
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!whisperRes.ok) {
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

    res.json({ transcript: transcript.trim(), summary: summaryText, language: data.language, duration: data.duration, wordCount });
  } catch (err) {
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

export default router;
