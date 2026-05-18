/**
 * Per-request context using Node's AsyncLocalStorage.
 *
 * When an MCP request comes in over SSE, we extract the location_id from
 * the connection URL and store it in this context. The GHL API client's
 * axios interceptor reads the active context to know which OAuth token
 * to attach to outgoing requests.
 *
 * Because AsyncLocalStorage propagates through await, every nested call
 * inside the tool handler sees the same context without needing to thread
 * the location_id through every function signature.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  /** The GHL sub-account this request is targeting. */
  locationId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Run a function with the given context active.
 * All async code inside (and any awaited functions) can read it via
 * getRequestContext().
 */
export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/**
 * Read the currently active request context.
 * Returns undefined if called outside of any runWithContext.
 */
export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * Convenience: get just the locationId, or throw if no context is active.
 * Use this inside code paths that REQUIRE OAuth context (vs. legacy paths
 * that might be running with a static GHL_API_KEY).
 */
export function getActiveLocationId(): string | undefined {
  return storage.getStore()?.locationId;
}
