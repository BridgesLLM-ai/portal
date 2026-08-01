import dotenv from 'dotenv';
import { DEFAULT_OLLAMA_MODEL } from '../utils/ollamaRecommendations';
import { normalizeAgentZeroProjectSandboxImageId } from '../agents/providers/agentZero/AgentZeroProjectImage';
import { resolveLocalOllamaEndpoint } from '../utils/localOllamaEndpoint';

dotenv.config();

export const config = {
  // Server
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000', 10),
  // Loopback by default: external access is Caddy's job (TLS, headers). A
  // 0.0.0.0 default left every install one firewall mistake away from a raw
  // exposed portal. Set HOST explicitly for setups that need a wider bind.
  host: process.env.HOST || '127.0.0.1',

  // JWT
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-key',
  jwtExpiration: process.env.JWT_EXPIRATION || '24h',
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret',
  jwtRefreshExpiration: process.env.JWT_REFRESH_EXPIRATION || '7d',
  updateProbeToken: process.env.PORTAL_UPDATE_PROBE_TOKEN || '',

  // Database
  databaseUrl: process.env.DATABASE_URL,

  // Ollama
  // Raw environment URLs are legacy inputs, not network authority. Until the
  // Tailnet binding protocol exists, every backend consumer stays on the
  // installer-owned loopback endpoint.
  ollamaApiUrl: resolveLocalOllamaEndpoint(
    process.env.OLLAMA_API_URL,
    process.env.OLLAMA_HOST,
  ),
  // Central catalog fallback when no DB setting or installed model wins.
  ollamaModel: process.env.OLLAMA_MODEL || DEFAULT_OLLAMA_MODEL,

  // OpenClaw
  openclawApiUrl: process.env.OPENCLAW_API_URL || 'http://localhost:18789',
  openclawProjectSandboxImageId: process.env.OPENCLAW_PROJECT_SANDBOX_IMAGE_ID || '',
  codexProjectSandboxImageId: process.env.CODEX_PROJECT_SANDBOX_IMAGE_ID || '',
  claudeCodeProjectSandboxImageId: process.env.CLAUDE_CODE_PROJECT_SANDBOX_IMAGE_ID || '',
  antigravityProjectSandboxImageId: process.env.ANTIGRAVITY_PROJECT_SANDBOX_IMAGE_ID || '',
  ollamaProjectSandboxImageId: process.env.OLLAMA_PROJECT_SANDBOX_IMAGE_ID || '',
  agentZeroProjectSandboxImageId: process.env.AGENT_ZERO_PROJECT_SANDBOX_IMAGE_ID || '',
  portalProjectRuntimeImageId: process.env.PORTAL_PROJECT_RUNTIME_IMAGE_ID || '',

  // Project Sandbox egress. Both values are installer-owned and intentionally
  // independent from JWT/cookie signing secrets.
  projectEgressProxyImageId: process.env.PROJECT_EGRESS_PROXY_IMAGE_ID || '',
  projectEgressTokenSecret: process.env.PROJECT_EGRESS_TOKEN_SECRET || '',

  // File uploads
  maxFileSize: parseInt(process.env.MAX_FILE_SIZE || '524288000', 10), // 500MB
  uploadDir: process.env.UPLOAD_DIR || '/portal/files',

  // CORS
  corsOrigin: (process.env.CORS_ORIGIN || 'http://localhost:3000').split(','),

  // Rate limiting
  rateLimitWindowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10),
  rateLimitMaxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100', 10),
};


if (config.nodeEnv === 'production' && (!process.env.JWT_SECRET || config.jwtSecret === 'dev-secret-key')) {
  throw new Error('FATAL: JWT_SECRET must be set in production.');
}

if (config.nodeEnv === 'production' && (!process.env.JWT_REFRESH_SECRET || config.jwtRefreshSecret === 'dev-refresh-secret')) {
  // Auto-generate a refresh secret if missing — old installs may not have it.
  // This is safe because refresh tokens signed with the old default are already insecure.
  const crypto = require('crypto');
  config.jwtRefreshSecret = crypto.randomBytes(32).toString('hex');
  console.warn('[SECURITY] JWT_REFRESH_SECRET not set — generated ephemeral secret. Add JWT_REFRESH_SECRET to .env.production for persistence across restarts.');
}

if (config.agentZeroProjectSandboxImageId
  && !normalizeAgentZeroProjectSandboxImageId(config.agentZeroProjectSandboxImageId)) {
  throw new Error(
    'AGENT_ZERO_PROJECT_SANDBOX_IMAGE_ID must be an installer-attested derived Docker sha256 image ID, not the raw upstream manifest digest',
  );
}

for (const [label, imageId] of [
  ['OPENCLAW_PROJECT_SANDBOX_IMAGE_ID', config.openclawProjectSandboxImageId],
  ['CODEX_PROJECT_SANDBOX_IMAGE_ID', config.codexProjectSandboxImageId],
  ['CLAUDE_CODE_PROJECT_SANDBOX_IMAGE_ID', config.claudeCodeProjectSandboxImageId],
  ['ANTIGRAVITY_PROJECT_SANDBOX_IMAGE_ID', config.antigravityProjectSandboxImageId],
  ['OLLAMA_PROJECT_SANDBOX_IMAGE_ID', config.ollamaProjectSandboxImageId],
  ['AGENT_ZERO_PROJECT_SANDBOX_IMAGE_ID', config.agentZeroProjectSandboxImageId],
  ['PORTAL_PROJECT_RUNTIME_IMAGE_ID', config.portalProjectRuntimeImageId],
  ['PROJECT_EGRESS_PROXY_IMAGE_ID', config.projectEgressProxyImageId],
] as const) {
  if (imageId && !/^sha256:[a-f0-9]{64}$/i.test(imageId)) {
    throw new Error(`${label} must be an immutable Docker sha256 image ID`);
  }
}

if (config.projectEgressTokenSecret && !/^[A-Za-z0-9_-]{43,256}$/.test(config.projectEgressTokenSecret)) {
  throw new Error('PROJECT_EGRESS_TOKEN_SECRET must be a base64url secret containing at least 256 bits');
}

// Validate required env vars
if (!config.databaseUrl) {
  throw new Error('DATABASE_URL environment variable is required');
}
