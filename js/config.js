// ================================================================
// KONFIGURASI SUPABASE BAWAAN — berlaku untuk SEMUA perangkat.
// Jika diisi, perangkat baru langsung terhubung tanpa wizard setup.
//
// Isi HANYA dengan Project URL dan kunci "anon" / "publishable"
// (Supabase → Project Settings → API). Kunci ini memang publik dan
// dibatasi oleh Row Level Security.
// JANGAN PERNAH mengisi kunci service_role / secret di sini.
// Format baris di bawah dibaca juga oleh scripts/keepalive.mjs.
// ================================================================
const SUPABASE_DEFAULT = {
  url: 'https://xbzifertjqixigwrlrod.supabase.co',
  key: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhiemlmZXJ0anFpeGlnd3Jscm9kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI3NTkzODQsImV4cCI6MjA5ODMzNTM4NH0.pzFCIH6_SJWgnwvWZ8mg544KosTPi-EttxmAG1I5dg4'
};

// Daftar akun (tampilan saja). Password TIDAK disimpan di kode:
// akun & password dikelola di Supabase → Authentication → Users.
// Peran (role) dibaca dari app_metadata.role di token login (lihat sql/001_amankan_role.sql).
const USERS = {
  admin: {
    name: 'Admin',
    role: 'admin',
    initials: 'AD',
    pipClass: 'pip-a',
    email: 'admin@printmanager.local'
  },
  agus: {
    name: 'Agus',
    role: 'owner',
    initials: 'AG',
    pipClass: 'pip-o',
    email: 'agus@printmanager.local'
  },
  arko: {
    name: 'Arko',
    role: 'owner',
    initials: 'AR',
    pipClass: 'pip-o',
    email: 'arko@printmanager.local'
  }
};

