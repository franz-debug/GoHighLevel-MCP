/**
 * Express routes for the OAuth install flow.
 *
 *   GET  /oauth/install   → redirect the user to GHL's marketplace consent screen
 *   GET  /oauth/callback  → GHL redirects here with ?code=, we exchange for tokens
 *   GET  /oauth/locations → list installed sub-accounts (handy for debugging)
 */

import { Router, Request, Response, RequestHandler } from 'express';
import {
  exchangeCodeForTokens,
  exchangeCodeForAgencyTokens,
  persistToken,
  backfillAllLocations,
  BackfillResult,
} from './token-manager';
import { listLocations } from './supabase-client';

/**
 * Build the absolute redirect_uri based on either the configured BASE_URL
 * env var (used in production on Railway) or the inbound request host
 * (used during local dev). It MUST exactly match one of the redirect URIs
 * registered in the GHL Marketplace app, or GHL will reject the exchange.
 */
function getRedirectUri(req: Request): string {
  const explicit = process.env.OAUTH_REDIRECT_URI;
  if (explicit) return explicit;

  const protocol = (req.headers['x-forwarded-proto'] as string) || req.protocol;
  const host = (req.headers['x-forwarded-host'] as string) || req.get('host');
  return `${protocol}://${host}/oauth/callback`;
}

