/**
 * Token lifecycle: exchange OAuth code, refresh expired tokens,
 * and hand out a valid access_token for a given location.
 */

import axios from 'axios';
import { GHLTokenResponse, StoredToken } from './types';
import { getToken, saveToken } from './supabase-client';

const GHL_TOKEN_URL = 'https://services.leadconnectorhq.com/oauth/token';
/**
 * Refresh proactively when the token has less than this many seconds
 * left, so we never hand out a token that's about to die mid-request.
 */
const REFRESH_BUFFER_SECONDS = 300; // 5 minutes

/**
 * Exchange an OAuth authorization code for access + refresh tokens.
 * Called once per install, from /oauth/callback.
 */
export async function exchangeCodeForTokens(
  code: string,
  redirectUri: string
): Promise<GHLTokenResponse> {
  const clientId = process.env.GHL_CLIENT_ID;
  const clientSecret = process.env.GHL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('GHL_CLIENT_ID and GHL_CLIENT_SECRET must be set');
  }

  // GHL expects application/x-www-form-urlencoded for this endpoint
  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    user_type: 'Location', // Sub-account install
  });

  const { data } = await axios.post<GHLTokenResponse>(GHL_TOKEN_URL, params, {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
  });

  return data;
}

/**
 * Use a refresh token to get a fresh access token.
 * Called automatically when an access token is about to expire.
 */
export async function refreshAccessToken(
  refreshToken: string
): Promise<GHLTokenResponse> {
  const clientId = process.env.GHL_CLIENT_ID;
  const clientSecret = process.env.GHL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('GHL_CLIENT_ID and GHL_CLIENT_SECRET must be set');
  }

  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    user_type: 'Location',
  });

  const { data } = await axios.post<GHLTokenResponse>(GHL_TOKEN_URL, params, {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
  });

  return data;
}

/**
 * Persist a fresh token response to Supabase.
 * Computes expires_at = now + expires_in.
 */
export async function persistToken(
  resp: GHLTokenResponse,
  locationName?: string
): Promise<void> {
  const expiresAt = new Date(Date.now() + resp.expires_in * 1000).toISOString();

  await saveToken({
    location_id: resp.locationId,
    company_id: resp.companyId ?? null,
    access_token: resp.access_token,
    refresh_token: resp.refresh_token,
    expires_at: expiresAt,
    user_type: resp.userType,
    location_name: locationName ?? null,
  });
}

/**
 * Get a guaranteed-valid access token for a location.
 * Refreshes transparently if the stored one is expired or near-expiry.
 * Throws if the location isn't installed.
 *
 * This is THE function the API client calls before every request.
 */
export async function getValidAccessToken(locationId: string): Promise<string> {
  const stored = await getToken(locationId);
  if (!stored) {
    throw new Error(
      `No OAuth token found for location ${locationId}. ` +
        `Install the app for this sub-account by visiting /oauth/install.`
    );
  }

  // Is it still fresh?
  const expiresAtMs = new Date(stored.expires_at).getTime();
  const nowMs = Date.now();
  const secondsLeft = (expiresAtMs - nowMs) / 1000;

  if (secondsLeft > REFRESH_BUFFER_SECONDS) {
    return stored.access_token;
  }

  // Refresh it
  console.log(
    `[OAuth] Token for ${locationId} expires in ${Math.round(secondsLeft)}s — refreshing...`
  );
  const fresh = await refreshAccessToken(stored.refresh_token);
  await persistToken(fresh, stored.location_name ?? undefined);
  return fresh.access_token;
}


/**
 * Exchange an OAuth code for an Agency (Company) scope token.
 * Used when the user installs the app at agency level — required to
 * mint per-sub-account tokens via /oauth/locationToken later.
 */
export async function exchangeCodeForAgencyTokens(
  code: string,
  redirectUri: string
): Promise<GHLTokenResponse> {
  const clientId = process.env.GHL_CLIENT_ID;
  const clientSecret = process.env.GHL_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('GHL_CLIENT_ID and GHL_CLIENT_SECRET must be set');
  }

  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    user_type: 'Company', // Agency-level token
  });

  const { data } = await axios.post<GHLTokenResponse>(GHL_TOKEN_URL, params, {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
  });

  return data;
}