// SQL yang ditampilkan di setup wizard (langkah 2)
const SQL_SCHEMA = `-- PrintManager Pro v2 — Jalankan di Supabase SQL Editor → Run

-- 1. BUAT TABEL
create table if not exists pm_kuitansi (
  id          bigint       primary key,
  timestamp   timestamptz  default now(),
  created_by  text,
  user_id     uuid         references auth.users(id) on delete set null,
  tipe        text,
  namapt      text, kontakpt text, alamatpt text,
  no          text, tgl date, status text,
  pelanggan   text, alamatpl text, catatan text,
  items       jsonb        default '[]',
  diskon      numeric      default 0,
  total       numeric      default 0,
  dibayar     numeric,
  batal       boolean      not null default false,
  batal_alasan text, batal_oleh text, batal_at timestamptz,
  diubah_at   timestamptz, diubah_oleh text
);
create table if not exists pm_modal (
  id          bigint       primary key,
  timestamp   timestamptz  default now(),
  created_by  text,
  user_id     uuid         references auth.users(id) on delete set null,
  jenis       text, nama text, jumlah numeric default 0, ket text, tgl date
);
create table if not exists pm_pl_manual (
  id          bigint       primary key,
  type        text,
  amount      numeric      default 0,
  keterangan  text,
  tgl         date,
  created_by  text,
  user_id     uuid         references auth.users(id) on delete set null
);
create table if not exists pm_logs (
  id          text         primary key,
  ts          timestamptz  default now(),
  username    text, role text, user_id uuid,
  category    text, action text, detail text
);
create table if not exists pm_item_templates (
  id            bigserial    primary key,
  name          text         not null,
  default_price numeric      default 0,
  unit          text         default 'pcs',
  created_by    text,
  created_at    timestamptz  default now()
);

-- 2. ROW LEVEL SECURITY
alter table pm_kuitansi      enable row level security;
alter table pm_modal         enable row level security;
alter table pm_pl_manual     enable row level security;
alter table pm_logs          enable row level security;
alter table pm_item_templates enable row level security;

-- Helper: baca role dari JWT app_metadata (TIDAK bisa diubah oleh pengguna sendiri)
create or replace function get_user_role()
returns text language sql stable security definer set search_path = public as $$
  select coalesce(auth.jwt()->'app_metadata'->>'role', 'none');
$$;

-- Drop policy lama (agar bisa dijalankan ulang)
drop policy if exists "kw_sel" on pm_kuitansi;
drop policy if exists "kw_ins" on pm_kuitansi;
drop policy if exists "kw_del" on pm_kuitansi;
drop policy if exists "kw_upd" on pm_kuitansi;
drop policy if exists "mo_all" on pm_modal;
drop policy if exists "pl_all" on pm_pl_manual;
drop policy if exists "lo_all" on pm_logs;
drop policy if exists "lo_sel" on pm_logs;
drop policy if exists "lo_ins" on pm_logs;
drop policy if exists "tm_sel" on pm_item_templates;
drop policy if exists "tm_own" on pm_item_templates;

-- Kuitansi: admin & owner bisa SELECT/INSERT, hanya owner bisa DELETE
create policy "kw_sel" on pm_kuitansi for select to authenticated using (get_user_role() in ('admin','owner'));
create policy "kw_ins" on pm_kuitansi for insert to authenticated
  with check (get_user_role() in ('admin','owner') and (auth.uid() = user_id or get_user_role() = 'owner'));
create policy "kw_del" on pm_kuitansi for delete to authenticated using (get_user_role() = 'owner');
create policy "kw_upd" on pm_kuitansi for update to authenticated using (get_user_role() = 'owner') with check (get_user_role() = 'owner');

-- Modal & P&L: hanya owner
create policy "mo_all" on pm_modal     for all to authenticated using (get_user_role() = 'owner') with check (get_user_role() = 'owner');
create policy "pl_all" on pm_pl_manual for all to authenticated using (get_user_role() = 'owner') with check (get_user_role() = 'owner');

-- Log: admin & owner boleh menambah, hanya owner boleh membaca, tidak ada yang bisa ubah/hapus
create policy "lo_ins" on pm_logs for insert to authenticated with check (get_user_role() in ('admin','owner'));
create policy "lo_sel" on pm_logs for select to authenticated using (get_user_role() = 'owner');

-- Template: admin & owner bisa baca, hanya owner bisa ubah
create policy "tm_sel" on pm_item_templates for select to authenticated using (get_user_role() in ('admin','owner'));
create policy "tm_own" on pm_item_templates for all to authenticated using (get_user_role() = 'owner') with check (get_user_role() = 'owner');

-- 3. AKTIFKAN REALTIME
alter publication supabase_realtime add table pm_kuitansi;
alter publication supabase_realtime add table pm_modal;
alter publication supabase_realtime add table pm_pl_manual;
alter publication supabase_realtime add table pm_item_templates;

-- 4. TEMPLATE ITEM CONTOH
insert into pm_item_templates (name, default_price, unit, created_by) values
  ('Print A4 BW',      500,   'lembar', 'System'),
  ('Print A4 Color',   2000,  'lembar', 'System'),
  ('Print A3 BW',      1000,  'lembar', 'System'),
  ('Print A3 Color',   4000,  'lembar', 'System'),
  ('Fotocopy A4',      300,   'lembar', 'System'),
  ('Laminasi A4',      5000,  'lembar', 'System'),
  ('Spiral Binding',   10000, 'buku',   'System'),
  ('Cetak Banner',     35000, 'm²',     'System'),
  ('Cetak Stiker',     3000,  'lembar', 'System'),
  ('Jilid Softcover',  15000, 'buku',   'System')
on conflict do nothing;

-- 5. BERI PERAN KE AKUN (buat dulu akun di Authentication → Users)
update auth.users set raw_app_meta_data = coalesce(raw_app_meta_data,'{}'::jsonb) || '{"role":"admin"}'::jsonb where email = 'admin@printmanager.local';
update auth.users set raw_app_meta_data = coalesce(raw_app_meta_data,'{}'::jsonb) || '{"role":"owner"}'::jsonb where email in ('agus@printmanager.local','arko@printmanager.local');

-- 6. KEEP-ALIVE (mencegah project free tier ter-pause karena jarang dipakai)
create table if not exists pm_heartbeat (
  id        int primary key default 1 check (id = 1),
  last_ping timestamptz not null default now()
);
alter table pm_heartbeat enable row level security;  -- tanpa policy: tertutup untuk akses langsung

create or replace function ping_keepalive()
returns timestamptz language plpgsql security definer set search_path = public as $$
declare t timestamptz := now();
begin
  insert into pm_heartbeat (id, last_ping) values (1, t)
  on conflict (id) do update set last_ping = excluded.last_ping;
  return t;
end;
$$;
revoke all on function ping_keepalive() from public;
grant execute on function ping_keepalive() to anon, authenticated;`;
