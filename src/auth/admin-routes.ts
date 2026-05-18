/**
 * Admin endpoints for minting and revoking API keys.
 * Authenticated separately from the user-facing /mcp endpoints via the
 * ADMIN_API_KEY environment variable.
 *
 *   POST   /admin/keys            — create a new key (returns raw key ONCE)
 *   GET    /admin/keys            — list keys (metadata only, no raw values)
 *   POST   /admin/keys/:id/revoke — revoke a key
 *   GET    /admin/audit           — recent audit log entries
 */

import { Router, RequestHandler } from 'express';
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  listAuditEntries,
} from './key-storage';

/**
 * Admin auth: simple bearer-token comparison against ADMIN_API_KEY env var.
 * Constant-time-ish (we use string equality here; for a tiny admin surface
 * with a single secret, timing attacks are not a practical concern).
 */
const requireAdmin: RequestHandler = (req, res, next) => {
  const expected = process.env.ADMIN_API_KEY;
  if (!expected) {
    res.status(500).json({
      error: 'admin_disabled',
      message: 'ADMIN_API_KEY env var is not set. Admin endpoints are disabled.',
    });
    return;
  }
  const auth = req.headers['authorization'];
  const provided =
    (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')
      ? auth.slice(7).trim()
      : null) ||
    (typeof req.headers['x-admin-key'] === 'string'
      ? (req.headers['x-admin-key'] as string)
      : null);

  if (!provided || provided !== expected) {
    res.status(401).json({ error: 'invalid_admin_credentials' });
    return;
  }
  next();
};

export function createAdminRouter(): Router {
  const router = Router();

  // All /admin/* routes require admin auth.
  router.use('/admin', requireAdmin);

  // POST /admin/keys
  // Body: { "name": "Ranier / Manus", "allowed_locations": ["loc1","loc2"] | null }
  router.post('/admin/keys', async (req, res) => {
    try {
      const { name, allowed_locations } = (req.body ?? {}) as {
        name?: string;
        allowed_locations?: string[] | null;
      };
      if (!name || typeof name !== 'string') {
        res.status(400).json({ error: 'name_required' });
        return;
      }
      if (
        allowed_locations !== undefined &&
        allowed_locations !== null &&
        !Array.isArray(allowed_locations)
      ) {
        res.status(400).json({ error: 'allowed_locations_must_be_array_or_null' });
        return;
      }
      const { raw, publicView } = await createApiKey(
        name,
        allowed_locations ?? null
      );
      res.status(201).json({
        ...publicView,
        key: raw,
        warning:
          'This is the only time the raw key will be shown. Store it securely.',
      });
    } catch (err: any) {
      console.error('[admin] create key failed:', err?.message);
      res.status(500).json({ error: 'create_failed', message: err?.message });
    }
  });

  // GET /admin/keys
  router.get('/admin/keys', async (_req, res) => {
    try {
      const keys = await listApiKeys();
      res.json({ count: keys.length, keys });
    } catch (err: any) {
      res.status(500).json({ error: 'list_failed', message: err?.message });
    }
  });

  // POST /admin/keys/:id/revoke
  router.post('/admin/keys/:id/revoke', async (req, res) => {
    try {
      await revokeApiKey(req.params.id);
      res.json({ revoked: true, id: req.params.id });
    } catch (err: any) {
      res.status(500).json({ error: 'revoke_failed', message: err?.message });
    }
  });

  // GET /admin/audit?limit=100&location_id=X&api_key_id=Y
  router.get('/admin/audit', async (req, res) => {
    try {
      const entries = await listAuditEntries({
        limit: req.query.limit ? Number(req.query.limit) : 100,
        locationId: req.query.location_id as string | undefined,
        apiKeyId: req.query.api_key_id as string | undefined,
      });
      res.json({ count: entries.length, entries });
    } catch (err: any) {
      res.status(500).json({ error: 'audit_failed', message: err?.message });
    }
  });

  return router;
}
