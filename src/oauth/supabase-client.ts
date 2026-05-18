/**
 * Supabase wrapper for storing and retrieving OAuth tokens.
 * One row per installed GHL sub-account, keyed by location_id.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { StoredToken } from './types';

let _client: SupabaseClient | null = null;

/**
 * Lazy-initialize the Supabase client so missing env vars only
 * blow up when someone actually tries to use it, not at import time.
 */
function getClient(): SupabaseClient {
  if (_client) return _client;

  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!url || !serviceKey) {
    throw new Error(
      'Missing SUPABASE_URL or SUPABASE_SERVICE_KEY env vars. ' +
        'Set them in Railway before the OAuth flow can store tokens.'
    );
  }

  _client = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _client;
}

/**
 * Upsert a token row (insert-or-update keyed by location_id).
 * Called after a successful OAuth exchange or token refresh.
 */
export async function saveToken(
  token: Omit<StoredToken, 'updated_at'>
): Promise<void> {
  const supabase = getClient();
  const row: StoredToken = {
    ...token,
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase
    .from('ghl_tokens')
    .upsert(row, { onConflict: 'location_id' });

  if (error) {
    throw new Error(`Failed to save token for ${token.location_id}: ${error.message}`);
  }
}

/**
 * Fetch the stored token for a given location_id.
 * Returns null if no row exists (sub-account not installed yet).
 */
export async function getToken(locationId: string): Promise<StoredToken | null> {
  const supabase = getClient();
  const { data, error } = await supabase
    .from('ghl_tokens')
    .select('*')
    .eq('location_id', locationId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to read token for ${locationId}: ${error.message}`);
  }
  return data as StoredToken | null;
}

/**
 * List all installed locations — useful for the /oauth/locations endpoint
 * and for Claude tools that need to know what's available.
 */
export async function listLocations(): Promise<
  Pick<StoredToken, 'location_id' | 'location_name' | 'company_id' | 'updated_at'>[]
> {
  const supabase = getClient();
  const { data, error } = await supabase
    .from('ghl_tokens')
    .select('location_id, location_name, company_id, updated_at')
    .order('updated_at', { ascending: false });

  if (error) {
    throw new Error(`Failed to list locations: ${error.message}`);
  }
  return data ?? [];
}
