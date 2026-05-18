/**
 * Express routes for the OAuth install flow.
 *
 *   GET  /oauth/install   → redirect the user to GHL's marketplace consent screen
 *   GET  /oauth/callback  → GHL redirects here with ?code=, we exchange for tokens
 *   GET  /oauth/locations → list installed sub-accounts (handy for debugging)
 */

import { Router, Request, Response, RequestHandler } from 'express';
import { exchangeCodeForTokens, persistToken } from './token-manager';
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

    // GHL's /oauth/chooselocation endpoint only works for agency-distribution
    // apps. For Sub-Account distribution apps it just dumps the user at the
    // dashboard. The reliable cross-distribution-type entry point is the
    // marketplace listing page itself — GHL's own Install button there
    // routes through the correct OAuth flow for whatever distribution type
    // is configured on the app.
    //
    // The marketplace app ID is the part of the client_id before the dash.
    // e.g. "6a0ae77f03a61082247120da-mpb23zpr" -> "6a0ae77f03a61082247120da"
    const appId = clientId.split('-')[0];
    const installUrl = `https://marketplace.gohighlevel.com/apps/${appId}`;
    res.redirect(installUrl);
  };

  /**
   * Step 2 of the install flow.
   * GHL redirected the user here with ?code=... We exchange that code for
   * access + refresh tokens, then store them in Supabase.
   */
  const callbackHandler: RequestHandler = async (req, res) => {
    const code = req.query.code as string | undefined;
    const error = req.query.error as string | undefined;

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
