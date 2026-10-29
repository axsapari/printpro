-- ================================================================
-- 001_amankan_role.sql — PrintManager Pro
-- Memindahkan sumber peran (role) dari user_metadata (bisa diubah
-- pengguna sendiri) ke app_metadata (hanya bisa diubah server/SQL),
-- dan mengetatkan Row Level Security.
--
-- CARA PAKAI: Supabase → SQL Editor → tempel seluruh isi file → Run.
-- Aman dijalankan ulang. Setelah selesai, SEMUA pengguna harus
-- logout lalu login lagi agar token baru memuat peran.
-- ================================================================

-- LANGKAH 1: beri peran di app_metadata (jalankan dulu sebelum policy baru)
update auth.users set raw_app_meta_data = coalesce(raw_app_meta_data,'{}'::jsonb) || '{"role":"admin"}'::jsonb where email = 'admin@printmanager.local';
update auth.users set raw_app_meta_data = coalesce(raw_app_meta_data,'{}'::jsonb) || '{"role":"owner"}'::jsonb where email in ('agus@printmanager.local','arko@printmanager.local');

-- LANGKAH 2: fungsi role + policy baru
-- Helper: baca role dari JWT app_metadata (TIDAK bisa diubah oleh pengguna sendiri)
create or replace function get_user_role()
returns text language sql stable security definer set search_path = public as $$
  select coalesce(auth.jwt()->'app_metadata'->>'role', 'none');
$$;

-- Drop policy lama (agar bisa dijalankan ulang)
drop policy if exists "kw_sel" on pm_kuitansi;
drop policy if exists "kw_ins" on pm_kuitansi;
drop policy if exists "kw_del" on pm_kuitansi;
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

-- Modal & P&L: hanya owner
create policy "mo_all" on pm_modal     for all to authenticated using (get_user_role() = 'owner') with check (get_user_role() = 'owner');
create policy "pl_all" on pm_pl_manual for all to authenticated using (get_user_role() = 'owner') with check (get_user_role() = 'owner');

-- Log: admin & owner boleh menambah, hanya owner boleh membaca, tidak ada yang bisa ubah/hapus
create policy "lo_ins" on pm_logs for insert to authenticated with check (get_user_role() in ('admin','owner'));
create policy "lo_sel" on pm_logs for select to authenticated using (get_user_role() = 'owner');

-- Template: admin & owner bisa baca, hanya owner bisa ubah
create policy "tm_sel" on pm_item_templates for select to authenticated using (get_user_role() in ('admin','owner'));
create policy "tm_own" on pm_item_templates for all to authenticated using (get_user_role() = 'owner') with check (get_user_role() = 'owner');

-- (OPSIONAL) LANGKAH 3: cegah nomor kuitansi kembar.
-- Jalankan pemeriksaan ini dulu; hanya jika hasilnya KOSONG, buat index-nya.
--   select no, count(*) from pm_kuitansi group by no having count(*) > 1;
-- create unique index if not exists pm_kuitansi_no_uniq on pm_kuitansi (no);
