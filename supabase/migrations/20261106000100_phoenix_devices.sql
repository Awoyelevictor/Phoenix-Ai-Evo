-- Phoenix cloud device registry.
-- The cloud API uses a server-side Supabase secret key; client apps never access this table directly.

create table if not exists public.phoenix_devices (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    name text not null check (char_length(name) between 1 and 80),
    platform text not null check (platform in ('android', 'windows', 'web')),
    credential_hash text not null unique,
    created_at timestamptz not null default now(),
    last_seen_at timestamptz,
    revoked_at timestamptz
);

create index if not exists phoenix_devices_user_created_idx
    on public.phoenix_devices (user_id, created_at desc);

create index if not exists phoenix_devices_active_idx
    on public.phoenix_devices (id)
    where revoked_at is null;

alter table public.phoenix_devices enable row level security;

-- No direct client access. The API enforces the authenticated user's ownership
-- before making server-side operations with the secret key.
revoke all on table public.phoenix_devices from anon, authenticated;
grant usage on schema public to service_role;
grant select, insert, update, delete on table public.phoenix_devices to service_role;
