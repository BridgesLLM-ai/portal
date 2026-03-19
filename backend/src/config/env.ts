import dotenv from 'dotenv';

dotenv.config();

export const config = {
  // Server
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000', 10),
  host: process.env.HOST || '0.0.0.0',

  // JWT
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-key',
  jwtExpiration: process.env.JWT_EXPIRATION || '24h',
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret',
  jwtRefreshExpiration: process.env.JWT_REFRESH_EXPIRATION || '7d',

  // Database
  databaseUrl: process.env.DATABASE_URL,

  // Ollama
  ollamaApiUrl: process.env.OLLAMA_API_URL || 'http://127.0.0.1:11434',
  ollamaModel: process.env.OLLAMA_MODEL || 'qwen2.5-coder:7b',

  // OpenClaw
  openclawApiUrl: process.env.OPENCLAW_API_URL || 'http://localhost:18789',

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

// Validate required env vars
if (!config.databaseUrl) {
  throw new Error('DATABASE_URL environment variable is required');
}
