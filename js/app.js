// ================================================================
//  LOADING SCREEN HELPERS (global scope)
// ================================================================
function setLoading(msg) {
  const el = document.getElementById('loading-msg');
  if (el) el.textContent = msg;
}
function hideLoading() {
  const ls = document.getElementById('loading-screen');
  if (ls) ls.style.display = 'none';
}
function showError(msg) {
  const el = document.getElementById('loading-msg');
  if (el) { el.innerHTML = msg; el.style.color = '#ef4444'; }
}
function debugLog(msg) {
  console.log('[Debug]', msg);
  const el = document.getElementById('loading-debug');
  if (el) el.innerHTML += msg + '<br>';
}

// ================================================================
//  CDN LOADER — dimuat secara dinamis, tidak memblokir render
// ================================================================
function loadScript(src, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    if (document.querySelector('script[src="' + src + '"]')) { resolve(); return; }
    const s = document.createElement('script');
    s.src = src;
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        reject(new Error('Timeout (' + (timeoutMs/1000) + 's) memuat: ' + src));
      }
    }, timeoutMs);
    s.onload = () => {
      if (!done) { done = true; clearTimeout(timer); resolve(); }
    };
    s.onerror = () => {
      if (!done) { done = true; clearTimeout(timer); reject(new Error('Gagal memuat (network/blocked): ' + src)); }
    };
    document.head.appendChild(s);
  });
}

// Promise global yang resolve saat semua CDN selesai dimuat.
// Dipakai oleh IIFE inisialisasi di akhir file (harus menunggu ini selesai).
const _cdnReady = (async () => {
  const loadTimer = setTimeout(() => {
    showError('⚠️ Terlalu lama memuat. Cek koneksi internet lalu <a href="" style="color:#3b82f6">refresh</a>.');
  }, 15000);

  try {
    debugLog('Memulai loadScript Supabase (jsdelivr)...');
    setLoading('Memuat Supabase...');
    try {
      await loadScript('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2');
      debugLog('✓ jsdelivr berhasil.');
    } catch (e1) {
      debugLog('✗ jsdelivr gagal: ' + e1.message);
      console.warn('jsDelivr gagal, coba CDN cadangan:', e1.message);
      setLoading('Memuat Supabase (CDN cadangan)...');
      debugLog('Mencoba unpkg.com...');
      await loadScript('https://unpkg.com/@supabase/supabase-js@2/dist/umd/supabase.js');
      debugLog('✓ unpkg berhasil.');
    }

    debugLog('Verifikasi window.supabase: ' + (typeof window.supabase));
    if (typeof window.supabase === 'undefined' || !window.supabase.createClient) {
      throw new Error('Script termuat tapi window.supabase tidak terdefinisi (kemungkinan CORS/MIME blocked)');
    }

    setLoading('Memuat jsPDF...');
    debugLog('Memuat jsPDF...');
    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js');
    debugLog('✓ jsPDF berhasil.');
    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js');
    debugLog('✓ jsPDF-autotable berhasil.');

    setLoading('Menginisialisasi aplikasi...');
    clearTimeout(loadTimer);
    return true;
  } catch (cdnErr) {
    clearTimeout(loadTimer);
    debugLog('✗ FATAL: ' + cdnErr.message);
    showError('❌ Gagal memuat library: ' + cdnErr.message + '<br>Kemungkinan CDN diblokir jaringan/ISP/Adblocker Anda.<br><a href="" style="color:#3b82f6">Coba lagi</a>');
    throw cdnErr;
  }
})();

// ════════════════════════════════════════════════════════════════
// SEMUA FUNGSI & DEKLARASI APLIKASI — GLOBAL SCOPE
// Diletakkan di luar IIFE supaya bisa diakses dari onclick="..." di HTML
// ════════════════════════════════════════════════════════════════

// ----------------------------------------------------------------
//  STATE GLOBAL
// ----------------------------------------------------------------
let sbClient   = null;   // Instance Supabase client (BUKAN window.supabase, untuk hindari shadowing)
let CU         = null;   // Current User { key, uid, name, role, ... }
let selKey     = null;   // Key akun yang dipilih di login screen

// Cache data lokal (di-refresh dari DB setiap kali dbLoad())
let _cache = {
  kuitansi:  [],
  modal:     [],
  plManual:  [],
  logs:      [],
  templates: []
};

// State lain
let _lastKwt      = null;  // Data kuitansi terakhir untuk PDF export
let _notifCount   = 0;     // Counter notif badge
let _notifEnabled = false; // Apakah browser notification sudah diizinkan
let _realtimeCh   = null;  // Supabase realtime channel
let _reloadTimer  = null;  // Debounce timer untuk realtime reload
let _syncTimer    = null;  // Timer untuk reset sync badge ke idle
let rows          = [];    // Baris item di form kuitansi

// ================================================================
//  SUPABASE — INISIALISASI & CONFIG
// ================================================================

// Konfigurasi bawaan dari js/config.js (SUPABASE_DEFAULT). Bila ada, dipakai di semua perangkat.
function hasDefaultSbConfig() {
  return typeof SUPABASE_DEFAULT !== 'undefined' && !!(SUPABASE_DEFAULT.url && SUPABASE_DEFAULT.key);
}

function getSbConfig() {
  if (hasDefaultSbConfig()) return { url: SUPABASE_DEFAULT.url, key: SUPABASE_DEFAULT.key };
  try {
    const c = localStorage.getItem('pm_sb_cfg2');
    return c ? JSON.parse(c) : null;
  } catch (e) { return null; }
}

// Kunci service_role / secret memberi akses penuh ke database dan TIDAK boleh ada di browser.
function kunciTerlarang(key) {
  if (/^sb_secret_/.test(key)) return true;
  try {
    const part = String(key).split('.')[1];
    if (!part) return false;
    const json = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));
    return json.role === 'service_role';
  } catch (e) { return false; }
}

function saveSbConfig(url, key) {
  localStorage.setItem('pm_sb_cfg2', JSON.stringify({ url, key }));
}

let _lastInitError = null;

function initSupabase(url, key) {
  _lastInitError = null;
  if (typeof window.supabase === 'undefined' || !window.supabase.createClient) {
    _lastInitError = 'Library Supabase (window.supabase) belum termuat. Coba refresh halaman.';
    console.error('initSupabase:', _lastInitError);
    return false;
  }
  if (kunciTerlarang(key)) {
    _lastInitError = 'Kunci ini adalah service_role/secret dan berbahaya dipakai di browser. Gunakan kunci anon/publishable.';
    console.error('initSupabase:', _lastInitError);
    return false;
  }
  try {
    sbClient = window.supabase.createClient(url, key, {
      auth: { persistSession: true, autoRefreshToken: true }
    });
    return true;
  } catch (e) {
    _lastInitError = e.message || String(e);
    console.error('initSupabase:', e);
    return false;
  }
}

// ================================================================
//  TOAST NOTIFICATION UI
//  Menggantikan alert() untuk semua feedback ke pengguna
// ================================================================

function showToast(title, msg, ico = 'ℹ️', duration = 4500) {
  const wrap = document.getElementById('toast-wrap');
  if (!wrap) return;

  const t = document.createElement('div');
  t.className = 'toast';
  t.innerHTML = `
    <span class="toast-ico">${ico}</span>
    <div class="toast-body">
      <div class="toast-title">${esc(title)}</div>
      ${msg ? `<div class="toast-msg">${esc(msg)}</div>` : ''}
    </div>
    <button class="toast-close" onclick="this.parentElement.remove()">×</button>`;
  wrap.appendChild(t);

  if (duration > 0) {
    setTimeout(() => {
      t.classList.add('toast-out');
      setTimeout(() => t.remove(), 300);
    }, duration);
  }
}

// ================================================================
//  BROWSER NOTIFICATIONS
//  Dipakai untuk memberi tahu owner/admin saat ada kuitansi baru
//  dari device lain melalui Supabase Realtime.
// ================================================================

async function requestNotifPermission() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'granted') {
    _notifEnabled = true;
    return;
  }
  if (Notification.permission !== 'denied') {
    const result = await Notification.requestPermission();
    _notifEnabled = (result === 'granted');
  }
}

function toggleNotif() {
  if (!('Notification' in window)) {
    showToast('Tidak Didukung', 'Browser ini tidak mendukung notifikasi.', '⚠️');
    return;
  }
  if (Notification.permission === 'denied') {
    showToast('Notifikasi Diblokir', 'Aktifkan notifikasi di pengaturan browser Anda.', '🔕');
    return;
  }
  requestNotifPermission().then(() => {
    if (_notifEnabled) {
      showToast('Notifikasi Aktif', 'Anda akan diberitahu saat ada kuitansi baru dari device lain.', '🔔');
    } else {
      showToast('Notifikasi Dinonaktifkan', 'Izin notifikasi belum diberikan.', '🔕');
    }
  });
}

