/**
 * Types for API key authentication and audit logging.
 */

/** A row in the api_keys table. */
export interface ApiKey {
  id: string;
  name: string;
  key_hash: string;
  /** null = all locations, [] = explicitly no locations, [a,b,...] = scoped */
  allowed_locations: string[] | null;
  created_at: string;
  last_used_at: string | null;
  revoked: boolean;
}

/** Public-safe view of an API key (no hash). */
export interface ApiKeyPublic {
  id: string;
  name: string;
  allowed_locations: string[] | null;
  created_at: string;
  last_used_at: string | null;
  revoked: boolean;
}

/** Audit log row. */
export interface AuditEntry {
  api_key_id: string | null;
  api_key_name: string | null;
  location_id: string | null;
  tool_name: string | null;
  success: boolean;
  error_message: string | null;
  duration_ms: number | null;
}

/** Attached to req after auth middleware succeeds. */
export interface AuthenticatedRequestContext {
  keyId: string;
  keyName: string;
  allowedLocations: string[] | null;
}
