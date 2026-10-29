# PrintManager Pro

Aplikasi manajemen percetakan (kuitansi, modal, untung-rugi, log, backup) berbasis HTML + JavaScript + Supabase. Tanpa proses build: cukup di-hosting sebagai file statis (Vercel, GitHub Pages, dll).

## Struktur

```
index.html          kerangka halaman
css/style.css       tampilan
js/config.js        daftar akun (tanpa password) + skema SQL untuk setup wizard
js/app.js           seluruh logika aplikasi
sql/                migrasi database untuk Supabase SQL Editor
```

## Pemasangan baru

1. Buat project Supabase, lalu buka aplikasi dan masukkan Project URL + anon key.
2. Jalankan SQL yang ditampilkan wizard di Supabase SQL Editor.
3. Buat akun di **Authentication → Users → Add user** (centang *Auto Confirm User*) dengan email:
   `admin@printmanager.local`, `agus@printmanager.local`, `arko@printmanager.local`.
   Password dibuat sendiri dan **jangan** ditulis di kode atau repo.
4. Jalankan kembali bagian **5. BERI PERAN** pada SQL (memberi peran lewat `app_metadata`).
5. Matikan pendaftaran publik: Authentication → Sign In / Providers → nonaktifkan *Allow new users to sign up*.

## Database yang sudah berjalan

Jalankan `sql/001_amankan_role.sql` di Supabase SQL Editor, lalu minta semua pengguna logout dan login ulang.

## Keamanan

- Peran (`admin` / `owner`) dibaca dari `app_metadata` di token login, bukan dari `user_metadata` (yang bisa diubah pengguna sendiri).
- Hak akses sebenarnya dijaga oleh Row Level Security di database; menu yang disembunyikan di browser hanya tampilan.
- Jangan pernah menaruh password atau service-role key di repo. Anon key boleh publik karena dibatasi RLS.
