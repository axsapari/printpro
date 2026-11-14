-- ================================================================
-- 004_nomor_kuitansi_unik.sql — PrintManager Pro
-- Tujuan: memastikan SATU nomor kuitansi tidak bisa dipakai dua kali.
--
-- Kenapa perlu: sebelumnya kolom `no` tidak punya aturan unik, sehingga dua
-- perangkat yang menyimpan pada saat hampir bersamaan bisa menghasilkan nomor
-- kembar — dan keduanya tersimpan tanpa error.
--
-- CARA PAKAI: Supabase → SQL Editor → tempel seluruh isi → Run.
-- Aman dijalankan berulang (idempoten).
--
-- ⚠ Bila sudah ada nomor kembar, skrip ini menggeser nomor yang LEBIH BARU
--   (berdasarkan timestamp, lalu id) menjadi "<nomor>-2", "<nomor>-3", dst.
--   Perubahan itu tercatat di tabel pm_nomor_audit dan di kolom diubah_at /
--   diubah_oleh, jadi akan terlihat juga di halaman Riwayat.
--   Sebelum menjalankan, disarankan membuat backup dari menu Backup.
-- ================================================================

begin;

-- ---------------------------------------------------------------
-- 0. Pastikan kolom jejak perubahan ada (sama seperti sql/003),
--    karena skrip ini mengisinya saat mengganti nomor.
-- ---------------------------------------------------------------
alter table pm_kuitansi add column if not exists diubah_at   timestamptz;
alter table pm_kuitansi add column if not exists diubah_oleh text;

-- ---------------------------------------------------------------
-- 1. Catatan perubahan nomor (agar penggantian otomatis bisa ditelusuri)
-- ---------------------------------------------------------------
create table if not exists pm_nomor_audit (
  id        bigint primary key,
  no_lama   text,
  no_baru   text,
  alasan    text,
  diubah_at timestamptz not null default now()
);
-- Tertutup untuk akses langsung dari aplikasi/anon; dibaca lewat SQL Editor.
alter table pm_nomor_audit enable row level security;

-- ---------------------------------------------------------------
-- 2. Rapikan nomor kembar yang sudah terlanjur ada.
--    Nomor untuk baris terlama dipertahankan; baris berikutnya diberi sufiks.
-- ---------------------------------------------------------------
do $$
declare
  r    record;
  urut int;
  baru text;
  jml  int := 0;
begin
  for r in
    select id, no
    from (
      select id,
             no,
             row_number() over (
               partition by upper(btrim(no))
               order by coalesce(timestamp, now()), id
             ) as rn
      from pm_kuitansi
      where no is not null and btrim(no) <> ''
    ) t
    where rn > 1
    order by no, id
  loop
    urut := 2;
    loop
      baru := btrim(r.no) || '-' || urut;
      exit when not exists (
        select 1 from pm_kuitansi where upper(btrim(no)) = upper(baru)
      );
      urut := urut + 1;
    end loop;

    update pm_kuitansi
       set no          = baru,
           diubah_at   = now(),
           diubah_oleh = 'migrasi 004'
     where id = r.id;

    insert into pm_nomor_audit (id, no_lama, no_baru, alasan)
    values (
      (extract(epoch from clock_timestamp()) * 1000)::bigint + (random() * 1000)::int,
      r.no, baru, 'nomor duplikat saat migrasi 004'
    );

    jml := jml + 1;
    raise notice 'Nomor digeser: % -> %', r.no, baru;
  end loop;

  if jml = 0 then
    raise notice 'Tidak ada nomor kembar. Aman.';
  else
    raise notice '% nomor digeser. Cek halaman Riwayat untuk kuitansi bertanda "Diubah".', jml;
  end if;
end $$;

-- ---------------------------------------------------------------
-- 3. Penjaga sebenarnya: unique index.
--    - Memakai upper(btrim(no)) supaya "kwt-11-001" dan "KWT-11-001 "
--      dianggap nomor yang sama.
--    - Nomor kosong / NULL dikecualikan agar data lama tanpa nomor
--      tidak saling bertabrakan.
--    - Kode error 23505 dari index inilah yang ditangani aplikasi
--      (auto-geser nomor lalu simpan ulang sekali lagi).
-- ---------------------------------------------------------------
create unique index if not exists pm_kuitansi_no_uniq
  on pm_kuitansi (upper(btrim(no)))
  where no is not null and btrim(no) <> '';

commit;

-- ---------------------------------------------------------------
-- 4. Verifikasi — hasil harus KOSONG (tidak ada nomor kembar).
-- ---------------------------------------------------------------
select upper(btrim(no)) as nomor, count(*) as jumlah
from pm_kuitansi
where no is not null and btrim(no) <> ''
group by 1
having count(*) > 1;

-- ---------------------------------------------------------------
-- 5. Bila ternyata ada nomor yang baru digeser, lihat daftarnya:
-- ---------------------------------------------------------------
-- select * from pm_nomor_audit order by diubah_at desc;
