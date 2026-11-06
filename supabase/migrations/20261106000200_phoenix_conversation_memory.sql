-- Durable, per-user conversation history for Phoenix AI Evo.
create table if not exists public.phoenix_conversations (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    title text not null default 'New conversation' check (char_length(title) between 1 and 160),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    archived_at timestamptz
);
create index if not exists phoenix_conversations_user_updated_idx
    on public.phoenix_conversations (user_id, updated_at desc)
    where archived_at is null;
create table if not exists public.phoenix_messages (
    id uuid primary key default gen_random_uuid(),
    conversation_id uuid not null references public.phoenix_conversations(id) on delete cascade,
    user_id uuid not null references auth.users(id) on delete cascade,
    role text not null check (role in ('user', 'assistant', 'system')),
    content text not null check (char_length(content) between 1 and 24000),
    created_at timestamptz not null default now()
);
create index if not exists phoenix_messages_conversation_created_idx
    on public.phoenix_messages (conversation_id, created_at asc);
create index if not exists phoenix_messages_user_created_idx
    on public.phoenix_messages (user_id, created_at desc);
alter table public.phoenix_conversations enable row level security;
alter table public.phoenix_messages enable row level security;
revoke all on table public.phoenix_conversations from anon, authenticated;
revoke all on table public.phoenix_messages from anon, authenticated;
grant usage on schema public to service_role;
grant select, insert, update, delete on table public.phoenix_conversations to service_role;
grant select, insert, update, delete on table public.phoenix_messages to service_role;