function sendBrowserNotif(title, body) {
  if (!_notifEnabled || Notification.permission !== 'granted') return;
  try {
    // Ikon sederhana sebagai data URI
    const iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
      <rect width="32" height="32" rx="8" fill="#3b82f6"/>
      <text y="22" x="5" font-size="18">🧾</text></svg>`;
    const icon = 'data:image/svg+xml,' + encodeURIComponent(iconSvg);
    const n = new Notification(title, { body, icon });
    setTimeout(() => n.close(), 7000);
  } catch (e) {
    console.warn('Browser notif error:', e);
  }
}

function incNotifBadge() {
  _notifCount++;
  const badge = document.getElementById('notif-badge');
  if (badge) {
    badge.style.display = 'flex';
    badge.textContent = _notifCount > 9 ? '9+' : String(_notifCount);
  }
}

// ================================================================
//  SYNC BADGE
//  Status koneksi di topbar: idle / saving / ok / err / loading
// ================================================================

function setSyncBadge(state, msg) {
  const el = document.getElementById('sync-badge');
  if (!el) return;

  const icons = { idle: '☁️', saving: '🔄', ok: '✅', err: '❌', loading: '🔄' };
  el.className = 'sync-badge sync-' + state;
  el.textContent = (icons[state] || '☁️') + ' ' + msg;

  // Auto-reset ke idle setelah 2.5 detik
  if (state === 'ok') {
    clearTimeout(_syncTimer);
    _syncTimer = setTimeout(() => setSyncBadge('idle', 'Supabase'), 2500);
  }
}

// ================================================================
//  DATABASE — LOAD (ambil semua data sekaligus)
// ================================================================

async function dbLoad() {
  setSyncBadge('loading', 'Memuat...');
  try {
    // Jalankan 5 query secara paralel
    const [r1, r2, r3, r4, r5] = await Promise.all([
      sbClient.from('pm_kuitansi').select('*').order('id', { ascending: true }),
      sbClient.from('pm_modal').select('*').order('id', { ascending: true }),
      sbClient.from('pm_pl_manual').select('*').order('id', { ascending: true }),
      sbClient.from('pm_logs').select('*').order('ts', { ascending: false }).limit(500),
      sbClient.from('pm_item_templates').select('*').order('name', { ascending: true })
    ]);

    // Cek error per query
    if (r1.error) throw r1.error;
    if (r2.error) throw r2.error;
    if (r3.error) throw r3.error;
    if (r4.error) throw r4.error;
    if (r5.error) throw r5.error;

    // Simpan ke cache lokal dengan mapping field DB → field app
    _cache.kuitansi  = (r1.data || []).map(mapKwt);
    _cache.modal     = (r2.data || []).map(mapModal);
    _cache.plManual  = (r3.data || []).map(mapPL);
    _cache.logs      = (r4.data || []).map(mapLog);
    _cache.templates = (r5.data || []);

    setSyncBadge('ok', 'Tersinkron');
  } catch (e) {
    console.error('dbLoad error:', e);
    setSyncBadge('err', 'Gagal: ' + (e.message || 'error'));
    showToast('Gagal Memuat Data', e.message, '❌');
  }
}

// Mapping field dari format kolom DB → format objek di app
function mapKwt(r) {
  return {
    id: r.id, timestamp: r.timestamp, createdBy: r.created_by, userId: r.user_id,
    tipe: r.tipe, namapt: r.namapt, kontakpt: r.kontakpt, alamatpt: r.alamatpt,
    no: r.no, tgl: r.tgl, status: r.status, pelanggan: r.pelanggan,
    alamatpl: r.alamatpl, catatan: r.catatan, items: r.items || [],
    diskon: r.diskon || 0, total: r.total || 0
  };
}
function mapModal(r) {
  return {
    id: r.id, timestamp: r.timestamp, createdBy: r.created_by, userId: r.user_id,
    jenis: r.jenis, nama: r.nama, jumlah: r.jumlah || 0, ket: r.ket || '', tgl: r.tgl
  };
}
function mapPL(r) {
  return {
    id: r.id, type: r.type, amount: r.amount || 0,
    desc: r.keterangan, tgl: r.tgl, createdBy: r.created_by
  };
}
function mapLog(r) {
  return {
    id: r.id, ts: r.ts, user: r.username, role: r.role,
    category: r.category, action: r.action, detail: r.detail
  };
}

// ================================================================
//  DATABASE — WRITE HELPERS
//  Semua fungsi tulis ke Supabase ada di sini.
//  Parameter upsert=true dipakai saat restore backup.
// ================================================================

// Pembentuk baris DB dari objek app (dipakai insert biasa & restore massal)
function kwtRow(k) {
  return {
    id: k.id, timestamp: k.timestamp, created_by: k.createdBy,
    ...(k.userId ? { user_id: k.userId } : {}),
    tipe: k.tipe, namapt: k.namapt, kontakpt: k.kontakpt, alamatpt: k.alamatpt,
    no: k.no, tgl: k.tgl, status: k.status, pelanggan: k.pelanggan,
    alamatpl: k.alamatpl, catatan: k.catatan, items: k.items,
    diskon: k.diskon, total: k.total
  };
}
function modalRow(m) {
  return {
    id: m.id, timestamp: m.timestamp, created_by: m.createdBy,
    ...(m.userId ? { user_id: m.userId } : {}),
    jenis: m.jenis, nama: m.nama, jumlah: m.jumlah, ket: m.ket, tgl: m.tgl
  };
}
function plRow(p) {
  return {
    id: p.id, type: p.type, amount: p.amount,
    keterangan: p.desc, tgl: p.tgl, created_by: p.createdBy,
    ...(p.userId ? { user_id: p.userId } : {})
  };
}

async function dbInsertKwt(k, upsert = false) {
  const row = kwtRow(k);
  const op = upsert
    ? sbClient.from('pm_kuitansi').upsert(row, { onConflict: 'id', ignoreDuplicates: true })
    : sbClient.from('pm_kuitansi').insert(row);
  const { error } = await op;
  if (error) throw error;
  // Tambahkan ke cache lokal supaya UI langsung update tanpa reload
  if (!_cache.kuitansi.find(x => x.id === k.id)) _cache.kuitansi.push(k);
}

async function dbDeleteKwt(id) {
  const { error } = await sbClient.from('pm_kuitansi').delete().eq('id', id);
  if (error) throw error;
  _cache.kuitansi = _cache.kuitansi.filter(x => x.id !== id);
}

async function dbInsertModal(m, upsert = false) {
  const row = modalRow(m);
  const op = upsert
    ? sbClient.from('pm_modal').upsert(row, { onConflict: 'id', ignoreDuplicates: true })
    : sbClient.from('pm_modal').insert(row);
  const { error } = await op;
  if (error) throw error;
  if (!_cache.modal.find(x => x.id === m.id)) _cache.modal.push(m);
}

async function dbDeleteModal(id) {
  const { error } = await sbClient.from('pm_modal').delete().eq('id', id);
  if (error) throw error;
  _cache.modal = _cache.modal.filter(x => x.id !== id);
}

async function dbInsertPL(p, upsert = false) {
  const row = plRow(p);
  const op = upsert
    ? sbClient.from('pm_pl_manual').upsert(row, { onConflict: 'id', ignoreDuplicates: true })
    : sbClient.from('pm_pl_manual').insert(row);
  const { error } = await op;
  if (error) throw error;
  if (!_cache.plManual.find(x => x.id === p.id)) _cache.plManual.push(p);
}

async function dbDeletePL(id) {
  const { error } = await sbClient.from('pm_pl_manual').delete().eq('id', id);
  if (error) throw error;
  _cache.plManual = _cache.plManual.filter(x => x.id !== id);
}

async function dbInsertLog(l) {
  const { error } = await sbClient.from('pm_logs').insert({
    id: l.id, ts: l.ts, username: l.user, role: l.role,
    user_id: l.userId, category: l.category, action: l.action, detail: l.detail
  });
  if (error) {
    console.warn('Log insert (non-critical):', error.message);
  } else {
    _cache.logs.unshift(l);
    if (_cache.logs.length > 500) _cache.logs = _cache.logs.slice(0, 500);
  }
}

async function dbInsertTemplate(t) {
  const { data, error } = await sbClient
    .from('pm_item_templates')
    .insert({ name: t.name, default_price: t.default_price, unit: t.unit, created_by: CU.name })
    .select()
    .single();
  if (error) throw error;
  _cache.templates.push(data);
  _cache.templates.sort((a, b) => a.name.localeCompare(b.name));
  return data;
}

async function dbDeleteTemplate(id) {
  const { error } = await sbClient.from('pm_item_templates').delete().eq('id', id);
  if (error) throw error;
  _cache.templates = _cache.templates.filter(x => x.id !== id);
}

// ================================================================
//  LOG AKTIVITAS
// ================================================================

async function addLog(category, action, detail) {
  const l = {
    id:       String(Date.now()) + String(Math.random()).slice(2, 6),
    ts:       new Date().toISOString(),
    user:     CU ? CU.name : 'System',
    role:     CU ? CU.role : '-',
    userId:   CU ? CU.uid : null,
    category, action, detail
  };
  await dbInsertLog(l);
}

// Warna dot dan ikon untuk setiap tipe log
function ldClass(cat, act) {
  if (act === 'login')   return 'ld-login';
  if (act === 'logout')  return 'ld-logout';
  if (act === 'hapus')   return 'ld-hapus';
  if (cat === 'modal')   return 'ld-modal';
  if (cat === 'pl')      return 'ld-pl';
  return 'ld-masuk';
}
function actIco(cat, act) {
  if (act === 'login')     return '🔑';
  if (act === 'logout')    return '🚪';
  if (act === 'hapus')     return '🗑️';
  if (act === 'pdf')       return '📄';
  if (cat === 'kuitansi')  return '🧾';
  if (cat === 'modal')     return '💰';
  if (cat === 'pl')        return '📊';
  if (cat === 'template')  return '📝';
  if (cat === 'backup')    return '📦';
  if (cat === 'restore')   return '♻️';
  return '📋';
}

// ================================================================
//  REALTIME — Sinkronisasi otomatis antar device
//  Menggunakan Supabase Realtime (WebSocket).
//  Perubahan dari device LAIN akan trigger reload & notifikasi.
//  Perubahan dari device SENDIRI diabaikan (sudah ada di cache).
// ================================================================

function startRealtime() {
  if (!sbClient || _realtimeCh) return;

  // Debounce: tunggu 1.2 detik sebelum reload,
  // supaya jika ada banyak perubahan sekaligus tidak flood request
  function debouncedReload() {
    clearTimeout(_reloadTimer);
    _reloadTimer = setTimeout(async () => {
      await dbLoad();
      refreshActiveView();
    }, 1200);
  }

  _realtimeCh = sbClient
    .channel('pm_v2_realtime')

    // Event INSERT kuitansi: kirim notifikasi ke user lain
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'pm_kuitansi' }, (payload) => {
      const k = mapKwt(payload.new);
      // Hanya proses jika kuitansi bukan dari device kita sendiri
      if (k.userId !== CU?.uid) {
        debouncedReload();
        const msg = `${k.no} untuk ${k.pelanggan} — ${fmt(k.total)}`;
        sendBrowserNotif('🧾 Kuitansi Baru Masuk', msg);
        showToast('Kuitansi Baru', msg, '🧾');
        incNotifBadge();
      }
    })

    // DELETE kuitansi, semua perubahan modal, P&L, template
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'pm_kuitansi' },     () => debouncedReload())
    .on('postgres_changes', { event: '*',      schema: 'public', table: 'pm_modal' },         () => debouncedReload())
    .on('postgres_changes', { event: '*',      schema: 'public', table: 'pm_pl_manual' },     () => debouncedReload())
    .on('postgres_changes', { event: '*',      schema: 'public', table: 'pm_item_templates' },() => debouncedReload())

    .subscribe(status => {
      if (status === 'SUBSCRIBED') {
        console.log('[Realtime] Terhubung — perubahan antar device akan sync otomatis.');
      }
    });
}

function stopRealtime() {
  if (_realtimeCh) {
    sbClient.removeChannel(_realtimeCh);
    _realtimeCh = null;
    console.log('[Realtime] Channel ditutup.');
  }
}

// Refresh tampilan halaman yang sedang aktif
function refreshActiveView() {
  renderDashboard();
  const pg = document.querySelector('.page.on');
  if (!pg) return;
  const id = pg.id.replace('page-', '');
  if (id === 'modal')    renderModal();
  if (id === 'riwayat')  renderRiwayat();
  if (id === 'pl')       updatePL();
  if (id === 'log')      renderLog();
  if (id === 'template') renderTemplates();
  if (id === 'backup')   { renderBackupInfo(); renderSbConnStatus(); }
}

// Refresh manual via tombol 🔄 di topbar
async function manualRefresh() {
  const btn = document.getElementById('refresh-btn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
  clearTimeout(_reloadTimer);
  await dbLoad();
  refreshActiveView();
  if (btn) { btn.disabled = false; btn.textContent = '🔄'; }
}

// ================================================================
//  HELPER FUNCTIONS
// ================================================================

// Format angka ke Rupiah
function fmt(n) {
  return 'Rp ' + Math.round(n || 0).toLocaleString('id-ID');
}

// Tanggal HARI INI menurut jam perangkat (YYYY-MM-DD).
// Jangan pakai toISOString(): itu UTC, sehingga sebelum 07.00 WIB tanggalnya mundur sehari.
function todayISO() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// Format tanggal YYYY-MM-DD → DD-MM-YYYY
// Kota untuk baris tanda tangan: bagian TERAKHIR alamat ("..., Cimenyan II, Banjar" → "Banjar")
function kotaDariAlamat(alamat) {
  const parts = String(alamat || '').split(',').map(x => x.trim()).filter(Boolean);
  if (parts.length >= 2) return parts[parts.length - 1];
  return parts.length === 1 && parts[0].length <= 25 ? parts[0] : '';
}

function fmtTgl(s) {
  if (!s) return '-';
  const d = new Date(s + 'T00:00:00');
  return String(d.getDate()).padStart(2, '0') + '-' +
         String(d.getMonth() + 1).padStart(2, '0') + '-' +
         d.getFullYear();
}

// Format datetime ISO → tampilan Indonesia
function fmtDT(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' }) +
         ' ' + d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// Timestamp untuk nama file backup
function nowStamp() {
  const d = new Date();
  return d.getFullYear() +
    String(d.getMonth() + 1).padStart(2, '0') +
    String(d.getDate()).padStart(2, '0') + '_' +
    String(d.getHours()).padStart(2, '0') +
    String(d.getMinutes()).padStart(2, '0');
}

// Download file JSON
function dlJSON(data, fname) {
  const b = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const u = URL.createObjectURL(b);
  const a = document.createElement('a');
  a.href = u; a.download = fname; a.click();
  URL.revokeObjectURL(u);
}

// Download file teks (untuk CSV)
function dlText(text, fname) {
  const b = new Blob([text], { type: 'text/plain' });
  const u = URL.createObjectURL(b);
  const a = document.createElement('a');
  a.href = u; a.download = fname; a.click();
  URL.revokeObjectURL(u);
}

// Escape HTML untuk mencegah XSS
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Detail log boleh memuat <strong> (dibuat aplikasi); semua tag lain di-escape.
// Dipakai saat TAMPIL, sehingga data log lama yang belum bersih pun aman.
function safeLogHtml(s) {
  return esc(s).replace(/&lt;strong&gt;/g, '<strong>').replace(/&lt;\/strong&gt;/g, '</strong>');
}

// ================================================================
//  SETUP WIZARD — 3 Langkah
//  1. Masukkan URL + Anon Key → test koneksi
//  2. Jalankan SQL di Supabase → verifikasi tabel ada
//  3. Buat akun pengguna di Supabase Auth (sekali saja)
// ================================================================

function showSetup() {
  hideLoading();
  document.getElementById('setup-wrap').style.display = 'flex';
  document.getElementById('login-wrap').style.display = 'none';
  document.getElementById('app').classList.remove('on');
  document.getElementById('sql-code').textContent = SQL_SCHEMA;
  const cfg = getSbConfig();
  if (cfg) {
    document.getElementById('sb-url').value = cfg.url || '';
    document.getElementById('sb-key').value = cfg.key || '';
  }
  goSetupStep1();
}

function goSetupStep1() {
  document.getElementById('setup-step1').style.display = '';
  document.getElementById('setup-step2').style.display = 'none';
  document.getElementById('setup-step3').style.display = 'none';
  document.getElementById('sdot-1').className = 'step-dot active';
  document.getElementById('sdot-2').className = 'step-dot';
}

async function setupStep1() {
  const url    = document.getElementById('sb-url').value.trim();
  const key    = document.getElementById('sb-key').value.trim();
  const errEl  = document.getElementById('setup-err');
  const btn    = document.getElementById('setup-btn1');

  errEl.style.display = 'none';
  if (!url || !key) {
    errEl.textContent = 'URL dan Anon Key tidak boleh kosong.';
    errEl.style.display = 'block'; return;
  }
  if (!url.startsWith('https://')) {
    errEl.textContent = 'URL harus diawali https://';
    errEl.style.display = 'block'; return;
  }

  btn.disabled = true; btn.textContent = '⏳ Memeriksa koneksi...';

  // Pengaman tambahan: pastikan library Supabase sudah benar-benar ter-load
  if (typeof window.supabase === 'undefined' || !window.supabase.createClient) {
    errEl.textContent = 'Library Supabase belum selesai dimuat dari CDN. Tunggu beberapa detik lalu coba lagi, atau refresh halaman.';
    errEl.style.display = 'block';
    btn.disabled = false; btn.textContent = 'Lanjut → Verifikasi';
    return;
  }

  if (!initSupabase(url, key)) {
    errEl.textContent = 'Gagal inisialisasi Supabase Client: ' + (_lastInitError || 'penyebab tidak diketahui') + '.';
    errEl.style.display = 'block';
    btn.disabled = false; btn.textContent = 'Lanjut → Verifikasi';
    return;
  }

  // Timeout pengaman: jika request menggantung > 10 detik, beri tahu pengguna
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    errEl.textContent = 'Koneksi timeout (>10 detik). Periksa URL/Key, atau coba refresh halaman.';
    errEl.style.display = 'block';
    btn.disabled = false; btn.textContent = 'Lanjut → Verifikasi';
  }, 10000);

  try {
    console.log('[Setup] Mencoba koneksi ke:', url);
    const { error } = await sbClient.from('pm_kuitansi').select('id').limit(1);
    clearTimeout(timeoutId);
    if (timedOut) return; // Sudah ditangani oleh timeout

    console.log('[Setup] Response error:', error);
    saveSbConfig(url, key);

    if (error && error.code === '42P01') {
      // Tabel belum ada → tampilkan langkah 2 (SQL)
      document.getElementById('setup-step1').style.display = 'none';
      document.getElementById('setup-step2').style.display = '';
      document.getElementById('sdot-1').className = 'step-dot done';
      document.getElementById('sdot-2').className = 'step-dot active';
    } else if (error) {
      throw error;
    } else {
      // Koneksi OK & tabel sudah ada → langsung ke login
      document.getElementById('setup-wrap').style.display = 'none';
      document.getElementById('login-wrap').style.display = 'flex';
    }
  } catch (e) {
    clearTimeout(timeoutId);
    if (timedOut) return;
    console.error('[Setup] Error:', e);

    if (e && (e.code === '42P01' || (e.message && e.message.includes('does not exist')))) {
      saveSbConfig(url, key);
      document.getElementById('setup-step1').style.display = 'none';
      document.getElementById('setup-step2').style.display = '';
      document.getElementById('sdot-1').className = 'step-dot done';
      document.getElementById('sdot-2').className = 'step-dot active';
    } else {
      // Tangani berbagai jenis error secara spesifik agar pesan jelas
      let msg = 'Koneksi gagal: ';
      if (e instanceof TypeError && e.message.includes('fetch')) {
        msg += 'Tidak bisa menghubungi server. Cek URL Supabase atau koneksi internet Anda.';
      } else if (e.message) {
        msg += e.message;
      } else {
        msg += JSON.stringify(e);
      }
      errEl.textContent = msg;
      errEl.style.display = 'block';
    }
  }

  if (!timedOut) {
    btn.disabled = false; btn.textContent = 'Lanjut → Verifikasi';
  }
}

function copySql() {
  navigator.clipboard.writeText(SQL_SCHEMA)
    .catch(() => {})
    .finally(() => showToast('SQL Disalin', 'Paste di Supabase SQL Editor → Run.', '📋'));
}

async function setupVerify() {
  const errEl = document.getElementById('setup-err2');
  const btn   = document.getElementById('setup-btn2');
  errEl.style.display = 'none';
  btn.disabled = true; btn.textContent = '⏳ Verifikasi...';

  try {
    const { error } = await sbClient.from('pm_kuitansi').select('id').limit(1);
    if (error) throw error;

    // Tabel OK → langkah 3 (buat akun Auth)
    document.getElementById('setup-step2').style.display = 'none';
    document.getElementById('setup-step3').style.display = '';
    renderCreateUsersList();
  } catch (e) {
    errEl.textContent = 'Tabel belum ditemukan. Pastikan SQL sudah dijalankan. (' + (e.message || '') + ')';
    errEl.style.display = 'block';
  }

  btn.disabled = false; btn.textContent = '✅ Verifikasi & Lanjut';
}

function renderCreateUsersList() {
  const el = document.getElementById('create-users-list');
  el.innerHTML = Object.entries(USERS).map(([k, u]) => `
    <div style="display:flex;align-items:center;justify-content:space-between;
      padding:10px 0;border-bottom:1px solid var(--brd);">
      <div style="font-size:13px;font-weight:600;color:var(--ink);">
        ${esc(u.name)} <span style="font-size:10px;color:var(--ink3);">(${esc(u.role)})</span>
      </div>
      <code style="font-size:11px;background:var(--surf3);padding:2px 6px;border-radius:4px;color:var(--cyan);">${esc(u.email)}</code>
    </div>`).join('');
}

function skipUserCreation() {
  document.getElementById('setup-wrap').style.display = 'none';
  document.getElementById('login-wrap').style.display = 'flex';
}

// ================================================================
//  LOGIN / LOGOUT — Supabase Auth
//  Hanya via Supabase Auth (tidak ada fallback password lokal)
// ================================================================

function pickUser(k) {
  if (!USERS[k]) return;
  selKey = k;
  document.querySelectorAll('.ucard').forEach(c => c.classList.remove('sel'));
  const card = document.getElementById('uc-' + k);
  if (card) {
    card.classList.add('sel');
    if (USERS[k].role === 'owner') card.classList.add('owner');
  }
  document.getElementById('lpass').value = '';
  document.getElementById('lpass').focus();
  document.getElementById('lerr').style.display = 'none';
}

// Bentuk objek pengguna aktif. Peran SELALU dari app_metadata di token login
// (pengguna tidak bisa mengubahnya). Tanpa peran valid → null (tidak boleh masuk).
function buildCU(key, authUser) {
  const ud   = USERS[key];
  const role = authUser && authUser.app_metadata && authUser.app_metadata.role;
  if (!ud || (role !== 'owner' && role !== 'admin')) return null;
  return { ...ud, key, uid: authUser.id, role };
}

function applyUserUI(u) {
  hideLoading();
  document.getElementById('login-wrap').style.display = 'none';
  document.getElementById('app').classList.add('on');

  // Sidebar user info
  const pip = document.getElementById('tb-pip');
  if (pip) { pip.textContent = u.initials; pip.className = 'sb-user-pip ' + u.pipClass; }
  const nameEl = document.getElementById('tb-name');
  const roleEl = document.getElementById('tb-role');
  if (nameEl) nameEl.textContent = u.name;
  if (roleEl) roleEl.textContent = u.role === 'owner' ? 'Owner' : 'Administrator';

  // Tampilkan menu khusus owner
  if (u.role === 'owner') {
    document.querySelectorAll('.owner-only').forEach(e => {
      // button → flex, div (section label) → block
      e.style.display = e.tagName === 'BUTTON' ? 'flex' : 'block';
    });
  }

  // Terapkan preferensi sidebar & tema
  applysidebar();
  applyTheme();

  // Mulai tracking aktivitas untuk auto-logout 2 jam
  startActivityTracking();

  autoNo();
}

async function doLogin() {
  const errEl = document.getElementById('lerr');
  errEl.style.display = 'none';

  if (!selKey) {
    errEl.textContent = 'Pilih akun terlebih dahulu.';
    errEl.style.display = 'block'; return;
  }
  const pass = document.getElementById('lpass').value;
  if (!pass) {
    errEl.textContent = 'Masukkan password.';
    errEl.style.display = 'block'; return;
  }

  const ud  = USERS[selKey];
  const btn = document.getElementById('login-btn');
  btn.disabled = true; btn.textContent = '⏳ Masuk...';

  try {
    const { data, error } = await sbClient.auth.signInWithPassword({
      email: ud.email,
      password: pass
    });
    if (error) throw error;

    // Peran diambil dari token (app_metadata), bukan dari kode di browser
    const user = buildCU(selKey, data.user);
    if (!user) {
      try { await sbClient.auth.signOut(); } catch (_) {}
      errEl.textContent = 'Akun ini belum diberi peran (admin/owner). Jalankan sql/001_amankan_role.sql di Supabase, lalu coba lagi.';
      errEl.style.display = 'block';
    } else {
      CU = user;
      applyUserUI(CU);
      await dbLoad();
      renderDashboard();
      startRealtime();
      requestNotifPermission();
      addLog('login', 'login', `masuk sebagai ${CU.name} (${CU.role})`);
    }
  } catch (e) {
    errEl.textContent = 'Login gagal: email/password salah atau akun belum dibuat di Supabase.';
    errEl.style.display = 'block';
  }

  btn.disabled = false; btn.textContent = 'Masuk →';
}

async function doLogout() {
  await addLog('logout', 'logout', 'keluar dari sistem');
  stopRealtime();
  try { await sbClient.auth.signOut(); } catch (e) {}

  CU = null; selKey = null;
  clearSession();
  stopActivityTracking();

  document.getElementById('app').classList.remove('on');
  document.getElementById('login-wrap').style.display = 'flex';
  document.getElementById('lpass').value = '';
  document.querySelectorAll('.ucard').forEach(c => c.classList.remove('sel'));
  document.getElementById('lerr').style.display = 'none';
  document.querySelectorAll('.owner-only').forEach(e => e.style.display = 'none');
  document.querySelectorAll('.page').forEach(p => p.classList.remove('on'));
  document.getElementById('page-dashboard').classList.add('on');
  // Reset active sidebar btn
  document.querySelectorAll('.sb-nav-btn').forEach(b => b.classList.remove('act'));
  const dashBtn = document.getElementById('nav-dashboard');
  if (dashBtn) dashBtn.classList.add('act');

  // Reset notif badge
  _notifCount = 0;
  const nb = document.getElementById('notif-badge');
  if (nb) nb.style.display = 'none';
}

// ================================================================
//  NAVIGASI HALAMAN
// ================================================================

// goPage sudah di-override



// ================================================================
//  1. SIDEBAR TOGGLE
// ================================================================
let _sidebarCollapsed = localStorage.getItem('pm_sidebar_col') === '1';

function toggleSidebar() {
  _sidebarCollapsed = !_sidebarCollapsed;
  localStorage.setItem('pm_sidebar_col', _sidebarCollapsed ? '1' : '0');
  applysidebar();
}

function applysidebar() {
  const sb = document.getElementById('sidebar');
  if (!sb) return;
  if (_sidebarCollapsed) sb.classList.add('collapsed');
  else sb.classList.remove('collapsed');
}

// ================================================================
//  2. TEMA TERANG / GELAP
// ================================================================
let _theme = localStorage.getItem('pm_theme') || 'dark';

function applyTheme() {
  if (_theme === 'light') {
    document.documentElement.classList.add('light');
  } else {
    document.documentElement.classList.remove('light');
  }
  const ico = document.getElementById('theme-ico');
  if (ico) ico.textContent = _theme === 'light' ? '☀️' : '🌙';
}

function toggleTheme() {
  _theme = _theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('pm_theme', _theme);
  applyTheme();
  showToast(_theme === 'light' ? 'Tema Terang' : 'Tema Gelap',
    'Tampilan berhasil diubah.', _theme === 'light' ? '☀️' : '🌙', 2000);
}

// ================================================================
//  3. NAVIGASI SIDEBAR — override goPage() untuk update judul & active
// ================================================================
const PAGE_TITLES = {
  dashboard: 'Dashboard',
  kuitansi:  'Buat Kuitansi',
  modal:     'Catat Modal',
  pl:        'Untung & Rugi',
  riwayat:   'Riwayat Kuitansi',
  log:       'Log Aktivitas',
  template:  'Template Item',
  backup:    'Backup & Restore'
};

const PAGES = ['dashboard','kuitansi','modal','pl','riwayat','log','template','backup'];

function goPage(id) {
  // Sembunyikan semua halaman
  document.querySelectorAll('.page').forEach(p => p.classList.remove('on'));

  // Aktifkan halaman yang dipilih
  const pg = document.getElementById('page-' + id);
  if (pg) pg.classList.add('on');

  // Update active state di sidebar
  document.querySelectorAll('.sb-nav-btn').forEach(b => b.classList.remove('act'));
  const activeBtn = document.getElementById('nav-' + id);
  if (activeBtn) activeBtn.classList.add('act');

  // Update judul topbar
  const titleEl = document.getElementById('page-title');
  if (titleEl) titleEl.textContent = PAGE_TITLES[id] || id;

  // Render data sesuai halaman
  if (id === 'dashboard')  renderDashboard();
  if (id === 'modal')      renderModal();
  if (id === 'riwayat')    renderRiwayat();
  if (id === 'pl')         { initPLYearSelect(); updatePL(); }
  if (id === 'log')        renderLog();
  if (id === 'template')   renderTemplates();
  if (id === 'backup')     { renderBackupInfo(); renderSbConnStatus(); }

  // Di mobile: tutup sidebar otomatis
  if (window.innerWidth < 768 && !_sidebarCollapsed) {
    _sidebarCollapsed = true;
    applysidebar();
  }
}

// ================================================================
//  4. SESSION PERSIST — jangan logout saat refresh
//     Simpan sesi ke localStorage, restore saat halaman dibuka
// ================================================================
function clearSession() {
  localStorage.removeItem('pm_session_v2');
}

// ================================================================
//  5. AUTO-LOGOUT setelah 2 jam tidak digunakan
//     - Progress bar di bawah halaman menghitung mundur
//     - Warning muncul 60 detik sebelum logout
// ================================================================
const AUTO_LOGOUT_MS  = 2 * 60 * 60 * 1000;  // 2 jam
const WARN_BEFORE_MS  = 60 * 1000;             // peringatkan 60 detik sebelum
let _lastActivity     = Date.now();
let _autoLogoutTimer  = null;
let _warnTimer        = null;
let _barTimer         = null;

function resetActivity() {
  const now  = Date.now();
  const warn = document.getElementById('autologout-warn');
  const warnShown = warn && warn.style.display === 'block';
  // Batasi: mousemove/scroll muncul puluhan kali per detik, cukup proses tiap 5 detik
  if (!warnShown && now - _lastActivity < 5000) return;
  _lastActivity = now;
  scheduleAutoLogout();
  if (warn) warn.style.display = 'none';
}

function scheduleAutoLogout() {
  clearTimeout(_autoLogoutTimer);
  clearTimeout(_warnTimer);
  clearInterval(_barTimer);

  // Warning 60 detik sebelum logout
  _warnTimer = setTimeout(() => {
    const warn = document.getElementById('autologout-warn');
    if (warn) warn.style.display = 'block';

    // Hitung mundur di warning
    let sec = 60;
    const cdEl = document.getElementById('autologout-countdown');
    _barTimer = setInterval(() => {
      sec--;
      if (cdEl) cdEl.textContent = sec;
      updateLogoutBar(sec / 60);
      if (sec <= 0) clearInterval(_barTimer);
    }, 1000);
  }, AUTO_LOGOUT_MS - WARN_BEFORE_MS);

  // Logout
  _autoLogoutTimer = setTimeout(() => {
    showToast('Sesi Berakhir', 'Anda otomatis logout karena tidak aktif selama 2 jam.', '⏰', 0);
    setTimeout(() => doLogout(), 1500);
  }, AUTO_LOGOUT_MS);

  // Reset progress bar
  updateLogoutBar(1);
}

function updateLogoutBar(fraction) {
  const fill = document.getElementById('autologout-fill');
  if (fill) fill.style.width = Math.max(0, fraction * 100) + '%';
}

function stopAutoLogout() {
  clearTimeout(_autoLogoutTimer);
  clearTimeout(_warnTimer);
  clearInterval(_barTimer);
  _autoLogoutTimer = null;
}

function startActivityTracking() {
  ['click','keydown','mousemove','touchstart','scroll'].forEach(evt => {
    document.addEventListener(evt, resetActivity, { passive: true });
  });
  scheduleAutoLogout();
}

function stopActivityTracking() {
  ['click','keydown','mousemove','touchstart','scroll'].forEach(evt => {
    document.removeEventListener(evt, resetActivity);
  });
  stopAutoLogout();
}



// ================================================================
//  TEMPLATE ITEM — Kelola daftar produk/layanan percetakan
//  Hanya Owner yang bisa tambah/hapus template.
//  Template muncul sebagai autocomplete di form kuitansi.
// ================================================================

async function simpanTemplate() {
  if (CU.role !== 'owner') { showToast('Akses Ditolak', 'Hanya owner yang dapat mengelola template.', '🔒'); return; }

  const name  = document.getElementById('tmpl-name').value.trim();
  const price = parseFloat(document.getElementById('tmpl-price').value) || 0;
  const unit  = document.getElementById('tmpl-unit').value.trim() || 'pcs';

  if (!name) { showToast('Validasi', 'Nama item tidak boleh kosong.', '⚠️'); return; }

  const btn = document.getElementById('btn-simpan-tmpl');
  btn.disabled = true; btn.textContent = 'Menyimpan...';
  setSyncBadge('saving', 'Menyimpan...');

  try {
    await dbInsertTemplate({ name, default_price: price, unit });
    await addLog('template', 'masuk', `menambah template: <strong>${name}</strong> (${fmt(price)}/${unit})`);
    setSyncBadge('ok', 'Tersimpan');

    document.getElementById('tmpl-name').value  = '';
    document.getElementById('tmpl-price').value = '';
    renderTemplates();
    showToast('Template Ditambahkan', `${name} — ${fmt(price)} / ${unit}`, '📝');
  } catch (e) {
    setSyncBadge('err', 'Gagal');
    showToast('Gagal Menyimpan', e.message, '❌');
  }

  btn.disabled = false; btn.textContent = '+ Tambah Template';
}

function renderTemplates() {
  const el = document.getElementById('tmpl-list');
  if (!el) return;
  const isOwner = CU && CU.role === 'owner';

  if (!_cache.templates.length) {
    el.innerHTML = '<div class="empty">Belum ada template. Tambah template di form di atas.</div>';
    return;
  }

  el.innerHTML = `<div class="tmpl-grid">` +
    _cache.templates.map(t => `
      <div class="tmpl-card">
        <div>
          <div class="tmpl-name">${esc(t.name)}</div>
          <div class="tmpl-price">${fmt(t.default_price)} / ${esc(t.unit)}</div>
        </div>
        ${isOwner
          ? `<button class="btn btn-r" style="padding:3px 8px;font-size:11px;"
              onclick="hapusTemplate(${t.id})">✕</button>`
          : ''}
      </div>`).join('') + `</div>`;
}

async function hapusTemplate(id) {
  if (CU.role !== 'owner') return;
  const t = _cache.templates.find(x => x.id === id);
  if (!t || !confirm(`Hapus template "${t.name}"?`)) return;

  setSyncBadge('saving', 'Menghapus...');
  try {
    await dbDeleteTemplate(id);
    await addLog('template', 'hapus', `menghapus template: ${t.name}`);
    setSyncBadge('ok', 'Terhapus');
    renderTemplates();
    showToast('Template Dihapus', t.name, '🗑️');
  } catch (e) {
    setSyncBadge('err', 'Gagal');
    showToast('Gagal Menghapus', e.message, '❌');
  }
}

// ================================================================
//  AUTOCOMPLETE — Dropdown template saat ketik nama item
//  Dipasang per-baris di tabel item kuitansi.
// ================================================================

function setupRowAC(input, rowIdx) {
  // Buat atau reuse elemen dropdown yang sudah ada di cell ini
  let acEl = input.parentElement.querySelector('.autocomplete-list');
  if (!acEl) {
    acEl = document.createElement('div');
    acEl.className = 'autocomplete-list';
    input.parentElement.appendChild(acEl);
  }

  // Tampilkan dropdown saat user mengetik
  input.addEventListener('input', () => {
    const q = input.value.toLowerCase().trim();
    const matches = q.length === 0
      ? _cache.templates
      : _cache.templates.filter(t => t.name.toLowerCase().includes(q));

    if (!matches.length) {
      acEl.classList.remove('open');
      return;
    }

    acEl.innerHTML = matches.slice(0, 8).map(t => `
      <div class="ac-item" data-name="${esc(t.name)}" data-price="${Number(t.default_price) || 0}">
        <span class="ac-name">${esc(t.name)}</span>
        <span class="ac-price">${fmt(t.default_price)} / ${esc(t.unit)}</span>
      </div>`).join('');
    acEl.classList.add('open');
  });

  // Pilih item (delegasi event; nilai dibaca dari data-attribute, bukan dari string inline)
  acEl.onmousedown = (ev) => {
    const it = ev.target.closest('.ac-item');
    if (it) applyAC(rowIdx, it.dataset.name, Number(it.dataset.price) || 0);
  };

  // Tutup dropdown saat input kehilangan fokus
  input.addEventListener('blur', () => {
    setTimeout(() => acEl.classList.remove('open'), 160);
  });

  // Buka lagi jika sudah ada teks saat fokus
  input.addEventListener('focus', () => {
    if (input.value.length > 0) input.dispatchEvent(new Event('input'));
  });
}

// Dipanggil saat user memilih item dari dropdown
function applyAC(rowIdx, name, price) {
  if (rows[rowIdx]) {
    rows[rowIdx].d = name;
    rows[rowIdx].h = price;
    renderRows(); // Re-render agar harga langsung terisi
  }
}

// ================================================================
//  KUITANSI — Form & Tabel Baris Item
// ================================================================

function addRow(d, q, h) {
  rows.push({ id: Date.now() + Math.random(), d: d || '', q: q || '', h: h || '' });
  renderRows();
}

function removeRow(rid) {
  rows = rows.filter(r => r.id !== rid);
  renderRows();
}

function renderRows() {
  const tb = document.getElementById('items-body');
  if (!rows.length) {
    tb.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--ink3);
      padding:14px;font-size:12px;">Klik "+ Tambah Item" untuk menambah baris</td></tr>`;
    recalc();
    return;
  }

  tb.innerHTML = rows.map((r, i) => `
    <tr>
      <td class="td-no">${i + 1}</td>
      <td style="position:relative;">
        <input type="text" value="${esc(r.d)}" id="row-desc-${i}"
          oninput="rows[${i}].d = this.value"
          placeholder="Ketik nama item...">
      </td>
      <td class="td-qty">
        <input type="number" value="${r.q}"
          oninput="rows[${i}].q = this.value; recalc()"
          style="text-align:right;" placeholder="0">
      </td>
      <td class="td-hp">
        <input type="number" value="${r.h}"
          oninput="rows[${i}].h = this.value; recalc()"
          style="text-align:right;" placeholder="0">
      </td>
      <td class="td-sub" id="sub-${i}">Rp 0</td>
      <td class="td-del">
        <button class="del-btn" onclick="removeRow(${r.id})">×</button>
      </td>
    </tr>`).join('');

  // Pasang autocomplete ke setiap input deskripsi
  rows.forEach((r, i) => {
    const inp = document.getElementById('row-desc-' + i);
    if (inp) setupRowAC(inp, i);
  });

  recalc();
}

