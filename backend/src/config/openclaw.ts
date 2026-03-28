const DEFAULT_OPENCLAW_API_URL = 'http://localhost:18789';

export function getOpenClawApiUrl(): string {
  return process.env.OPENCLAW_API_URL || process.env.OPENCLAW_GATEWAY_URL || DEFAULT_OPENCLAW_API_URL;
}

export function getOpenClawWsUrl(): string {
  return getOpenClawApiUrl().replace(/^http/, 'ws');
}
