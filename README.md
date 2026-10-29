# PrintManager Pro

Aplikasi manajemen percetakan (kuitansi, modal, untung-rugi, log, backup) berbasis HTML + JavaScript + Supabase. Tanpa proses build: cukup di-hosting sebagai file statis (Vercel, GitHub Pages, dll).

## Struktur

```
index.html          kerangka halaman
css/style.css       tampilan
js/config.js        daftar akun (tanpa password) + skema SQL untuk setup wizard
js/app.js           seluruh logika aplikasi
sql/                migrasi database untuk Supabase SQL Editor (001 peran, 002 keep-alive, 003 edit/batal/piutang)
scripts/keepalive.mjs   ping terjadwal agar Supabase tidak ter-pause
.github/workflows/      jadwal GitHub Actions untuk keep-alive
```

## Pemasangan baru

1. Buat project Supabase. Isi `url` dan `key` (kunci **anon/publishable**) pada `SUPABASE_DEFAULT` di `js/config.js`, sehingga perangkat mana pun langsung terhubung tanpa mengisi apa-apa. (Jika dikosongkan, aplikasi menampilkan wizard setup per perangkat.)
2. Jalankan SQL yang ditampilkan wizard di Supabase SQL Editor.
3. Buat akun di **Authentication → Users → Add user** (centang *Auto Confirm User*) dengan email:
   `admin@printmanager.local`, `agus@printmanager.local`, `arko@printmanager.local`.
   Password dibuat sendiri dan **jangan** ditulis di kode atau repo.
4. Jalankan kembali bagian **5. BERI PERAN** pada SQL (memberi peran lewat `app_metadata`).
5. Matikan pendaftaran publik: Authentication → Sign In / Providers → nonaktifkan *Allow new users to sign up*.

## Mencegah Supabase ter-pause

Project Supabase free tier dijeda otomatis setelah sekitar 7 hari tanpa aktivitas. Untuk mencegahnya:

1. Jalankan `sql/002_keepalive.sql` di Supabase SQL Editor (membuat fungsi `ping_keepalive()`).
2. Pastikan `SUPABASE_DEFAULT` di `js/config.js` sudah terisi.
3. Workflow `.github/workflows/keepalive.yml` berjalan otomatis Senin & Kamis (jeda terpanjang 4 hari). Uji manual: tab **Actions → Supabase keep-alive → Run workflow**.

Catatan: GitHub menonaktifkan workflow terjadwal di repo publik yang tidak ada aktivitas 60 hari; workflow ini membuat 1 commit kosong bila repo sepi lebih dari 45 hari. Sebagai lapis cadangan, bisa dipakai pinger gratis (mis. cron-job.org) dengan `POST <URL>/rest/v1/rpc/ping_keepalive`, header `apikey` dan `Authorization: Bearer <anon key>`, body `{}`.
Project yang sudah terlanjur ter-pause dapat dipulihkan lewat tombol *Restore* di dashboard Supabase.

## Database yang sudah berjalan

Jalankan `sql/001_amankan_role.sql` di Supabase SQL Editor, lalu minta semua pengguna logout dan login ulang.

## Edit, pembatalan, dan piutang (SQL 003)

Jalankan `sql/003_edit_batal_piutang.sql` di Supabase SQL Editor (aman dijalankan ulang). Fitur (semua perubahan **khusus owner** dan tercatat di Log Aktivitas):

- **Edit kuitansi**: tombol ✏️ Edit di Riwayat membuka formulir; log mencatat apa yang berubah (mis. total Rp 100.000 → Rp 250.000).
- **Batalkan / Pulihkan**: pembatalan wajib beralasan. Kuitansi batal tetap tersimpan, bertanda DIBATALKAN, dan tidak dihitung di pemasukan, laba rugi, grafik, jumlah order, maupun piutang.
- **DP & piutang**: status DP meminta jumlah dibayar; struk/PDF menampilkan Dibayar dan Sisa. Dashboard menampilkan *Piutang Belum Lunas*, Riwayat punya filter Piutang/Dibatalkan, dan tombol ✔ Lunas menandai pelunasan.
- Pemasukan tetap dihitung **saat kuitansi dibuat**; DP/sisa hanya pencatatan piutang.
- Sebelum SQL 003 dijalankan, kuitansi biasa tetap bisa disimpan; fitur baru menampilkan petunjuk untuk menjalankan SQL 003.

## Riwayat kuitansi

Riwayat punya pencarian (nomor, pelanggan, alamat, catatan, status), filter tanggal dari–sampai, filter jenis (termasuk Piutang/Dibatalkan), dan halaman 20 data. Urutan: tanggal terbaru dulu.

## Tema tampilan

Tombol **Tema** di sidebar membuka pilihan 7 tema: Gelap (bawaan), Terang, Samudra, Hutan, Senja, Kopi, dan Langit. Pilihan tersimpan per perangkat. Struk dan PDF kuitansi selalu putih agar siap cetak. Tema baru cukup ditambah di `TEMA` (`js/app.js`) dan blok `html[data-tema="..."]` di `css/style.css`, serta daftar tema terang di skrip kecil pada `<head>` `index.html`.

## Keamanan

- Peran (`admin` / `owner`) dibaca dari `app_metadata` di token login, bukan dari `user_metadata` (yang bisa diubah pengguna sendiri).
- Hak akses sebenarnya dijaga oleh Row Level Security di database; menu yang disembunyikan di browser hanya tampilan.
- Jangan pernah menaruh password atau service-role key di repo. Anon key boleh publik karena dibatasi RLS. Aplikasi dan skrip keep-alive menolak kunci `service_role` / `sb_secret_`.