function recalc() {
  let tot = 0;
  rows.forEach((r, i) => {
    const s = (parseFloat(r.q) || 0) * (parseFloat(r.h) || 0);
    const el = document.getElementById('sub-' + i);
    if (el) el.textContent = fmt(s);
    tot += s;
  });
  const dis = parseFloat(document.getElementById('q-diskon').value) || 0;
  const net = Math.max(0, tot - dis);
  document.getElementById('q-total').textContent = fmt(net);
  return { tot, dis, net };
}

function onTipeChange() {
  const isFiktif = document.getElementById('q-tipe').value === 'fiktif';
  document.getElementById('fiktif-note').style.display = isFiktif ? 'block' : 'none';
}

function autoNo() {
  const now = new Date();
  const mm  = String(now.getMonth() + 1).padStart(2, '0');
  const re  = new RegExp('^KWT-' + mm + '-(\\d+)$');
  // Nomor tertinggi bulan ini + 1 (tidak bentrok walau ada kuitansi yang dihapus)
  let maxN = 0;
  _cache.kuitansi.forEach(k => {
    if (!k.tgl) return;
    const d = new Date(k.tgl + 'T00:00:00');
    if (d.getMonth() !== now.getMonth() || d.getFullYear() !== now.getFullYear()) return;
    const m = re.exec(k.no || '');
    if (m) maxN = Math.max(maxN, parseInt(m[1], 10));
  });
  const el = document.getElementById('q-no');
  if (el) el.value = 'KWT-' + mm + '-' + String(maxN + 1).padStart(3, '0');
}