export function createOAuthRouter(): Router {
  const router = Router();

  /**
   * Step 1 of the install flow.
   * Sends the user to GHL's consent page. After they pick a sub-account
   * and click Authorize, GHL redirects them back to /oauth/callback.
   */
  const installHandler: RequestHandler = (req, res) => {
    const clientId = process.env.GHL_CLIENT_ID;
    if (!clientId) {
      res.status(500).send('Server misconfigured: GHL_CLIENT_ID missing.');
      return;
    }

    // Two install modes:
    //   - default: per-sub-account install (one OAuth code -> one location token)
    //   - ?as=agency: agency-level install (one OAuth code -> agency token ->
    //     auto-backfill location tokens for every sub-account where the app
    //     is installed). This is the bulk-import path.
    const asAgency = req.query.as === 'agency';

    const redirectUri = getRedirectUri(req);
    const appId = clientId.split('-')[0];
    const versionId = process.env.GHL_VERSION_ID || appId;

    // Match the exact scope set your GHL app actually has registered.
    // Overridable via GHL_SCOPES env var (space-separated list) for flexibility.
    // Default uses the scope list extracted from the app's auto-generated
    // install URL — these are the scopes you selected when configuring the app.
    const defaultScopes = [
      'contacts.readonly', 'contacts.write',
      'conversations.readonly', 'conversations.write',
      'conversations/message.readonly', 'conversations/message.write',
      'conversations/reports.readonly', 'conversations/livechat.write',
      'opportunities.readonly', 'opportunities.write',
      'calendars.readonly', 'calendars.write',
      'calendars/events.readonly', 'calendars/events.write',
      'calendars/groups.readonly', 'calendars/groups.write',
      'calendars/resources.readonly', 'calendars/resources.write',
      'businesses.readonly', 'businesses.write',
      'campaigns.readonly',
      'companies.readonly',
      'forms.readonly', 'forms.write',
      'links.readonly', 'links.write',
      'locations.readonly', 'locations.write',
      'locations/customFields.readonly', 'locations/customFields.write',
      'locations/customValues.readonly', 'locations/customValues.write',
      'locations/tasks.readonly', 'locations/tasks.write',
      'locations/tags.readonly', 'locations/tags.write',
      'locations/templates.readonly',
      'medias.readonly', 'medias.write',
      'products.readonly', 'products.write',
      'products/prices.readonly', 'products/prices.write',
      'snapshots.readonly', 'snapshots.write',
      'users.readonly', 'users.write',
      'workflows.readonly',
    ];
    const scope = (process.env.GHL_SCOPES || defaultScopes.join(' '));

    const url = new URL('https://marketplace.gohighlevel.com/v2/oauth/chooselocation');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', scope);
    url.searchParams.set('version_id', versionId);
    // state is preserved across the OAuth round-trip; we use it to know
    // which exchange flow to run when the code comes back.
    if (asAgency) url.searchParams.set('state', 'agency');

    res.redirect(url.toString());
  };

  /**
   * Step 2 of the install flow.
   * GHL redirected the user here with ?code=... We exchange that code for
   * access + refresh tokens, then store them in Supabase.
   */
  const callbackHandler: RequestHandler = async (req, res) => {
    const code = req.query.code as string | undefined;
    const error = req.query.error as string | undefined;
    const state = req.query.state as string | undefined;
    const isAgencyInstall = state === 'agency';

    if (error) {
      res.status(400).send(`<h1>Install cancelled</h1><p>GHL returned: ${error}</p>`);
      return;
    }
    if (!code) {
      res.status(400).send('<h1>Missing ?code parameter</h1>');
      return;
    }

    try {
      const redirectUri = getRedirectUri(req);

      // AGENCY-LEVEL INSTALL: exchange for Company token, then bulk-backfill
      if (isAgencyInstall) {
        const agencyTokens = await exchangeCodeForAgencyTokens(code, redirectUri);
        const result: BackfillResult = await backfillAllLocations(agencyTokens);

        res.send(`
          <html>
            <head><title>Agency install complete</title></head>
            <body style="font-family: -apple-system, sans-serif; max-width: 720px; margin: 60px auto; padding: 0 20px;">
              <h1>Agency install complete</h1>
              <p><strong>Company ID:</strong> <code>${agencyTokens.companyId}</code></p>
              <h2>Backfill result</h2>
              <ul>
                <li><strong>Total locations enumerated:</strong> ${result.total}</li>
                <li><strong>Successfully tokenized:</strong> ${result.succeeded}</li>
                <li><strong>Failed:</strong> ${result.failed.length}</li>
              </ul>
              ${
                result.failed.length > 0
                  ? `<details><summary>Failures (${result.failed.length})</summary><pre>${JSON.stringify(result.failed, null, 2)}</pre></details>`
                  : ''
              }
              <p>To see all installed sub-accounts, visit <a href="/oauth/locations">/oauth/locations</a>.</p>
            </body>
          </html>
        `);
        return;
      }

      // PER-SUB-ACCOUNT INSTALL: existing single-location flow
      const tokens = await exchangeCodeForTokens(code, redirectUri);
      await persistToken(tokens);

      res.send(`
        <html>
          <head><title>Install complete</title></head>
          <body style="font-family: -apple-system, sans-serif; max-width: 560px; margin: 60px auto; padding: 0 20px;">
            <h1>Sub-account installed</h1>
            <p>The MCP server now has access to:</p>
            <ul>
              <li><strong>Location ID:</strong> <code>${tokens.locationId}</code></li>
              <li><strong>Company ID:</strong> <code>${tokens.companyId}</code></li>
              <li><strong>User type:</strong> ${tokens.userType}</li>
              <li><strong>Token expires:</strong> in ${tokens.expires_in} seconds (will auto-refresh)</li>
            </ul>
            <p>To install another sub-account, visit <a href="/oauth/install">/oauth/install</a> again.</p>
            <p>To see all installed sub-accounts, visit <a href="/oauth/locations">/oauth/locations</a>.</p>
          </body>
        </html>
      `);
    } catch (err: any) {
      console.error('[OAuth] Callback failed:', err?.response?.data || err);
      res
        .status(500)
        .send(
          `<h1>Token exchange failed</h1><pre>${
            err?.response?.data ? JSON.stringify(err.response.data, null, 2) : err?.message
          }</pre>`
        );
    }
  };

  /**
   * Debugging convenience: list installed sub-accounts.
   */
  const locationsHandler: RequestHandler = async (_req, res) => {
    try {
      const rows = await listLocations();
      res.json({ count: rows.length, locations: rows });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? 'Unknown error' });
    }
  };

  router.get('/oauth/install', installHandler);
  router.get('/oauth/callback', callbackHandler);
  router.get('/oauth/locations', locationsHandler);

  return router;
}