/**
 * Shape of one row returned by /oauth/installedLocations.
 */
export interface InstalledLocation {
  _id: string;
  name?: string;
  address?: string;
  isInstalled?: boolean;
}

/**
 * Enumerate all sub-accounts where this app is currently installed
 * for the given company (agency). Requires an Agency-scope access token.
 */
export async function listInstalledLocations(
  agencyAccessToken: string,
  companyId: string,
  appId: string
): Promise<InstalledLocation[]> {
  const out: InstalledLocation[] = [];
  let skip = 0;
  const limit = 100;

  // Page through results until we get fewer than `limit` back.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const url = new URL('https://services.leadconnectorhq.com/oauth/installedLocations');
    url.searchParams.set('companyId', companyId);
    url.searchParams.set('appId', appId);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('skip', String(skip));

    const { data } = await axios.get<{ locations: InstalledLocation[]; count?: number }>(
      url.toString(),
      {
        headers: {
          Authorization: `Bearer ${agencyAccessToken}`,
          Version: '2021-07-28',
          Accept: 'application/json',
        },
      }
    );

    const batch = data.locations ?? [];
    out.push(...batch);
    if (batch.length < limit) break;
    skip += limit;
    if (skip > 5000) break; // safety stop — 5000 sub-accounts is more than anyone should hit
  }

  return out;
}

/**
 * Mint a Location (sub-account) access token for the given locationId,
 * using the agency-scope token. Returns a GHLTokenResponse shape.
 */
export async function mintLocationTokenFromAgency(
  agencyAccessToken: string,
  companyId: string,
  locationId: string
): Promise<GHLTokenResponse> {
  const params = new URLSearchParams({
    companyId,
    locationId,
  });

  const { data } = await axios.post<GHLTokenResponse>(
    'https://services.leadconnectorhq.com/oauth/locationToken',
    params,
    {
      headers: {
        Authorization: `Bearer ${agencyAccessToken}`,
        Version: '2021-07-28',
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
    }
  );

  return data;
}

/**
 * Result of a bulk backfill operation.
 */
export interface BackfillResult {
  total: number;
  succeeded: number;
  failed: { locationId: string; error: string }[];
  locationIds: string[];
}

/**
 * Given an Agency-scope access token, enumerate every installed
 * sub-account and persist a Location-scope token for each.
 * Returns a summary of successes/failures.
 *
 * Concurrency: 5 in-flight mint calls at a time — fast enough to backfill
 * 200 accounts in ~30s but gentle on GHL's rate limits.
 */
export async function backfillAllLocations(agencyTokenResp: GHLTokenResponse): Promise<BackfillResult> {
  const clientId = process.env.GHL_CLIENT_ID;
  if (!clientId) throw new Error('GHL_CLIENT_ID must be set');
  const appId = clientId.split('-')[0];

  const locations = await listInstalledLocations(
    agencyTokenResp.access_token,
    agencyTokenResp.companyId,
    appId
  );

  const result: BackfillResult = {
    total: locations.length,
    succeeded: 0,
    failed: [],
    locationIds: [],
  };

  const concurrency = 5;
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < locations.length) {
      const loc = locations[cursor++];
      try {
        const tokenResp = await mintLocationTokenFromAgency(
          agencyTokenResp.access_token,
          agencyTokenResp.companyId,
          loc._id
        );
        await persistToken(tokenResp, loc.name ?? undefined);
        result.succeeded++;
        result.locationIds.push(loc._id);
      } catch (err: any) {
        const msg = err?.response?.data?.message || err?.message || 'unknown error';
        result.failed.push({ locationId: loc._id, error: String(msg).slice(0, 200) });
        process.stderr.write(
          `[OAuth] backfill failed for ${loc._id}: ${msg}\n`
        );
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return result;
}