function resetKuitansi() {
  rows = [];
  renderRows();
  document.getElementById('q-pelanggan').value = '';
  document.getElementById('q-alamatpl').value  = '';
  document.getElementById('q-catatan').value   = 'Barang yang sudah diambil tidak dapat dikembalikan lagi.';
  document.getElementById('q-status').value    = 'LUNAS';
  document.getElementById('q-diskon').value    = 0;
  document.getElementById('q-tipe').value      = 'asli';
  onTipeChange();
  document.getElementById('rc-container').style.display  = 'none';
  document.getElementById('print-acts').style.display    = 'none';
  _lastKwt = null;
  autoNo();
}

function getFormData() {
  const { net, dis } = recalc();
  return {
    tipe:      document.getElementById('q-tipe').value,
    namapt:    document.getElementById('q-namapt').value,
    kontakpt:  document.getElementById('q-kontakpt').value,
    alamatpt:  document.getElementById('q-alamatpt').value,
    no:        document.getElementById('q-no').value,
    tgl:       document.getElementById('q-tgl').value,
    status:    document.getElementById('q-status').value,
    pelanggan: document.getElementById('q-pelanggan').value,
    alamatpl:  document.getElementById('q-alamatpl').value,
    catatan:   document.getElementById('q-catatan').value,
    items:     rows.map(r => ({ d: r.d, q: r.q, h: r.h })),
    diskon:    dis,
    total:     net
  };
}

