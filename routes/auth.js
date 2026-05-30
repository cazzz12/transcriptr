import express from 'express';
import bcrypt from 'bcryptjs';
import { generateToken } from '../middleware/auth.js';
import { getAdmin, updateAdmin, logActivity } from '../db.js';
import { loginRateLimit } from '../middleware/security.js';

const router = express.Router();

router.post('/login', loginRateLimit, async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const ip = (req.ip||'').replace('::ffff:','');
    if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });
    if (typeof username !== 'string' || typeof password !== 'string') return res.status(400).json({ error: 'Invalid input.' });

    const admin = await getAdmin();
    if (!admin) return res.status(503).json({ error: 'Service not configured.' });

    if (admin.locked_until && new Date(admin.locked_until) > new Date()) {
      const mins = Math.ceil((new Date(admin.locked_until) - new Date()) / 60000);
      return res.status(423).json({ error: `Account locked. Try again in ${mins} minute(s).` });
    }

    // FIX #12: Always run bcrypt.compare even if username is wrong, so response
    // time is constant and an attacker cannot tell which usernames exist (timing attack).
    const passwordValid = await bcrypt.compare(password, admin.password_hash);
    const usernameValid = username === admin.username;
    const valid = passwordValid && usernameValid;

    if (!valid) {
      const attempts = (admin.login_attempts||0) + 1;
      const upd = { login_attempts: attempts };
      if (attempts >= 5) { upd.locked_until = new Date(Date.now()+15*60000).toISOString(); upd.login_attempts = 0; }
      await updateAdmin(upd);
      await logActivity('login_failed', ip, { username: String(username).slice(0,50) });
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    await updateAdmin({ login_attempts:0, locked_until:null, last_login:new Date().toISOString(), last_login_ip:ip });
    const token = generateToken({ username: admin.username, role: 'admin' });
    res.cookie('adminToken', token, { httpOnly:true, secure:process.env.NODE_ENV==='production', sameSite:'strict', maxAge:8*3600000 });
    await logActivity('login_success', ip, { username: admin.username });
    res.json({ success: true });
  } catch(e) {
    console.error('[auth/login]', e.message);
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

router.post('/logout', async (req, res) => {
  res.clearCookie('adminToken');
  res.json({ success: true });
});

export default router;
