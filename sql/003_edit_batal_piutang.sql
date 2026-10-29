-- ================================================================
-- 003_edit_batal_piutang.sql — PrintManager Pro (Fase 2)
-- Menambah kolom untuk: pembayaran DP/piutang, pembatalan (void),
-- dan jejak perubahan kuitansi; serta izin UPDATE khusus owner.
--
-- CARA PAKAI: Supabase → SQL Editor → tempel seluruh isi → Run.
-- Aman dijalankan ulang. Jalankan SEBELUM memakai fitur edit/batal/DP.
-- (Menyimpan kuitansi biasa tetap berfungsi walau belum dijalankan.)
-- ================================================================

alter table pm_kuitansi add column if not exists dibayar      numeric;       -- jumlah yang sudah dibayar (dipakai saat status DP)
alter table pm_kuitansi add column if not exists batal        boolean not null default false;
alter table pm_kuitansi add column if not exists batal_alasan text;
alter table pm_kuitansi add column if not exists batal_oleh   text;
alter table pm_kuitansi add column if not exists batal_at     timestamptz;
alter table pm_kuitansi add column if not exists diubah_at    timestamptz;
alter table pm_kuitansi add column if not exists diubah_oleh  text;

-- Hanya owner yang boleh mengubah kuitansi (edit, batal, pulihkan, tandai lunas)
drop policy if exists "kw_upd" on pm_kuitansi;
create policy "kw_upd" on pm_kuitansi for update to authenticated
  using (get_user_role() = 'owner') with check (get_user_role() = 'owner');

-- Realtime juga memantau perubahan (UPDATE) agar perangkat lain ikut segar
-- (tabel sudah terdaftar di publication sejak SQL awal; baris di bawah aman diabaikan jika sudah ada)
do $$ begin
  alter publication supabase_realtime add table pm_kuitansi;
exception when duplicate_object then null; end $$;
