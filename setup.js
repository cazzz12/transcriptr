import bcrypt from 'bcryptjs';
import readline from 'readline';
import fs from 'fs';
import { createClient } from '@supabase/supabase-js';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = q => new Promise(r => rl.question(q, r));

console.log('\n🔐 Transcriptr Setup\n');

try { fs.readFileSync('.env','utf8').split('\n').forEach(l=>{const[k,...v]=l.split('=');if(k&&v.length&&!process.env[k.trim()])process.env[k.trim()]=v.join('=').trim();}); } catch(e){}

const url  = process.env.SUPABASE_URL  || await ask('Supabase URL: ');
const key  = process.env.SUPABASE_SERVICE_KEY || await ask('Supabase service_role key: ');
const user = await ask('Admin username (default: admin): ') || 'admin';
const pass = await ask('Admin password (min 8 chars): ');

if (pass.length < 8) { console.error('❌ Password too short.'); process.exit(1); }

const sb = createClient(url, key, { auth: { persistSession: false } });
const hash = await bcrypt.hash(pass, 12);
const { error } = await sb.from('admin').upsert({ id:1, username:user, password_hash:hash, created_at:new Date().toISOString() });
if (error) { console.error('❌ Error:', error.message, '\n→ Make sure you ran supabase-schema.sql first.'); process.exit(1); }
await sb.from('settings').upsert({ id:1 });
await sb.from('stats').upsert({ id:1, total_transcriptions:0, total_conversions:0, total_minutes:0, top_languages:{} });

const jwt = Array.from({length:64},()=>Math.random().toString(36)[2]).join('');
fs.writeFileSync('.env', `SUPABASE_URL=${url}\nSUPABASE_SERVICE_KEY=${key}\nOPENAI_API_KEY=sk-your-key-here\nANTHROPIC_API_KEY=sk-ant-your-key-here\nJWT_SECRET=${jwt}\nPORT=3000\nNODE_ENV=production\n`);

rl.close();
console.log(`\n✅ Done! Admin: "${user}"\n▶  Run: npm start\n`);
