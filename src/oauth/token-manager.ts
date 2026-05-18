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