// ================================================================
//  KUITANSI — Build HTML Receipt (untuk preview & print)
// ================================================================

function buildReceipt(k, inSystem) {
  const isFiktif = k.tipe === 'fiktif';
  const tglStr   = fmtTgl(k.tgl);
  const kota     = kotaDariAlamat(k.alamatpt);

  const rowsHTML = (k.items || []).map((r, i) => {
    const q = parseFloat(r.q) || 0;
    const h = parseFloat(r.h) || 0;
    const s = q * h;
    return `<tr>
      <td>${i + 1}</td>
      <td>${esc(r.d || '')}</td>
      <td class="rnum">${q.toLocaleString('id-ID')}</td>
      <td class="rnum">Rp ${Math.round(h).toLocaleString('id-ID')}</td>
      <td class="rnum">Rp ${Math.round(s).toLocaleString('id-ID')}</td>
    </tr>`;
  }).join('');

  const disRow = k.diskon > 0
    ? `<tr><td colspan="4" style="text-align:right;font-style:italic;color:#555;">Diskon</td>
       <td class="rnum">- Rp ${Math.round(k.diskon).toLocaleString('id-ID')}</td></tr>`
    : '';

  return `<div class="rc-outer"><div class="rc-body">
    <div class="rc-company-name">${esc(k.namapt || '')}${isFiktif && inSystem ? ` <span class="rc-fiktif-sys">FIKTIF</span>` : ''}</div>
    <div class="rc-company-detail">${esc(k.alamatpt || '')}<br>Kontak: ${esc(k.kontakpt || '')}</div>
    <hr class="rc-divider">
    <div class="rc-title-line"><span class="rc-title">KUITANSI PENJUALAN</span></div>
    <div class="rc-two-col">
      <div>
        <div class="rc-sec-title">Pelanggan</div>
        <div class="rc-info-row"><span class="rc-info-label">Nama: </span><strong>${esc(k.pelanggan || '-')}</strong></div>
        <div class="rc-info-row"><span class="rc-info-label">Alamat: </span>${esc(k.alamatpl || '')}</div>
      </div>
      <div>
        <div class="rc-sec-title">Detail</div>
        <div class="rc-info-row"><span class="rc-info-label">No. Kuitansi: </span><strong>${esc(k.no || '-')}</strong></div>
        <div class="rc-info-row"><span class="rc-info-label">Tanggal: </span>${tglStr}</div>
        <div class="rc-info-row"><span class="rc-info-label">Status: </span><strong>${esc(k.status || 'LUNAS')}</strong></div>
      </div>
    </div>
    <div class="rc-sub-title">Rincian Item</div>
    <table class="rc-table">
      <thead><tr>
        <th>No</th><th>Deskripsi</th>
        <th class="rnum">Qty</th><th class="rnum">Harga Satuan</th><th class="rnum">Subtotal</th>
      </tr></thead>
      <tbody>${rowsHTML}${disRow}</tbody>
      <tfoot><tr>
        <td colspan="4" style="text-align:right;">Total</td>
        <td class="rnum">Rp ${Math.round(k.total).toLocaleString('id-ID')}</td>
      </tr></tfoot>
    </table>
    <div class="rc-bottom">
      <div>
        <div class="rc-catatan-title">Catatan</div>
        <div class="rc-catatan-text">${esc(k.catatan || '')}</div>
      </div>
      <div class="rc-ttd">
        <div class="rc-ttd-place">${kota ? esc(kota) + ', ' : ''}${tglStr}</div>
        <div class="rc-ttd-line"></div>
        <div class="rc-ttd-lbl">Penerima</div>
      </div>
    </div>
    <div class="rc-thanks">Terima kasih atas kepercayaan Anda.</div>
  </div></div>`;
}

function previewKuitansi() {
  const k = getFormData();
  _lastKwt = k;
  document.getElementById('rc-container').innerHTML = buildReceipt(k, true);
  document.getElementById('rc-container').style.display = 'block';
  document.getElementById('print-acts').style.display   = 'flex';
  document.getElementById('rc-container').scrollIntoView({ behavior: 'smooth' });
}

async function simpanKuitansi() {
  const k = getFormData();
  if (!k.pelanggan || !k.items.length || k.total === 0) {
    showToast('Validasi', 'Lengkapi nama pelanggan, item, dan harga.', '⚠️');
    return;
  }

  const btn = document.getElementById('btn-simpan-kwt');
  btn.disabled = true; btn.textContent = '💾 Menyimpan...';
  setSyncBadge('saving', 'Menyimpan...');

  try {
    const entry = {
      id: Date.now(),
      timestamp: new Date().toISOString(),
      createdBy: CU.name,
      userId: CU.uid,
      ...k
    };
    await dbInsertKwt(entry);
    await addLog('kuitansi', 'masuk',
      `membuat kuitansi <strong>${k.no}</strong> untuk <strong>${k.pelanggan}</strong> — ${fmt(k.total)} [${k.tipe.toUpperCase()}]`);

    setSyncBadge('ok', 'Tersimpan');
    _lastKwt = entry;
    previewKuitansi();
    showToast('Kuitansi Disimpan', `${k.no} — ${k.pelanggan} | ${fmt(k.total)}`, '🧾');
    updatePL();
    autoNo();
  } catch (e) {
    setSyncBadge('err', 'Gagal');
    if (e && e.code === '23505') {
      // Nomor bentrok (mis. dua device menyimpan bersamaan): muat ulang & beri nomor baru
      await dbLoad();
      autoNo();
      showToast('Nomor Kuitansi Bentrok', 'Nomor sudah dipakai. Nomor baru sudah diisi — klik Simpan lagi.', '⚠️', 7000);
    } else {
      showToast('Gagal Menyimpan', e.message, '❌');
    }
  }

  btn.disabled = false; btn.textContent = '💾 Simpan';
}

// ================================================================
//  EXPORT PDF — Menggunakan jsPDF + jsPDF AutoTable
//  Format A4 portrait, layout 2 kolom untuk info, tabel item.
//  Tidak perlu dialog print browser — langsung download file .pdf
// ================================================================

