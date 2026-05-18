/**
 * Supabase wrappers for api_keys and api_audit tables.
 * Uses the same getClient() pattern as oauth/supabase-client to share connections.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { createHash, randomBytes } from 'node:crypto';
import { ApiKey, ApiKeyPublic, AuditEntry } from './types';

let _client: SupabaseClient | null = null;

function getClient(): SupabaseClient {
  if (_client) return _client;
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !serviceKey) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY env vars.');
  }
  _client = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _client;
}

/** SHA-256 hex of a raw API key. We never store raw keys. */
export function hashApiKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex');
}

/**
 * Generate a new random API key.
 * Format: `imk_<43-char base64url>` (32 bytes of entropy).
 * The prefix makes leaked keys easy to grep for.
 */
export function generateRawApiKey(): string {
  const bytes = randomBytes(32);
  const b64 = bytes
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `imk_${b64}`;
}

/**
 * Create a new API key row. Returns the raw key (only time it's ever
 * visible) plus the public metadata.
 */
export async function createApiKey(
  name: string,
  allowedLocations: string[] | null
): Promise<{ raw: string; publicView: ApiKeyPublic }> {
  const supabase = getClient();
  const raw = generateRawApiKey();
  const hash = hashApiKey(raw);

  const { data, error } = await supabase
    .from('api_keys')
    .insert({
      name,
      key_hash: hash,
      allowed_locations: allowedLocations,
    })
    .select('id, name, allowed_locations, created_at, last_used_at, revoked')
    .single();

  if (error || !data) {
    throw new Error(`Failed to create API key: ${error?.message ?? 'unknown'}`);
  }
  return { raw, publicView: data as ApiKeyPublic };
}

/** List all keys (public view — no hashes). */
export async function listApiKeys(): Promise<ApiKeyPublic[]> {
  const supabase = getClient();
  const { data, error } = await supabase
    .from('api_keys')
    .select('id, name, allowed_locations, created_at, last_used_at, revoked')
    .order('created_at', { ascending: false });
  if (error) throw new Error(`Failed to list keys: ${error.message}`);
  return (data ?? []) as ApiKeyPublic[];
}

/** Look up a key by its raw value. Returns null if not found or revoked. */
export async function getApiKeyByRaw(rawKey: string): Promise<ApiKey | null> {
  if (!rawKey.startsWith('imk_')) return null; // cheap reject
  const hash = hashApiKey(rawKey);
  const supabase = getClient();
  const { data, error } = await supabase
    .from('api_keys')
    .select('*')
    .eq('key_hash', hash)
    .maybeSingle();
  if (error) throw new Error(`Failed to look up key: ${error.message}`);
  if (!data) return null;
  const row = data as ApiKey;
  if (row.revoked) return null;
  return row;
}

/** Mark a key as revoked. */
export async function revokeApiKey(id: string): Promise<void> {
  const supabase = getClient();
  const { error } = await supabase
    .from('api_keys')
    .update({ revoked: true })
    .eq('id', id);
  if (error) throw new Error(`Failed to revoke key: ${error.message}`);
}

/** Update last_used_at — fire and forget. */
export function touchApiKey(id: string): void {
  const supabase = getClient();
  supabase
    .from('api_keys')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', id)
    .then(({ error }) => {
      if (error) console.error('[auth] touchApiKey failed:', error.message);
    });
}

/** Append an audit entry. Fire and forget — never throws. */
export function writeAuditEntry(entry: AuditEntry): void {
  const supabase = getClient();
  supabase
    .from('api_audit')
    .insert(entry)
    .then(({ error }) => {
      if (error) console.error('[auth] writeAuditEntry failed:', error.message);
    });
}

/** Recent audit entries — admin only. */
export async function listAuditEntries(opts: {
  limit?: number;
  locationId?: string;
  apiKeyId?: string;
}): Promise<any[]> {
  const supabase = getClient();
  let q = supabase
    .from('api_audit')
    .select('*')
    .order('occurred_at', { ascending: false })
    .limit(opts.limit ?? 100);
  if (opts.locationId) q = q.eq('location_id', opts.locationId);
  if (opts.apiKeyId) q = q.eq('api_key_id', opts.apiKeyId);
  const { data, error } = await q;
  if (error) throw new Error(`Failed to list audit: ${error.message}`);
  return data ?? [];
}
