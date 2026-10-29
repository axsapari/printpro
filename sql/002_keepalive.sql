-- ================================================================
-- 002_keepalive.sql — PrintManager Pro
-- Fungsi "ping" kecil agar project Supabase free tier tidak ter-pause
-- karena jarang dipakai. Dipanggil terjadwal oleh GitHub Actions
-- (.github/workflows/keepalive.yml) lewat scripts/keepalive.mjs.
--
-- CARA PAKAI: Supabase → SQL Editor → tempel seluruh isi → Run.
-- Aman dijalankan ulang.
-- ================================================================

create table if not exists pm_heartbeat (
  id        int primary key default 1 check (id = 1),
  last_ping timestamptz not null default now()
);

-- Tanpa policy: tabel ini tertutup untuk akses langsung dari browser.
alter table pm_heartbeat enable row level security;

-- Satu-satunya jalan masuk: fungsi ini (hanya mencatat waktu sekarang).
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
grant execute on function ping_keepalive() to anon, authenticated;

-- Uji manual (harus mengembalikan waktu sekarang):
--   select ping_keepalive();
