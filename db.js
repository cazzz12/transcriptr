import { createClient } from '@supabase/supabase-js';

let _sb = null;
function sb() {
  if (_sb) return _sb;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY required in .env');
  _sb = createClient(url, key, { auth: { persistSession: false } });
  return _sb;
}

// ───── Storage helpers: let the browser upload files directly to Supabase,
// bypassing Vercel's 4.5MB request limit. All access is via the service key. ─────
const UPLOAD_BUCKET = 'transcribe-uploads';

// Create a one-time signed URL the browser can upload a single file to.
export async function createUploadUrl() {
  const path = `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
  const { data, error } = await sb().storage.from(UPLOAD_BUCKET).createSignedUploadUrl(path);
  if (error) throw error;
  return { path, token: data.token };
}

// Pull an uploaded file back out of storage as a Buffer (to forward to Whisper).
export async function downloadFromStorage(path) {
  const { data, error } = await sb().storage.from(UPLOAD_BUCKET).download(path);
  if (error) throw error;
  return Buffer.from(await data.arrayBuffer());
}

// Delete an uploaded file once we're finished with it.
export async function removeFromStorage(path) {
  try { await sb().storage.from(UPLOAD_BUCKET).remove([path]); } catch (e) {}
}

// Signed, expiring download URL so the RunPod GPU can fetch a file from the private bucket.
export async function createSignedDownloadUrl(path, expiresInSeconds = 21600) {
  const { data, error } = await sb().storage.from(UPLOAD_BUCKET).createSignedUrl(path, expiresInSeconds);
  if (error) throw error;
  return data.signedUrl;
}

// ===== GPU transcription jobs (RunPod) =====
export async function createJob({ id, ip, userId, filename, storagePath, options }) {
  await sb().from('transcribe_jobs').insert({
    id, ip: (ip || '').replace('::ffff:', ''), user_id: userId || null,
    filename: filename || null, storage_path: storagePath, options: options || {}, status: 'running'
  });
}
export async function getJob(id) {
  const { data } = await sb().from('transcribe_jobs').select('*').eq('id', id).maybeSingle();
  return data || null;
}
export async function markJob(id, fields) {
  try { await sb().from('transcribe_jobs').update(fields).eq('id', id); } catch (e) {}
}
// Jobs still running today — counted toward the daily limit so it can't be bypassed
// by starting several jobs before the first one finishes.
export async function countTodayRunningJobs({ userId, ip }) {
  const start = new Date(); start.setUTCHours(0, 0, 0, 0);
  let q = sb().from('transcribe_jobs').select('*', { count: 'exact', head: true })
    .eq('status', 'running').gte('created_at', start.toISOString());
  if (userId) { q = q.eq('user_id', userId); }
  else { q = q.is('user_id', null).eq('ip', (ip || '').replace('::ffff:', '')); }
  const { count } = await q;
  return count || 0;
}

export async function getAdmin() {
  const { data } = await sb().from('admin').select('*').eq('id', 1).single();
  return data;
}
export async function updateAdmin(fields) {
  await sb().from('admin').update(fields).eq('id', 1);
}
export async function getSettings() {
  const { data } = await sb().from('settings').select('*').eq('id', 1).single();
  return data || {};
}
export async function updateSettings(fields) {
  await sb().from('settings').upsert({ id: 1, ...fields });
}
export async function logActivity(type, ip, details = {}) {
  try {
    await sb().from('activity').insert({ type, ip: (ip||'').replace('::ffff:',''), details, created_at: new Date().toISOString() });
  } catch(e) {}
}
export async function getActivity({ type, limit = 100, offset = 0 } = {}) {
  let q = sb().from('activity').select('*', { count: 'exact' }).order('created_at', { ascending: false }).range(offset, offset+limit-1);
  if (type) q = q.eq('type', type);
  const { data, count } = await q;
  return { items: data||[], total: count||0 };
}
export async function clearActivity() {
  await sb().from('activity').delete().neq('id', 0);
}
export async function getRecentAlerts() {
  const since = new Date(Date.now()-86400000).toISOString();
  const { data } = await sb().from('activity').select('*').in('type',['auto_blocked','brute_force_attempt','rate_limit_api','login_failed']).gte('created_at', since).order('created_at',{ascending:false}).limit(20);
  return data||[];
}
export async function getBlockedIPs() {
  const { data } = await sb().from('blocked_ips').select('*').order('blocked_at',{ascending:false});
  return data||[];
}
export async function isIPBlocked(ip) {
  const clean = (ip||'').replace('::ffff:','');
  const { data } = await sb().from('blocked_ips').select('*').eq('ip', clean).maybeSingle();
  if (!data) return false;
  if (data.expires_at && new Date(data.expires_at) < new Date()) { await unblockIP(clean); return false; }
  return true;
}
export async function blockIP({ ip, reason, expiresAt, autoBlocked=false }) {
  const clean = (ip||'').replace('::ffff:','');
  await sb().from('blocked_ips').upsert({ ip: clean, reason, expires_at: expiresAt||null, auto_blocked: autoBlocked, blocked_at: new Date().toISOString() }, { onConflict: 'ip' });
}
export async function unblockIP(ip) {
  await sb().from('blocked_ips').delete().eq('ip', (ip||'').replace('::ffff:',''));
}
export async function getUsers() {
  const { data } = await sb().from('users').select('*').order('last_seen',{ascending:false});
  return data||[];
}
export async function upsertUser(ip, action, details={}) {
  const clean = (ip||'').replace('::ffff:','');
  const { data: u } = await sb().from('users').select('*').eq('ip', clean).maybeSingle();
  if (!u) {
    await sb().from('users').insert({ ip: clean, first_seen: new Date().toISOString(), last_seen: new Date().toISOString(), transcriptions: action==='transcribe'?1:0, conversions: action==='convert'?1:0, total_minutes: action==='transcribe'?(details.duration||0)/60:0, banned: false });
  } else {
    const upd = { last_seen: new Date().toISOString() };
    if (action==='transcribe') { upd.transcriptions=(u.transcriptions||0)+1; upd.total_minutes=(u.total_minutes||0)+(details.duration||0)/60; }
    if (action==='convert') upd.conversions=(u.conversions||0)+1;
    await sb().from('users').update(upd).eq('ip', clean);
  }
}
export async function banUser(id, reason) {
  await sb().from('users').update({ banned:true, banned_at:new Date().toISOString(), banned_reason:reason }).eq('id', id);
}
export async function unbanUser(id) {
  await sb().from('users').update({ banned:false, banned_at:null, banned_reason:null }).eq('id', id);
}
export async function isUserBanned(ip) {
  const { data } = await sb().from('users').select('banned').eq('ip', (ip||'').replace('::ffff:','')).maybeSingle();
  return data?.banned||false;
}
export async function saveTranscription({ ip, filename, transcript, language, duration, wordCount, summary, userId }) {
  const { data } = await sb().from('transcriptions').insert({ ip:(ip||'').replace('::ffff:',''), user_id: userId||null, filename, transcript, summary:summary||null, language:language||null, duration_seconds:Math.round(duration||0), word_count:wordCount||0, created_at:new Date().toISOString() }).select().single();
  return data;
}

// ===== End-user accounts (Supabase Auth) =====
// Verify a Supabase access token (JWT) and return the signed-in user, or null.
export async function getUserFromToken(token) {
  if (!token) return null;
  try {
    const { data, error } = await sb().auth.getUser(token);
    if (error) return null;
    return data?.user || null;
  } catch (e) { return null; }
}
// Count how many transcripts this identity has made since midnight UTC today (DB-backed daily limit).
export async function countTodayTranscriptions({ userId, ip }) {
  const start = new Date(); start.setUTCHours(0, 0, 0, 0);
  let q = sb().from('transcriptions').select('*', { count: 'exact', head: true }).gte('created_at', start.toISOString());
  if (userId) { q = q.eq('user_id', userId); }
  else { q = q.is('user_id', null).eq('ip', (ip || '').replace('::ffff:', '')); }
  const { count } = await q;
  return count || 0;
}
// List a signed-in user's own transcripts (lightweight: no full transcript text).
export async function getUserTranscriptions(userId, { limit = 100 } = {}) {
  if (!userId) return [];
  const { data } = await sb().from('transcriptions')
    .select('id,filename,language,duration_seconds,word_count,summary,created_at')
    .eq('user_id', userId).order('created_at', { ascending: false }).limit(limit);
  return data || [];
}
// Fetch ONE transcript (full text) that belongs to this user. Returns null if it isn't theirs.
export async function getUserTranscriptById(userId, id) {
  if (!userId) return null;
  const { data } = await sb().from('transcriptions').select('*')
    .eq('id', id).eq('user_id', userId).maybeSingle();
  return data || null;
}
export async function getTranscriptions({ limit=50, offset=0, search='' }={}) {
  let q = sb().from('transcriptions').select('id,ip,filename,language,duration_seconds,word_count,summary,created_at',{count:'exact'}).order('created_at',{ascending:false}).range(offset,offset+limit-1);
  if (search) q = q.ilike('filename', `%${search}%`);
  const { data, count } = await q;
  return { items:data||[], total:count||0 };
}
export async function getTranscriptionById(id) {
  const { data } = await sb().from('transcriptions').select('*').eq('id', id).single();
  return data;
}
export async function deleteTranscription(id) {
  await sb().from('transcriptions').delete().eq('id', id);
}
export async function getStats() {
  const { data } = await sb().from('stats').select('*').eq('id', 1).single();
  return data||{};
}
export async function updateStats(action, details={}) {
  const s = await getStats();
  const today = new Date().toISOString().split('T')[0];
  const upd = { id:1, total_transcriptions:(s.total_transcriptions||0)+(action==='transcribe'?1:0), total_conversions:(s.total_conversions||0)+(action==='convert'?1:0), total_minutes:(s.total_minutes||0)+(action==='transcribe'?(details.duration||0)/60:0), top_languages:s.top_languages||{}, updated_at:new Date().toISOString() };
  if (action==='transcribe'&&details.language) upd.top_languages[details.language]=(upd.top_languages[details.language]||0)+1;
  await sb().from('stats').upsert(upd);
  const { data: day } = await sb().from('daily_stats').select('*').eq('date', today).maybeSingle();
  if (!day) {
    await sb().from('daily_stats').insert({ date:today, transcriptions:action==='transcribe'?1:0, conversions:action==='convert'?1:0, minutes:action==='transcribe'?(details.duration||0)/60:0 });
  } else {
    await sb().from('daily_stats').update({ transcriptions:(day.transcriptions||0)+(action==='transcribe'?1:0), conversions:(day.conversions||0)+(action==='convert'?1:0), minutes:(day.minutes||0)+(action==='transcribe'?(details.duration||0)/60:0) }).eq('date', today);
  }
}
export async function getDailyStats(days=14) {
  const since = new Date(Date.now()-days*86400000).toISOString().split('T')[0];
  const { data } = await sb().from('daily_stats').select('*').gte('date', since).order('date');
  return data||[];
}
