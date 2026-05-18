-- ghl_tokens table — one row per installed GHL sub-account
-- Run this once in Supabase: SQL Editor → New Query → paste → Run.

create table if not exists public.ghl_tokens (
  location_id text primary key,
  company_id text,
  access_token text not null,
  refresh_token text not null,
  expires_at timestamptz not null,
  user_type text not null,
  location_name text,
  updated_at timestamptz not null default now()
);

-- Index for sorting installed locations by recency
create index if not exists ghl_tokens_updated_at_idx
  on public.ghl_tokens (updated_at desc);

-- Disable Row Level Security — the MCP server is the only client
-- and it uses the service_role key. RLS would block our own writes.
alter table public.ghl_tokens disable row level security;
