/**
 * Centralized OpenClaw Gateway Token Resolution
 * 
 * Single source of truth for the gateway auth token.
 * All backend code should import getGatewayToken() from here
 * instead of reading process.env.OPENCLAW_GATEWAY_TOKEN directly.
 * 
 * Resolution order:
 *   1. ~/.openclaw/openclaw.json → gateway.auth.token (LIVE source of truth)
 *   2. process.env.OPENCLAW_GATEWAY_TOKEN (fallback if config missing)
 * 
 * openclaw.json is checked FIRST because `openclaw onboard` may change the
 * token after the portal starts. The env var is a stale snapshot from boot time.
 * Re-reads on every call (no caching) so changes are picked up without restart.
 */

import fs from 'fs';
import path from 'path';

const OC_CONFIG_PATH = path.join(process.env.HOME || '/root', '.openclaw', 'openclaw.json');

/**
 * Resolve the gateway token dynamically.
 * Call this every time you need the token — never cache the result at module scope.
 */
export function getGatewayToken(): string {
  // Primary: read from openclaw.json — the live, canonical source
  // This picks up changes from `openclaw onboard` without portal restart
  try {
    if (fs.existsSync(OC_CONFIG_PATH)) {
      const config = JSON.parse(fs.readFileSync(OC_CONFIG_PATH, 'utf8'));
      const token = config?.gateway?.auth?.token;
      if (token) return token;
    }
  } catch {
    // Fall through to env var
  }

  // Fallback: env var (stale snapshot from portal boot, but better than nothing)
  return process.env.OPENCLAW_GATEWAY_TOKEN || '';
}

/**
 * Check if ANY gateway token is available (env or config file).
 */
export function hasGatewayToken(): boolean {
  return getGatewayToken().length > 0;
}
