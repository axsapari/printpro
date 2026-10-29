// Menjaga project Supabase (free tier) tidak ter-pause karena tidak aktif.
// Memanggil fungsi ping_keepalive() (sql/002_keepalive.sql) yang menulis 1 baris.
// URL & kunci dibaca dari SUPABASE_DEFAULT di js/config.js (atau env SUPABASE_URL / SUPABASE_ANON_KEY).
import { readFileSync } from 'node:fs';

function dariConfig() {
  try {
    const src  = readFileSync(new URL('../js/config.js', import.meta.url), 'utf8');
    const blok = /const SUPABASE_DEFAULT\s*=\s*\{([\s\S]*?)\};/.exec(src);
    const ambil = (k) => (blok && new RegExp(k + ":\\s*'([^']*)'").exec(blok[1]) || [])[1] || '';
    return { url: ambil('url'), key: ambil('key') };
  } catch (e) { return { url: '', key: '' }; }
}

function kunciTerlarang(key) {
  if (/^sb_secret_/.test(key)) return true;
  try {
    const part = key.split('.')[1];
    return !!part && JSON.parse(Buffer.from(part, 'base64url').toString('utf8')).role === 'service_role';
  } catch (e) { return false; }
}

const cfg = dariConfig();
const url = (process.env.SUPABASE_URL || cfg.url).replace(/\/+$/, '');
const key = process.env.SUPABASE_ANON_KEY || cfg.key;

if (!url || !key) {
  console.log('::warning::SUPABASE_DEFAULT di js/config.js belum diisi, keep-alive dilewati.');
  process.exit(0);
}
if (kunciTerlarang(key)) {
  console.error('::error::Kunci yang dipakai adalah service_role/secret. Gunakan kunci anon/publishable.');
  process.exit(1);
}

const headers = { apikey: key, 'Content-Type': 'application/json' };
if (!key.startsWith('sb_')) headers.Authorization = 'Bearer ' + key; // kunci JWT lama; kunci "sb_publishable_" cukup apikey

const jeda = Number(process.env.KEEPALIVE_RETRY_MS || 5000);
let terakhir = '';
for (let i = 1; i <= 3; i++) {
  try {
    const res = await fetch(url + '/rest/v1/rpc/ping_keepalive', {
      method: 'POST', headers, body: '{}', signal: AbortSignal.timeout(20000)
    });
    const isi = await res.text();
    if (res.ok) {
      console.log(`Keep-alive berhasil (percobaan ${i}): ${isi}`);
      process.exit(0);
    }
    terakhir = `HTTP ${res.status}: ${isi.slice(0, 200)}`;
  } catch (e) {
    terakhir = String(e && e.message || e);
  }
  console.log(`Percobaan ${i} gagal: ${terakhir}`);
  if (i < 3) await new Promise(r => setTimeout(r, jeda * i));
}
console.error('::error::Keep-alive gagal 3 kali. Cek apakah project sudah ter-pause (Restore di dashboard Supabase) dan sql/002_keepalive.sql sudah dijalankan. Terakhir: ' + terakhir);
process.exit(1);