function exportPDF() {
  const k = _lastKwt || getFormData();
  if (!k.pelanggan && !k.no) {
    showToast('Belum Ada Data', 'Preview atau simpan kuitansi terlebih dahulu.', '⚠️');
    return;
  }

  try {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
    const W   = doc.internal.pageSize.getWidth();
    const ML  = 20;
    const MR  = 20;
    const CW  = W - ML - MR;
    let y     = 20;

    const BLACK = [0, 0, 0];
    const GRAY  = [80, 80, 80];

    // ── NAMA PERCETAKAN
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(14);
    doc.setTextColor(0, 0, 0);
    doc.text(k.namapt || 'PRINTPRO DIGITAL', ML, y);
    y += 6;

    // ── Alamat & Kontak
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(80, 80, 80);
    const aLines = doc.splitTextToSize(k.alamatpt || '', CW * 0.65);
    aLines.forEach(function(l) { doc.text(l, ML, y); y += 4.5; });
    doc.text('Kontak: ' + (k.kontakpt || ''), ML, y);
    y += 7;

    // ── Garis pemisah
    doc.setDrawColor(0, 0, 0);
    doc.setLineWidth(0.5);
    doc.line(ML, y, W - MR, y);
    y += 8;

    // ── JUDUL
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.setTextColor(0, 0, 0);
    var judul = 'KUITANSI PENJUALAN' + (k.tipe === 'fiktif' ? '  [FIKTIF]' : '');
    doc.text(judul, W / 2, y, { align: 'center' });
    y += 10;

    // ── 2 KOLOM INFO
    var C2 = W / 2 + 5;
    var LH = 5.2;
    doc.setFontSize(9);

    // Label Pelanggan
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(0, 0, 0);
    doc.text('Pelanggan', ML, y);
    doc.setLineWidth(0.25);
    doc.line(ML, y + 1, ML + doc.getTextWidth('Pelanggan'), y + 1);
    // Label Detail
    doc.text('Detail', C2, y);
    doc.line(C2, y + 1, C2 + doc.getTextWidth('Detail'), y + 1);
    y += LH + 1;

    // Baris 1: Nama | No Kuitansi
    doc.setFont('helvetica', 'normal');
    doc.text('Nama: ', ML, y);
    doc.setFont('helvetica', 'bold');
    doc.text(k.pelanggan || '-', ML + doc.getTextWidth('Nama: '), y);
    doc.setFont('helvetica', 'normal');
    doc.text('No. Kuitansi: ', C2, y);
    doc.setFont('helvetica', 'bold');
    doc.text(k.no || '-', C2 + doc.getTextWidth('No. Kuitansi: '), y);
    y += LH;

    // Baris 2: Alamat label | Tanggal
    doc.setFont('helvetica', 'normal');
    doc.text('Alamat:', ML, y);
    doc.text('Tanggal: ' + fmtTgl(k.tgl), C2, y);
    y += LH;

    // Baris 3: isi alamat pelanggan | Status
    var aplLines = doc.splitTextToSize(k.alamatpl || '', CW * 0.42);
    for (var ai = 0; ai < aplLines.length; ai++) {
      doc.text(aplLines[ai], ML, y + ai * LH);
    }
    doc.text('Status: ', C2, y);
    doc.setFont('helvetica', 'bold');
    doc.text(k.status || 'LUNAS', C2 + doc.getTextWidth('Status: '), y);
    y += Math.max(aplLines.length, 1) * LH + 6;

    // ── RINCIAN ITEM label
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(0, 0, 0);
    doc.text('Rincian Item', ML, y);
    doc.setLineWidth(0.25);
    doc.line(ML, y + 1, ML + doc.getTextWidth('Rincian Item'), y + 1);
    y += 4;

    // ── TABEL — hitam putih
    var tableBody = (k.items || []).map(function(r, i) {
      return [
        i + 1,
        r.d || '',
        Number(r.q).toLocaleString('id-ID'),
        'Rp ' + Math.round(r.h || 0).toLocaleString('id-ID'),
        'Rp ' + Math.round((Number(r.q) || 0) * (Number(r.h) || 0)).toLocaleString('id-ID')
      ];
    });
    if (k.diskon > 0) {
      tableBody.push(['', '', '', 'Diskon', '- Rp ' + Math.round(k.diskon).toLocaleString('id-ID')]);
    }

    doc.autoTable({
      startY: y,
      head: [['No', 'Deskripsi', 'Qty', 'Harga Satuan', 'Subtotal']],
      body: tableBody,
      foot: [['', '', '', 'Total', 'Rp ' + Math.round(k.total).toLocaleString('id-ID')]],
      styles: {
        fontSize: 9,
        cellPadding: { top: 2.5, bottom: 2.5, left: 3, right: 3 },
        textColor: [0, 0, 0],
        lineColor: [0, 0, 0],
        lineWidth: 0.2,
        font: 'helvetica',
        fillColor: [255, 255, 255]
      },
      headStyles: {
        fillColor: [255, 255, 255],
        textColor: [0, 0, 0],
        fontStyle: 'bold',
        lineColor: [0, 0, 0],
        lineWidth: 0.3,
        halign: 'center'
      },
      footStyles: {
        fillColor: [255, 255, 255],
        textColor: [0, 0, 0],
        fontStyle: 'bold',
        lineColor: [0, 0, 0],
        lineWidth: 0.3
      },
      alternateRowStyles: { fillColor: [255, 255, 255] },
      columnStyles: {
        0: { cellWidth: 11, halign: 'center' },
        2: { cellWidth: 24, halign: 'right'  },
        3: { cellWidth: 38, halign: 'right'  },
        4: { cellWidth: 38, halign: 'right'  }
      },
      margin: { left: ML, right: MR }
    });

    y = doc.lastAutoTable.finalY + 8;

    // Pindah halaman bila sisa ruang tidak cukup untuk catatan + tanda tangan + footer
    if (y + 42 > doc.internal.pageSize.getHeight() - 22) { doc.addPage(); y = 20; }

    // ── CATATAN + TTD
    var kota = kotaDariAlamat(k.alamatpt);

    var ySection = y;

    // Catatan kiri
    if (k.catatan) {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9);
      doc.setTextColor(0, 0, 0);
      doc.text('Catatan', ML, y);
      doc.setLineWidth(0.25);
      doc.line(ML, y + 1, ML + doc.getTextWidth('Catatan'), y + 1);
      y += 5;
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(80, 80, 80);
      var catLines = doc.splitTextToSize(k.catatan, CW * 0.48);
      catLines.forEach(function(l) { doc.text(l, ML, y); y += 4.5; });
    }

    // TTD kanan
    var ttdMid = W - MR - 30;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(0, 0, 0);
    doc.text((kota ? kota + ', ' : '') + fmtTgl(k.tgl), ttdMid, ySection, { align: 'center' });
    var signY = ySection + 26;
    doc.text('(', ttdMid - 28, signY);
    doc.setLineWidth(0.3);
    doc.line(ttdMid - 24, signY, ttdMid + 24, signY);
    doc.text(')', ttdMid + 24, signY);
    doc.text('Penerima', ttdMid, signY + 5, { align: 'center' });

    // ── FOOTER
    var pageH = doc.internal.pageSize.getHeight();
    doc.setFontSize(9);
    doc.setFont('helvetica', 'italic');
    doc.setTextColor(80, 80, 80);
    doc.text('Terima kasih atas kepercayaan Anda.', W / 2, pageH - 15, { align: 'center' });

    var fname = 'kuitansi_' + (k.no || 'export') + '_' + nowStamp() + '.pdf';
    doc.save(fname);
    showToast('PDF Berhasil Dibuat', fname + ' telah didownload.', '📄');
    addLog('kuitansi', 'pdf', 'export PDF kuitansi ' + k.no + ' — ' + k.pelanggan);

  } catch (e) {
    showToast('Gagal Export PDF', e.message, '❌');
    console.error('exportPDF error:', e);
  }
}


// Export PDF langsung dari halaman Riwayat
function exportPDFById(id) {
  const k = _cache.kuitansi.find(x => x.id === id);
  if (!k) return;
  _lastKwt = k;
  exportPDF();
}

// ================================================================
//  MODAL (Pengeluaran)
// ================================================================

async function simpanModal() {
  if (CU.role !== 'owner') {
    showToast('Akses Ditolak', 'Hanya owner yang dapat mencatat modal.', '🔒');
    return;
  }
  const nama = document.getElementById('m-nama').value;
  const jml  = parseFloat(document.getElementById('m-jml').value) || 0;
  if (!nama || !jml) { showToast('Validasi', 'Lengkapi nama dan jumlah.', '⚠️'); return; }

  const btn = document.getElementById('btn-simpan-modal');
  btn.disabled = true; btn.textContent = 'Menyimpan...';
  setSyncBadge('saving', 'Menyimpan...');

  try {
    const entry = {
      id: Date.now(),
      jenis: document.getElementById('m-jenis').value,
      nama, jumlah: jml,
      ket:  document.getElementById('m-ket').value,
      tgl:  document.getElementById('m-tgl').value,
      timestamp: new Date().toISOString(),
      createdBy: CU.name,
      userId: CU.uid
    };
    await dbInsertModal(entry);
    await addLog('modal', 'masuk',
      `mencatat pengeluaran <strong>${nama}</strong> — ${fmt(jml)} [${entry.jenis}]`);
    setSyncBadge('ok', 'Tersimpan');

    document.getElementById('m-nama').value = '';
    document.getElementById('m-jml').value  = '';
    document.getElementById('m-ket').value  = '';
    renderModal();
    updatePL();
    showToast('Modal Dicatat', `${nama} — ${fmt(jml)}`, '💰');
  } catch (e) {
    setSyncBadge('err', 'Gagal');
    showToast('Gagal Menyimpan', e.message, '❌');
  }

  btn.disabled = false; btn.textContent = '+ Catat Pengeluaran';
}

function renderModal() {
  const fisik = _cache.modal.filter(m => m.jenis === 'fisik').reduce((s, m) => s + m.jumlah, 0);
  const ops   = _cache.modal.filter(m => m.jenis === 'operasional').reduce((s, m) => s + m.jumlah, 0);
  document.getElementById('ms-fisik').textContent = fmt(fisik);
  document.getElementById('ms-ops').textContent   = fmt(ops);
  document.getElementById('ms-total').textContent = fmt(fisik + ops);

  const el = document.getElementById('modal-list');
  const isOwner = CU && CU.role === 'owner';

  if (!_cache.modal.length) {
    el.innerHTML = '<div class="empty">Belum ada catatan modal</div>';
    return;
  }

  el.innerHTML = [..._cache.modal].reverse().map(m => `
    <div class="li-row">
      <div class="li-l">
        <div class="ico ${m.jenis === 'fisik' ? 'ico-b' : 'ico-o'}">${m.jenis === 'fisik' ? '🏭' : '⚡'}</div>
        <div>
          <div class="liname">${esc(m.nama)}</div>
          <div class="limeta">
            ${m.tgl || '-'} ·
            <span class="tag ${m.jenis === 'fisik' ? 't-fisik' : 't-ops'}">${esc(m.jenis)}</span>
            ${m.ket ? ' · ' + esc(m.ket) : ''} ·
            oleh <strong>${esc(m.createdBy || '-')}</strong>
          </div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;">
        <div class="liamt neg">-${fmt(m.jumlah)}</div>
        ${isOwner ? `<button class="btn btn-r" onclick="hapusModal(${m.id})">✕</button>` : ''}
      </div>
    </div>`).join('');
}

async function hapusModal(id) {
  if (CU.role !== 'owner') return;
  const m = _cache.modal.find(x => x.id === id);
  if (!m || !confirm(`Hapus pengeluaran "${m.nama}"?`)) return;

  setSyncBadge('saving', 'Menghapus...');
  try {
    await dbDeleteModal(id);
    await addLog('modal', 'hapus', `menghapus pengeluaran: <strong>${m.nama}</strong> — ${fmt(m.jumlah)}`);
    setSyncBadge('ok', 'Terhapus');
    renderModal();
    updatePL();
  } catch (e) {
    setSyncBadge('err', 'Gagal');
    showToast('Gagal Menghapus', e.message, '❌');
  }
}

// ================================================================
//  UNTUNG & RUGI (P&L)
// ================================================================

function initPLYearSelect() {
  const sel = document.getElementById('pl-filter-year');
  const now = new Date().getFullYear();
  if (!sel.options.length || sel.options[0].value !== String(now)) {
    sel.innerHTML = '';
    for (let y = now; y >= now - 5; y--) {
      const o = document.createElement('option');
      o.value = y; o.textContent = y;
      sel.appendChild(o);
    }
  }
}

function onPLFilterChange() {
  const mode = document.getElementById('pl-filter-mode').value;
  document.getElementById('pl-filter-month').style.display      = mode === 'month' ? '' : 'none';
  document.getElementById('pl-filter-year').style.display       = (mode === 'month' || mode === 'year') ? '' : 'none';
  document.getElementById('pl-filter-from').style.display       = mode === 'range' ? '' : 'none';
  document.getElementById('pl-filter-range-sep').style.display  = mode === 'range' ? '' : 'none';
  document.getElementById('pl-filter-to').style.display         = mode === 'range' ? '' : 'none';
  updatePL();
}

function getPLDateFilter() {
  const mode = document.getElementById('pl-filter-mode').value;
  if (mode === 'all') return null;
  if (mode === 'month') return {
    type: 'month',
    m: parseInt(document.getElementById('pl-filter-month').value),
    y: parseInt(document.getElementById('pl-filter-year').value || new Date().getFullYear())
  };
  if (mode === 'year') return {
    type: 'year',
    y: parseInt(document.getElementById('pl-filter-year').value || new Date().getFullYear())
  };
  if (mode === 'range') return {
    type: 'range',
    from: document.getElementById('pl-filter-from').value,
    to:   document.getElementById('pl-filter-to').value
  };
  return null;
}

function inDateFilter(dateStr, f) {
  if (!f || !dateStr) return !f;
  const d = new Date(dateStr + 'T00:00:00');
  if (f.type === 'month') return d.getMonth() === f.m && d.getFullYear() === f.y;
  if (f.type === 'year')  return d.getFullYear() === f.y;
  if (f.type === 'range') {
    if (f.from && d < new Date(f.from + 'T00:00:00')) return false;
    if (f.to   && d > new Date(f.to   + 'T00:00:00')) return false;
    return true;
  }
  return true;
}

function getPLLabel(f) {
  if (!f) return 'Semua Waktu';
  const B = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
  if (f.type === 'month') return B[f.m] + ' ' + f.y;
  if (f.type === 'year')  return 'Tahun ' + f.y;
  if (f.type === 'range') return (f.from || '?') + ' – ' + (f.to || '?');
  return '';
}

// Satu sumber angka keuangan untuk Dashboard, Untung & Rugi, dan grafik.
// f = filter periode (lihat getPLDateFilter) atau null untuk semua waktu.
function hitungKeuangan(f) {
  const ok    = (tgl) => f ? inDateFilter(tgl, f) : true;
  const asli  = _cache.kuitansi.filter(k => k.tipe === 'asli' && ok(k.tgl)).reduce((s, k) => s + k.total, 0);
  const mF    = _cache.modal.filter(m => ok(m.tgl));
  const pF    = _cache.plManual.filter(p => ok(p.tgl));
  const lainM = pF.filter(p => p.type === 'masuk').reduce((s, p) => s + p.amount, 0);
  const lainK = pF.filter(p => p.type === 'keluar').reduce((s, p) => s + p.amount, 0);
  const fisik = mF.filter(m => m.jenis === 'fisik').reduce((s, m) => s + m.jumlah, 0);
  const ops   = mF.filter(m => m.jenis === 'operasional').reduce((s, m) => s + m.jumlah, 0);
  const subM  = asli + lainM;
  const subK  = fisik + ops + lainK;
  return { asli, lainM, lainK, fisik, ops, subM, subK, net: subM - subK };
}

