import express from 'express';
import bcrypt from 'bcryptjs';
import os from 'os';
import { requireAuth } from '../middleware/auth.js';
import { getAdmin, updateAdmin, getSettings, updateSettings, logActivity, getActivity, clearActivity, getRecentAlerts, getBlockedIPs, blockIP, unblockIP, getUsers, banUser, unbanUser, getStats, getDailyStats, getTranscriptions, getTranscriptionById, deleteTranscription } from '../db.js';

const router = express.Router();
router.use(requireAuth);

// FIX #7: helpers to validate user-supplied params
function toInt(v, def = 0) { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 0 ? n : def; }
function isValidIP(ip) { return typeof ip === 'string' && /^[0-9a-fA-F:.]{3,45}$/.test(ip); }

router.get('/dashboard', async (req, res) => {
  try {
    const [stats, daily, users, alerts, blocked, settings, admin] = await Promise.all([
      getStats(), getDailyStats(14), getUsers(), getRecentAlerts(), getBlockedIPs(), getSettings(), getAdmin()
    ]);
    const ago = new Date(Date.now()-86400000).toISOString();
    const up = process.uptime();
    res.json({
      stats: { totalTranscriptions:stats.total_transcriptions||0, totalConversions:stats.total_conversions||0, totalMinutesTranscribed:Math.round(stats.total_minutes||0), estimatedCost:((stats.total_minutes||0)*0.006).toFixed(2), topLanguages:stats.top_languages||{}, dailyStats:daily },
      users: { total:users.length, activeToday:users.filter(u=>u.last_seen>ago).length, list:users.slice(0,50) },
      security: { blockedIPs:blocked.length, alertsLast24h:alerts.length, autoBlocked:blocked.filter(b=>b.auto_blocked).length, recentAlerts:alerts.slice(0,10) },
      // FIX #8: only expose uptime, never Node version / OS platform / memory internals
      system: { uptime:Math.floor(up), uptimeFormatted:fmtUp(up) },
      settings, admin:{ username:admin?.username, lastLogin:admin?.last_login, lastLoginIp:admin?.last_login_ip }
    });
  } catch(e) {
    console.error('[admin/dashboard]', e.message);
    // FIX: never leak internal error text
    res.status(500).json({ error: 'Could not load dashboard.' });
  }
});

router.get('/activity', async (req,res) => {
  try {
    const r = await getActivity({ type: req.query.type, limit: toInt(req.query.limit,100), offset: toInt(req.query.offset,0) });
    res.json(r);
  } catch(e) { console.error('[admin/activity]', e.message); res.status(500).json({ error:'Error.' }); }
});

router.post('/clear-activity', async (req,res) => {
  try { await clearActivity(); res.json({success:true}); }
  catch(e) { console.error(e.message); res.status(500).json({ error:'Error.' }); }
});

router.get('/blocked-ips', async (req,res) => {
  try { res.json(await getBlockedIPs()); } catch(e) { res.status(500).json({ error:'Error.' }); }
});

router.post('/block-ip', async (req,res) => {
  try {
    const {ip,reason,duration}=req.body||{};
    if(!isValidIP(ip)) return res.status(400).json({error:'Valid IP required.'});
    const dur = toInt(duration, 0);
    await blockIP({ip,reason:String(reason||'').slice(0,200),expiresAt:dur?new Date(Date.now()+dur*3600000).toISOString():null});
    await logActivity('ip_blocked_manual',req.ip,{ip});
    res.json({success:true});
  } catch(e) { console.error(e.message); res.status(500).json({ error:'Error.' }); }
});

router.delete('/block-ip/:ip', async (req,res) => {
  try {
    const ip = decodeURIComponent(req.params.ip);
    if(!isValidIP(ip)) return res.status(400).json({error:'Invalid IP.'});
    await unblockIP(ip);
    res.json({success:true});
  } catch(e) { console.error(e.message); res.status(500).json({ error:'Error.' }); }
});

router.get('/users', async (req,res) => {
  try { res.json(await getUsers()); } catch(e) { res.status(500).json({ error:'Error.' }); }
});

router.post('/users/:id/ban', async (req,res) => {
  try {
    const id = toInt(req.params.id, -1);
    if(id < 0) return res.status(400).json({error:'Invalid ID.'});
    await banUser(id, String(req.body?.reason||'Banned').slice(0,200));
    res.json({success:true});
  } catch(e) { console.error(e.message); res.status(500).json({ error:'Error.' }); }
});

router.post('/users/:id/unban', async (req,res) => {
  try {
    const id = toInt(req.params.id, -1);
    if(id < 0) return res.status(400).json({error:'Invalid ID.'});
    await unbanUser(id);
    res.json({success:true});
  } catch(e) { console.error(e.message); res.status(500).json({ error:'Error.' }); }
});

router.get('/transcriptions', async (req,res) => {
  try {
    const r = await getTranscriptions({ limit:toInt(req.query.limit,50), offset:toInt(req.query.offset,0), search:String(req.query.search||'').slice(0,100) });
    res.json(r);
  } catch(e) { console.error(e.message); res.status(500).json({ error:'Error.' }); }
});

router.get('/transcriptions/:id', async (req,res) => {
  try {
    const id = toInt(req.params.id, -1);
    if(id < 0) return res.status(400).json({error:'Invalid ID.'});
    const t = await getTranscriptionById(id);
    if(!t) return res.status(404).json({error:'Not found.'});
    res.json(t);
  } catch(e) { console.error(e.message); res.status(500).json({ error:'Error.' }); }
});

router.delete('/transcriptions/:id', async (req,res) => {
  try {
    const id = toInt(req.params.id, -1);
    if(id < 0) return res.status(400).json({error:'Invalid ID.'});
    await deleteTranscription(id);
    res.json({success:true});
  } catch(e) { console.error(e.message); res.status(500).json({ error:'Error.' }); }
});

router.get('/settings', async (req,res) => {
  try { res.json(await getSettings()); } catch(e) { res.status(500).json({ error:'Error.' }); }
});

router.patch('/settings', async (req,res) => {
  try {
    const ok=['site_name','maintenance_mode','max_file_size_mb','rate_limit_per_hour','require_login','whisper_model'];
    const u={};
    for(const k of ok) if(req.body[k]!==undefined) u[k]=req.body[k];
    await updateSettings(u);
    res.json({success:true,settings:await getSettings()});
  } catch(e) { console.error(e.message); res.status(500).json({ error:'Error.' }); }
});

router.post('/change-password', async (req,res) => {
  try {
    const {currentPassword,newPassword}=req.body||{};
    if(!currentPassword||!newPassword) return res.status(400).json({error:'Both required.'});
    if(newPassword.length<8) return res.status(400).json({error:'Min 8 chars.'});
    const admin=await getAdmin();
    if(!await bcrypt.compare(currentPassword,admin.password_hash)) return res.status(401).json({error:'Wrong password.'});
    await updateAdmin({password_hash:await bcrypt.hash(newPassword,12)});
    res.json({success:true});
  } catch(e) { console.error(e.message); res.status(500).json({ error:'Error.' }); }
});

function fmtUp(s) { const d=Math.floor(s/86400),h=Math.floor((s%86400)/3600),m=Math.floor((s%3600)/60); if(d>0)return`${d}d ${h}h ${m}m`; if(h>0)return`${h}h ${m}m`; return`${m}m`; }

export default router;
