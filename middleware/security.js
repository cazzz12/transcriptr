import rateLimit from 'express-rate-limit';

// ─── RATE LIMITING ───
export const globalRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 150,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' },
  skip: (req) => req.path === '/api/health'
});

export const apiRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Hourly transcription limit reached. Try again later.' },
  keyGenerator: (req) => req.ip
});

export const loginRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Wait 15 minutes.' }
});

// FIX #3: Convert-log rate limit
export const convertLogRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests.' }
});

// FIX #6: Memory-safe IP tracker with automatic cleanup
const ipCounts = new Map();
const WINDOW_MS = 60 * 1000;
const MAX_REQUESTS = 120;

// Clean up every 5 minutes to prevent memory leak
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of ipCounts) {
    if (now > entry.reset) ipCounts.delete(ip);
  }
}, 5 * 60 * 1000);

export function botDetection(req, res, next) {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  const entry = ipCounts.get(ip) || { count: 0, reset: now + WINDOW_MS };
  if (now > entry.reset) { entry.count = 0; entry.reset = now + WINDOW_MS; }
  entry.count++;
  ipCounts.set(ip, entry);
  if (entry.count > MAX_REQUESTS) {
    return res.status(429).json({ error: 'Too many requests. You have been temporarily blocked.' });
  }
  next();
}
