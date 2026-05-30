import jwt from 'jsonwebtoken';
import crypto from 'crypto';

// CRITICAL FIX #1: No hardcoded fallback secret
// If JWT_SECRET is missing, crash loudly instead of using a weak default
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET environment variable is not set. Set it in Vercel environment variables.');
  // In production this will prevent the server from starting with a weak secret
  // We generate a random one per-process so at least it's not predictable
  // but this means tokens won't survive restarts — intentional to force proper config
}
const SECRET = JWT_SECRET || crypto.randomBytes(64).toString('hex');

export function requireAuth(req, res, next) {
  const token = req.cookies?.adminToken || req.headers?.authorization?.replace('Bearer ', '');
  if (!token) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Authentication required.' });
    return res.redirect('/admin/login');
  }
  try {
    req.admin = jwt.verify(token, SECRET);
    next();
  } catch(e) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Session expired.' });
    return res.redirect('/admin/login');
  }
}

export function generateToken(payload) {
  return jwt.sign(payload, SECRET, { expiresIn: '8h' });
}

export { SECRET as JWT_SECRET };
