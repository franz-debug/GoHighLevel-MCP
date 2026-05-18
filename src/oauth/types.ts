/**
 * Types for OAuth token storage and management.
 */

/**
 * The shape of a row in the `ghl_tokens` table in Supabase.
 * One row per installed sub-account (location).
 */
export interface StoredToken {
  /** GHL location (sub-account) ID — primary key */
  location_id: string;
  /** GHL company (agency) ID */
  company_id: string | null;
  /** OAuth access token — used for API calls. Short-lived (~24h). */
  access_token: string;
  /** OAuth refresh token — used to get new access tokens. Long-lived. */
  refresh_token: string;
  /** ISO timestamp when access_token expires */
  expires_at: string;
  /** "Location" or "Company" — tells us the install scope */
  user_type: string;
  /** Human-friendly name we can display in logs */
  location_name?: string | null;
  /** ISO timestamp of when this row was last updated */
  updated_at: string;
}

/**
 * The response from GHL's OAuth token endpoint
 * (both for initial code exchange and refresh).
 */
export interface GHLTokenResponse {
  access_token: string;
  refresh_token: string;
  /** Seconds until access_token expires (typically 86400 = 24h) */
  expires_in: number;
  /** "Location" or "Company" */
  userType: string;
  /** The location (sub-account) this token grants access to */
  locationId: string;
  /** The company (agency) this location belongs to */
  companyId: string;
  /** OAuth scope string */
  scope: string;
  /** Token type, always "Bearer" */
  token_type: string;
}
