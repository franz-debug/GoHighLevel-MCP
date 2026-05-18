-- Run this once in Supabase: SQL Editor → New Query → paste → Run.
-- (Choose "Run and enable RLS" if prompted — service_role bypasses RLS
-- so our server keeps working, and the anon key will be locked out.)

create extension if not exists "pgcrypto";

-- API keys for users/agents authorized to use the MCP server.
-- One row per issued key. We store only the SHA-256 hash of the key,
-- never the raw value — the raw key is shown ONCE at creation time.
create table if not exists public.api_keys (
  id uuid primary key default gen_random_uuid(),
  name text not null,                    -- human label: "Ranier / Manus"
  key_hash text not null unique,         -- sha256(key) hex
  allowed_locations text[],              -- null = all locations, [] = none
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked boolean not null default false
);

create index if not exists api_keys_key_hash_idx on public.api_keys (key_hash);
create index if not exists api_keys_revoked_idx on public.api_keys (revoked);

-- Append-only audit log of every MCP tool call.
create table if not exists public.api_audit (
  id bigserial primary key,
  occurred_at timestamptz not null default now(),
  api_key_id uuid references public.api_keys(id) on delete set null,
  api_key_name text,
  location_id text,
  tool_name text,
  success boolean,
  error_message text,
  duration_ms integer
);

create index if not exists api_audit_occurred_at_idx on public.api_audit (occurred_at desc);
create index if not exists api_audit_key_idx on public.api_audit (api_key_id);
create index if not exists api_audit_location_idx on public.api_audit (location_id);

-- RLS enabled with no policies = service_role only.
alter table public.api_keys enable row level security;
alter table public.api_audit enable row level security;
