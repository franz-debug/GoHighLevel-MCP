/**
 * Express middleware for authenticating requests to /mcp, /sse, /oauth/install,
 * and /oauth/locations. Validates a Bearer or ?api_key= token against the
 * api_keys table, enforces per-key location scoping, and stamps request
 * context onto req for downstream handlers.
 *
 * Endpoints that must remain public (not wrapped by this):
 *   - /health         (Railway healthchecks)
 *   - /oauth/callback (GHL calls this directly with the auth code)
 *   - /admin/*        (uses a separate ADMIN_API_KEY env var, see admin-routes)
 */

import { RequestHandler } from 'express';
import { getApiKeyByRaw, touchApiKey } from './key-storage';
import { AuthenticatedRequestContext } from './types';

/**
 * Extract the API key from an incoming request.
 * Accepts (in priority order):
 *   1. Authorization: Bearer <key>
 *   2. X-API-Key: <key>
 *   3. ?api_key=<key>      ← fallback for connector URLs that can't set headers
 */
function extractKey(req: import('express').Request): string | null {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }
  const headerKey = req.headers['x-api-key'];
  if (typeof headerKey === 'string' && headerKey.length > 0) return headerKey;
  if (typeof req.query.api_key === 'string' && req.query.api_key.length > 0) {
    return req.query.api_key;
  }
  return null;
}

/**
 * Augment Express Request type so downstream handlers can read req.auth.
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      apiAuth?: AuthenticatedRequestContext;
    }
  }
}

/**
 * The actual middleware. Rejects unauthenticated/unauthorized requests
 * with 401/403 + a small JSON body.
 */
export const requireApiKey: RequestHandler = async (req, res, next) => {
  const raw = extractKey(req);
  if (!raw) {
    res.status(401).json({
      error: 'missing_api_key',
      message:
        'Provide an API key via Authorization: Bearer <key>, X-API-Key header, or ?api_key= query param.',
    });
    return;
  }

  let key;
  try {
    key = await getApiKeyByRaw(raw);
  } catch (err: any) {
    console.error('[auth] key lookup failed:', err?.message);
    res.status(500).json({ error: 'auth_lookup_failed' });
    return;
  }

  if (!key) {
    res.status(401).json({ error: 'invalid_or_revoked_key' });
    return;
  }

  // If a location_id is being requested, enforce per-key scoping.
  const requestedLocation =
    (req.query.location_id as string | undefined) ||
    (req.body && typeof req.body === 'object' && 'location_id' in req.body
      ? String((req.body as any).location_id)
      : undefined);

  if (requestedLocation && key.allowed_locations !== null) {
    if (!key.allowed_locations.includes(requestedLocation)) {
      res.status(403).json({
        error: 'location_not_allowed',
        message: `Key "${key.name}" is not authorized for location ${requestedLocation}.`,
      });
      return;
    }
  }

  // Attach context for downstream handlers (audit logging in particular).
  req.apiAuth = {
    keyId: key.id,
    keyName: key.name,
    allowedLocations: key.allowed_locations,
  };

  // Update last_used_at asynchronously — don't block the request.
  touchApiKey(key.id);

  next();
};
