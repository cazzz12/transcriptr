import express from 'express';
import cookieParser from 'cookie-parser';
import compression from 'compression';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { requireAuth } from './middleware/auth.js';
import { botDetection } from './middleware/security.js';
import authRoutes from './routes/auth.js';
import adminRoutes from './routes/admin.js';
import transcribeRoutes from './routes/transcribe.js';
import youtubeRoutes from './routes/youtube.js';

// Load .env
try {
  fs.readFileSync('.env', 'utf8').split('\n').forEach(line => {
    const [k, ...v] = line.split('=');
    if (k && v.length && !process.env[k.trim()]) process.env[k.trim()] = v.join('=').trim();
  });
} catch(e) {}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(compression());
app.use(cookieParser());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

// FIX #8 (CORS): only allow localhost in development, never in production
const allowedOrigins = [
  'https://transcriptr.nl',
  'https://www.transcriptr.nl',
  'https://transcriptr-o.vercel.app'
];
if (!IS_PROD) allowedOrigins.push('http://localhost:3000');

app.use(cors({
  origin: function(origin, callback) {
    // allow same-origin / curl (no origin) and whitelisted origins only
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(null, false);
  },
  credentials: true
}));

app.use((req, res, next) => {
  res.removeHeader('X-Powered-By');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://fonts.gstatic.com; " +
    "font-src 'self' https://fonts.gstatic.com https://fonts.googleapis.com; " +
    "img-src 'self' data: blob: https://img.youtube.com; " +
    "connect-src 'self' https://api.openai.com https://api.anthropic.com https://*.supabase.co; " +
    "media-src 'self' blob:; " +
    "worker-src 'self' blob:; " +
    "frame-src 'none'; " +
    "object-src 'none';"
  );
  next();
});

// FIX #6: use the memory-safe botDetection from security.js (auto-cleans, no leak)
app.use(botDetection);

// FIX #12 (CSRF): require a custom header on state-changing API calls.
// Browsers cannot send custom headers cross-origin without passing CORS preflight,
// so this blocks classic CSRF where a malicious site auto-submits a form.
app.use('/api', (req, res, next) => {
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();
  // Login is exempt (no session yet) but still protected by rate limiting
  if (req.path === '/auth/login') return next();
  const origin = req.headers.origin;
  // Allow if origin is whitelisted OR the same-origin fetch header is present
  if (origin && allowedOrigins.includes(origin)) return next();
  if (req.headers['x-requested-with'] === 'fetch') return next();
  // Block cross-site state-changing requests
  if (!origin) return next(); // same-origin server-to-server (no Origin header)
  return res.status(403).json({ error: 'Cross-origin request blocked.' });
});

app.use((req, res, next) => {
  if (req.path.endsWith('.html') || req.path === '/') {
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/transcribe', transcribeRoutes);
app.use('/api/youtube', youtubeRoutes);
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// Admin pages
app.get('/admin/login', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'admin-login.html')));
app.get('/admin*', requireAuth, (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// Static + fallback
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0, etag: false, index: false }));
app.get('*', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error('[error]', err.message);
  res.status(err.status || 500).json({ error: 'An error occurred.' });
});

app.listen(PORT, () => {
  console.log(`\n✅ Transcriptr → http://localhost:${PORT}`);
  console.log(`🔐 Admin    → http://localhost:${PORT}/admin\n`);
});