function updatePL() {
  const f = getPLDateFilter();
  const lbl = document.getElementById('pl-period-label');
  if (lbl) {
    if (f) { lbl.textContent = getPLLabel(f); lbl.style.display = ''; }
    else lbl.style.display = 'none';
  }

  const { asli, lainM, lainK, fisik, ops, subM, subK, net } = hitungKeuangan(f);

  const sv = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
  sv('pl-asli',       fmt(asli));
  sv('pl-lain-masuk', fmt(lainM));
  sv('pl-sub-masuk',  fmt(subM));
  sv('pl-fisik',      fmt(fisik));
  sv('pl-ops',        fmt(ops));
  sv('pl-lain-keluar',fmt(lainK));
  sv('pl-sub-keluar', fmt(subK));

  const ne = document.getElementById('pl-net');
  if (ne) {
    ne.textContent = (net >= 0 ? '+' : '') + fmt(net);
    ne.style.color = net >= 0 ? 'var(--green)' : 'var(--red)';
  }

  const sb = document.getElementById('pl-status-box');
  if (sb) {
    if (net > 0) {
      sb.style.cssText = 'background:rgba(34,197,94,.1);color:var(--green);border:1px solid rgba(34,197,94,.2);text-align:center;padding:11px;border-radius:var(--rsm);font-size:13px;font-weight:700;';
      sb.textContent = `✅ UNTUNG — ${fmt(net)} (${getPLLabel(f)})`;
    } else if (net < 0) {
      sb.style.cssText = 'background:rgba(239,68,68,.1);color:var(--red);border:1px solid rgba(239,68,68,.2);text-align:center;padding:11px;border-radius:var(--rsm);font-size:13px;font-weight:700;';
      sb.textContent = `❌ RUGI — Pengeluaran melebihi pemasukan sebesar ${fmt(Math.abs(net))}`;
    } else {
      sb.style.cssText = 'background:var(--surf2);color:var(--ink3);text-align:center;padding:11px;border-radius:var(--rsm);font-size:13px;font-weight:600;';
      sb.textContent = 'Belum ada data atau Break Even.';
    }
  }

  renderChart();

  // Daftar catatan manual
  const plel = document.getElementById('pl-extra-list');
  if (!plel) return;
  const list = f ? _cache.plManual.filter(p => inDateFilter(p.tgl, f)) : _cache.plManual;
  if (!list.length) {
    plel.innerHTML = '<div class="empty">Belum ada catatan tambahan</div>';
    return;
  }
  plel.innerHTML = [...list].reverse().map(p => `
    <div class="li-row">
      <div class="li-l">
        <div class="ico ${p.type === 'masuk' ? 'ico-g' : 'ico-r'}">${p.type === 'masuk' ? '✅' : '❌'}</div>
        <div>
          <div class="liname">${esc(p.desc)}</div>
          <div class="limeta">${p.tgl || '-'} · oleh ${esc(p.createdBy || '-')}</div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;">
        <div class="liamt ${p.type === 'masuk' ? 'pos' : 'neg'}">
          ${p.type === 'masuk' ? '+' : '-'}${fmt(p.amount)}
        </div>
        <button class="btn btn-r" onclick="hapusPL(${p.id})">✕</button>
      </div>
    </div>`).join('');
}

async function simpanPL() {
  if (CU.role !== 'owner') { showToast('Akses Ditolak', 'Hanya owner.', '🔒'); return; }
  const amt  = parseFloat(document.getElementById('pl-amt').value) || 0;
  const desc = document.getElementById('pl-desc').value;
  if (!desc || !amt) { showToast('Validasi', 'Lengkapi keterangan dan jumlah.', '⚠️'); return; }

  const btn = document.getElementById('btn-simpan-pl');
  btn.disabled = true; btn.textContent = 'Menyimpan...';
  setSyncBadge('saving', 'Menyimpan...');

  try {
    const type = document.getElementById('pl-type').value;
    const p = {
      id: Date.now(), type, amount: amt, desc,
      tgl: todayISO(),
      createdBy: CU.name, userId: CU.uid
    };
    await dbInsertPL(p);
    await addLog('pl', 'masuk',
      `mencatat ${type === 'masuk' ? 'pemasukan' : 'pengeluaran'} lain: <strong>${desc}</strong> — ${fmt(amt)}`);
    setSyncBadge('ok', 'Tersimpan');
    document.getElementById('pl-amt').value  = '';
    document.getElementById('pl-desc').value = '';
    updatePL();
    showToast('Catatan Disimpan', `${desc} — ${fmt(amt)}`, '📊');
  } catch (e) {
    setSyncBadge('err', 'Gagal');
    showToast('Gagal', e.message, '❌');
  }

  btn.disabled = false; btn.textContent = 'Catat';
}

async function hapusPL(id) {
  const p = _cache.plManual.find(x => x.id === id);
  if (!p || !confirm('Hapus catatan ini?')) return;

  setSyncBadge('saving', 'Menghapus...');
  try {
    await dbDeletePL(id);
    await addLog('pl', 'hapus', `menghapus catatan: <strong>${p.desc}</strong> — ${fmt(p.amount)}`);
    setSyncBadge('ok', 'Terhapus');
    updatePL();
  } catch (e) {
    setSyncBadge('err', 'Gagal');
    showToast('Gagal', e.message, '❌');
  }
}

// ================================================================
//  GRAFIK TREN BULANAN (12 bulan terakhir)
// ================================================================

function renderChart() {
  const el = document.getElementById('chart-area');
  if (!el) return;

  const now    = new Date();
  const months = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({
      y: d.getFullYear(), m: d.getMonth(),
      label: ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Ags','Sep','Okt','Nov','Des'][d.getMonth()] +
             "'" + String(d.getFullYear()).slice(2)
    });
  }

  const data = months.map(mo => {
    const r = hitungKeuangan({ type: 'month', m: mo.m, y: mo.y });
    return { ...mo, masuk: r.subM, keluar: r.subK };
  });

  const maxVal = Math.max(...data.map(d => Math.max(d.masuk, d.keluar)), 1);
  if (!data.some(d => d.masuk > 0 || d.keluar > 0)) {
    el.innerHTML = '<div class="chart-empty">Belum ada data transaksi</div>';
    return;
  }

  const barsHTML = data.map(d => {
    const hM  = Math.round((d.masuk  / maxVal) * 140);
    const hK  = Math.round((d.keluar / maxVal) * 140);
    const nc  = d.masuk >= d.keluar ? 'var(--green)' : 'var(--red)';
    return `<div class="chart-bar-group">
      <div class="chart-bar-pair">
        <div class="chart-bar" style="height:${hM || 2}px;background:var(--green);opacity:.85;"
          title="Pemasukan: ${fmt(d.masuk)}"></div>
        <div class="chart-bar" style="height:${hK || 2}px;background:var(--red);opacity:.85;"
          title="Pengeluaran: ${fmt(d.keluar)}"></div>
      </div>
      <div class="chart-bar-label" style="color:${nc};">${d.label}</div>
    </div>`;
  }).join('');

  el.innerHTML = `
    <div class="chart-wrap">
      <div class="chart-bars">${barsHTML}</div>
      <div class="chart-legend">
        <div class="chart-legend-item">
          <div class="chart-legend-dot" style="background:var(--green);opacity:.85;"></div>Pemasukan
        </div>
        <div class="chart-legend-item">
          <div class="chart-legend-dot" style="background:var(--red);opacity:.85;"></div>Pengeluaran
        </div>
      </div>
    </div>`;
}

// ================================================================
//  DASHBOARD
// ================================================================

function renderDashboard() {
  const kk    = hitungKeuangan(null);
  const asli  = kk.subM;
  const kel   = kk.subK;
  const saldo = kk.net;
  const now   = new Date();
  const bln   = _cache.kuitansi.filter(k => {
    if (!k.tgl) return false;
    const d = new Date(k.tgl + 'T00:00:00');
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  }).length;

  document.getElementById('s-masuk').textContent  = fmt(asli);
  document.getElementById('s-keluar').textContent = fmt(kel);
  document.getElementById('s-saldo').textContent  = fmt(saldo);
  document.getElementById('s-saldo').className    = 'sval ' + (saldo >= 0 ? 'sv-g' : 'sv-r');
  document.getElementById('s-order').textContent  = bln;

  // 7 transaksi terbaru (gabungan kuitansi + modal)
  const all = [
    ..._cache.kuitansi.map(k => ({
      lbl: k.pelanggan + ' — ' + k.no, date: k.tgl, amt: k.total,
      pos: true, tag: k.tipe, ico: '🧾', ic: 'ico-g', by: k.createdBy
    })),
    ..._cache.modal.map(m => ({
      lbl: m.nama, date: m.tgl, amt: m.jumlah,
      pos: false, tag: m.jenis, ico: m.jenis === 'fisik' ? '🏭' : '⚡', ic: 'ico-r', by: m.createdBy
    }))
  ].sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0)).slice(0, 7);

  const el = document.getElementById('db-recent');
  if (!all.length) { el.innerHTML = '<div class="empty">Belum ada transaksi</div>'; return; }
  el.innerHTML = all.map(t => `
    <div class="li-row">
      <div class="li-l">
        <div class="ico ${t.ic}">${t.ico}</div>
        <div>
          <div class="liname">${esc(t.lbl)}</div>
          <div class="limeta">
            ${t.date || '-'} ·
            <span class="tag ${t.tag === 'asli' ? 't-asli' : t.tag === 'fiktif' ? 't-fiktif' : t.tag === 'fisik' ? 't-fisik' : 't-ops'}">
              ${esc(t.tag)}
            </span>
            ${t.by ? ' · oleh <strong>' + esc(t.by) + '</strong>' : ''}
          </div>
        </div>
      </div>
      <div class="liamt ${t.pos ? 'pos' : 'neg'}">${t.pos ? '+' : '-'}${fmt(t.amt)}</div>
    </div>`).join('');
}

// ================================================================
//  RIWAYAT KUITANSI
// ================================================================

function renderRiwayat() {
  const f = document.getElementById('filter-tipe').value;
  const list = f === 'semua' ? _cache.kuitansi : _cache.kuitansi.filter(k => k.tipe === f);
  const el = document.getElementById('kwt-list');
  const isOwner = CU && CU.role === 'owner';

  if (!list.length) { el.innerHTML = '<div class="empty">Belum ada kuitansi</div>'; return; }

  el.innerHTML = [...list].reverse().map(k => `
    <div class="li-row">
      <div class="li-l">
        <div class="ico ico-g">🧾</div>
        <div>
          <div class="liname">
            ${esc(k.no)} — ${esc(k.pelanggan)}
            <span class="tag ${k.tipe === 'asli' ? 't-asli' : 't-fiktif'}" style="margin-left:5px;">
              ${esc(String(k.tipe || '').toUpperCase())}
            </span>
          </div>
          <div class="limeta">
            ${k.tgl || '-'} · ${(k.items || []).length} item ·
            ${fmt(k.total)} · oleh <strong>${esc(k.createdBy || '-')}</strong>
          </div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
        <button class="btn btn-o btn-sm" onclick="lihatKwt(${k.id})">Lihat</button>
        <button class="btn btn-sm btn-pdf" onclick="exportPDFById(${k.id})">📄 PDF</button>
        ${isOwner ? `<button class="btn btn-r" onclick="hapusKwt(${k.id})">✕</button>` : ''}
      </div>
    </div>`).join('');
}

function lihatKwt(id) {
  const k = _cache.kuitansi.find(x => x.id === id);
  if (!k) return;
  _lastKwt = k;
  goPage('kuitansi');
  document.getElementById('rc-container').innerHTML = buildReceipt(k, true);
  document.getElementById('rc-container').style.display = 'block';
  document.getElementById('print-acts').style.display   = 'flex';
  setTimeout(() => document.getElementById('rc-container').scrollIntoView({ behavior: 'smooth' }), 100);
}

