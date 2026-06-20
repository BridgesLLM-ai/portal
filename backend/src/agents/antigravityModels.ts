import { execFileSync } from 'child_process';

export interface AntigravityModelDescriptor {
  id: string;
  displayName: string;
}

let cachedModelList: { expiresAt: number; models: AntigravityModelDescriptor[] } | null = null;

function slugifyModelName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\bgpt oss\b/g, 'gpt-oss')
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function parseAntigravityModelList(output: string): AntigravityModelDescriptor[] {
  const models = new Map<string, AntigravityModelDescriptor>();

  for (const rawLine of String(output || '').split(/\r?\n/)) {
    const displayName = rawLine.trim();
    if (!displayName || !/^Gemini\b/i.test(displayName)) continue;

    const match = displayName.match(/^(.+?)(?:\s+\((Low|Medium|High|Thinking)\))?$/i);
    const base = slugifyModelName(match?.[1] || displayName);
    const tier = String(match?.[2] || '').trim().toLowerCase();
    if (!base) continue;

    const id = tier && tier !== 'medium' && tier !== 'thinking'
      ? `${base}-${tier}`
      : base;

    if (!models.has(id)) {
      models.set(id, { id, displayName });
    }
  }

  return Array.from(models.values());
}

export function listAntigravityModelsFromCli(): AntigravityModelDescriptor[] {
  if (cachedModelList && cachedModelList.expiresAt > Date.now()) {
    return cachedModelList.models;
  }

  try {
    const output = execFileSync('agy', ['models'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NO_COLOR: '1',
        SSH_CONNECTION: process.env.SSH_CONNECTION || 'portal-model-discovery 127.0.0.1 127.0.0.1 0',
      },
      timeout: 10000,
      maxBuffer: 1024 * 1024 * 2,
    });
    const models = parseAntigravityModelList(output);
    cachedModelList = { models, expiresAt: Date.now() + 60_000 };
    return models;
  } catch {
    cachedModelList = { models: [], expiresAt: Date.now() + 5_000 };
    return [];
  }
}