async function hapusKwt(id) {
  if (CU.role !== 'owner') { showToast('Akses Ditolak', 'Hanya owner yang dapat menghapus kuitansi.', '🔒'); return; }
  const k = _cache.kuitansi.find(x => x.id === id);
  if (!k || !confirm(`Hapus kuitansi ${k.no} — ${k.pelanggan}?`)) return;

  setSyncBadge('saving', 'Menghapus...');
  try {
    await dbDeleteKwt(id);
    await addLog('kuitansi', 'hapus',
      `menghapus kuitansi <strong>${k.no}</strong> — ${k.pelanggan} [${fmt(k.total)}]`);
    setSyncBadge('ok', 'Terhapus');
    renderRiwayat();
    updatePL();
  } catch (e) {
    setSyncBadge('err', 'Gagal');
    showToast('Gagal Menghapus', e.message, '❌');
  }
}

// ================================================================
//  LOG AKTIVITAS
// ================================================================

function renderLog() {
  const fu = document.getElementById('log-filter-user').value;
  const ft = document.getElementById('log-filter-type').value;
  let list = _cache.logs || [];
  if (fu !== 'semua') list = list.filter(l => l.user === fu);
  if (ft !== 'semua') list = list.filter(l => l.category === ft || l.action === ft);

  const cnt = document.getElementById('log-count');
  if (cnt) cnt.textContent = `Menampilkan ${list.length} dari ${(_cache.logs || []).length} entri`;

  const el = document.getElementById('log-list');
  if (!list.length) { el.innerHTML = '<div class="empty">Tidak ada log yang cocok</div>'; return; }

  el.innerHTML = list.map(l => `
    <div class="log-entry">
      <div class="log-dot ${ldClass(l.category, l.action)}"></div>
      <div class="log-main">
        <div class="log-msg">
          ${actIco(l.category, l.action)}&nbsp;
          <span class="log-who who-${esc(l.user)}">${esc(l.user)}</span>
          ${safeLogHtml(l.detail)}
        </div>
        <div class="log-sub">
          ${fmtDT(l.ts)}&nbsp;·&nbsp;
          <span class="tag t-log">${esc(l.category)}</span>
        </div>
      </div>
    </div>`).join('');
}

function eksporLogCSV() {
  const rows = ['Waktu,Pengguna,Role,Kategori,Aksi,Detail'];
  (_cache.logs || []).forEach(l => {
    const q = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const d = (l.detail || '').replace(/<[^>]+>/g, '');
    rows.push([fmtDT(l.ts), l.user, l.role, l.category, l.action, d].map(q).join(','));
  });
  dlText(rows.join('\n'), 'log_aktivitas_' + nowStamp() + '.csv');
}

// ================================================================
//  BACKUP & RESTORE
// ================================================================

function renderSbConnStatus() {
  const el = document.getElementById('sb-conn-status');
  if (!el) return;
  const cfg = getSbConfig();
  if (!cfg) {
    el.innerHTML = '<div class="sb-status sb-disconnected">❌ Supabase belum dikonfigurasi.</div>';
    return;
  }
  const bawaan = hasDefaultSbConfig();
  el.innerHTML = `
    <div class="sb-status sb-connected">✅ Terhubung ke Supabase v2 — Supabase Auth aktif</div>
    <div style="font-size:12px;color:var(--ink3);margin-top:8px;">
      URL: <code style="color:var(--cyan);font-family:var(--mono);">${esc(cfg.url)}</code>
      ${bawaan
        ? '<div style="margin-top:6px;">Konfigurasi diatur di <code>js/config.js</code> sehingga berlaku otomatis di semua perangkat.</div>'
        : `<button class="btn btn-r btn-sm" style="margin-left:10px;"
            onclick="if(confirm('Reset konfigurasi & logout?')){
              localStorage.removeItem('pm_sb_cfg2'); doLogout(); showSetup();
            }">🗑 Reset Config</button>`}
    </div>`;
}

async function doBackup(type) {
  await dbLoad(); // Pastikan data terbaru
  const ts = nowStamp();
  let data, fname;

  if (type === 'all') {
    data  = { version: 'pm_v2', exportedAt: new Date().toISOString(), exportedBy: CU.name,
               kuitansi: _cache.kuitansi, modal: _cache.modal, plManual: _cache.plManual,
               logs: _cache.logs, templates: _cache.templates };
    fname = 'printmanager_FULL_' + ts + '.json';
  } else if (type === 'kuitansi') {
    data  = { version: 'pm_v2', type: 'kuitansi', exportedAt: new Date().toISOString(),
               exportedBy: CU.name, kuitansi: _cache.kuitansi };
    fname = 'backup_kuitansi_' + ts + '.json';
  } else if (type === 'modal') {
    data  = { version: 'pm_v2', type: 'modal', exportedAt: new Date().toISOString(),
               exportedBy: CU.name, modal: _cache.modal, plManual: _cache.plManual };
    fname = 'backup_modal_' + ts + '.json';
  } else if (type === 'logs') {
    data  = { version: 'pm_v2', type: 'logs', exportedAt: new Date().toISOString(),
               exportedBy: CU.name, logs: _cache.logs };
    fname = 'backup_log_' + ts + '.json';
  }

  dlJSON(data, fname);
  await addLog('backup', 'backup', `membuat backup <strong>${type === 'all' ? 'semua data' : type}</strong> → ${fname}`);
  showToast('Backup Selesai', fname, '📦');
}

function doRestore(input, type) {
  const file = input.files[0];
  if (!file) return;
  if (!CU || CU.role !== 'owner') {
    showToast('Akses Ditolak', 'Hanya owner yang dapat melakukan restore.', '🔒');
    input.value = '';
    return;
  }

  const reader = new FileReader();
  reader.onload = async function (e) {
    try {
      const p = JSON.parse(e.target.result);
      if (!p || !Array.isArray(p.kuitansi)) throw new Error('Format file tidak valid (kuitansi tidak ditemukan)');

      const all = type === 'all';
      const hasId = (r) => r && r.id != null;
      const kw  = p.kuitansi.filter(hasId);
      const mo  = all ? (p.modal    || []).filter(hasId) : [];
      const pl  = all ? (p.plManual || []).filter(hasId) : [];
      const tm  = all ? (p.templates || []).filter(t => t && t.name &&
                    !_cache.templates.some(x => x.name === t.name)) : [];

      const ringkas = `${kw.length} kuitansi` + (all ? `, ${mo.length} modal, ${pl.length} catatan P&L, ${tm.length} template baru` : '');
      if (!confirm(`Restore ${ringkas} dari file ini? Data dengan ID yang sudah ada akan dilewati.`)) { input.value = ''; return; }

      setSyncBadge('saving', 'Merestore...');
      const hitung = () => _cache.kuitansi.length + _cache.modal.length + _cache.plManual.length + _cache.templates.length;
      await dbLoad();
      const before = hitung();

      let gagal = 0, pesanError = '';
      const jalankan = async (tabel, baris, insertBiasa) => {
        for (let i = 0; i < baris.length; i += 200) {
          const potong = baris.slice(i, i + 200);
          const q = insertBiasa
            ? sbClient.from(tabel).insert(potong)
            : sbClient.from(tabel).upsert(potong, { onConflict: 'id', ignoreDuplicates: true });
          const { error } = await q;
          if (error) { gagal += potong.length; pesanError = error.message; }
        }
      };

      await jalankan('pm_kuitansi', kw.map(kwtRow));
      if (all) {
        await jalankan('pm_modal',     mo.map(modalRow));
        await jalankan('pm_pl_manual', pl.map(plRow));
        await jalankan('pm_item_templates', tm.map(t => ({
          name: t.name, default_price: t.default_price, unit: t.unit, created_by: t.created_by || CU.name
        })), true);
      }

      await dbLoad();
      const ditambah = hitung() - before;
      await addLog('restore', 'restore', `restore dari ${file.name}: ${ditambah} data ditambahkan, ${gagal} gagal`);
      renderDashboard();
      renderBackupInfo();

      if (gagal > 0) {
        setSyncBadge('err', 'Restore sebagian');
        showToast('Restore Sebagian Gagal', `${ditambah} ditambahkan, ${gagal} gagal: ${pesanError}`, '⚠️', 10000);
      } else {
        setSyncBadge('ok', 'Restore selesai');
        showToast('Restore Selesai', `${ditambah} data baru ditambahkan (sisanya sudah ada).`, '✅');
      }
    } catch (err) {
      setSyncBadge('err', 'Gagal');
      showToast('Gagal Restore', err.message, '❌');
    }
    input.value = '';
  };
  reader.readAsText(file);
}

function renderBackupInfo() {
  const el = document.getElementById('db-info');
  if (!el) return;
  const items = [
    { label: 'Kuitansi',   count: (_cache.kuitansi  || []).length, ico: '🧾', cls: 'sv-g' },
    { label: 'Modal',      count: (_cache.modal      || []).length, ico: '💰', cls: 'sv-b' },
    { label: 'P&L Manual', count: (_cache.plManual   || []).length, ico: '📊', cls: 'sv-o' },
    { label: 'Log Entri',  count: (_cache.logs       || []).length, ico: '📋', cls: 'sv-r' }
  ];
  el.innerHTML = items.map(i => `
    <div class="stat-card">
      <div class="slbl">${i.ico} ${i.label}</div>
      <div class="sval ${i.cls}">${i.count}</div>
      <div style="font-size:11px;color:var(--ink3);margin-top:4px;">entri tersimpan</div>
    </div>`).join('');
}

// ================================================================
//  INISIALISASI APLIKASI
// ================================================================

  

// ================================================================
//  INISIALISASI APLIKASI — dijalankan setelah CDN selesai dimuat
// ================================================================
(async () => {
  try {
    await _cdnReady; // Tunggu Supabase & jsPDF siap

// Set tanggal default ke hari ini
    const today = todayISO();
  const qTgl  = document.getElementById('q-tgl');
  const mTgl  = document.getElementById('m-tgl');
  if (qTgl) qTgl.value = today;
  if (mTgl) mTgl.value = today;

  // Isi SQL di setup screen
  const sqlEl = document.getElementById('sql-code');
  if (sqlEl) sqlEl.textContent = SQL_SCHEMA;

  // Render tabel item kosong
  renderRows();

  // Terapkan tema & sidebar state sebelum apapun
  applyTheme();
  applysidebar();

  // Konfigurasi bawaan aktif → tautan "Ubah konfigurasi" tidak diperlukan
  if (hasDefaultSbConfig()) {
    const lnk = document.getElementById('btn-cfg-link');
    if (lnk) lnk.style.display = 'none';
  }

  // Cek apakah konfigurasi Supabase sudah ada
  const cfg = getSbConfig();
  if (!cfg) {
    hideLoading();
    document.getElementById('setup-wrap').style.display = 'flex';
    return;
  }

  // Inisialisasi Supabase client
  const lmsg = document.getElementById('loading-msg');
  if (lmsg) lmsg.textContent = 'Menghubungkan ke Supabase...';
  if (!initSupabase(cfg.url, cfg.key)) {
    hideLoading();
    if (_lastInitError) showToast('Konfigurasi Ditolak', _lastInitError, '⛔', 0);
    document.getElementById('setup-wrap').style.display = 'flex';
    return;
  }
  if (lmsg) lmsg.textContent = 'Memeriksa sesi...';

  // Sesi lama berbasis localStorage sudah tidak dipakai (bisa dipalsukan) → bersihkan
  clearSession();

  // Pulihkan sesi dari Supabase Auth (token dikelola Supabase, peran dari app_metadata)
  try {
    const { data: { session } } = await sbClient.auth.getSession();
    if (session) {
      const matchKey = Object.keys(USERS).find(k => USERS[k].email === session.user.email);
      const user = matchKey ? buildCU(matchKey, session.user) : null;
      if (user) {
        CU     = user;
        selKey = matchKey;
        applyUserUI(CU);
        await dbLoad();
        renderDashboard();
        startRealtime();
        requestNotifPermission();
        console.log('[Init] Sesi Auth dipulihkan untuk:', CU.name);
        return;
      }
      try { await sbClient.auth.signOut(); } catch (_) {}
    }
  } catch (e) {
    console.warn('[Init] Session check gagal:', e.message);
  }

  // Tidak ada sesi → tampilkan login
  hideLoading();
  document.getElementById('login-wrap').style.display = 'flex';



  } catch (e) {
    console.error('[App] Fatal error during init:', e);
    showError('❌ Error: ' + (e.message || e) + '<br><a href="" style="color:#3b82f6">Refresh halaman</a>');
  }
})();
