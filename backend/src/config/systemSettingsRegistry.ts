import { z } from 'zod';

type StringRule = z.ZodType<string, z.ZodTypeDef, string>;

const booleanString = z.enum(['true', 'false']);
const registrationMode = z.enum(['open', 'approval', 'closed']);
const theme = z.enum(['light', 'dark', 'system']);
const integerString = (minimum: number, maximum: number, label: string): StringRule =>
  z.string()
    .trim()
    .refine((value) => /^\d+$/.test(value), `${label} must be a whole number`)
    .refine((value) => {
      const parsed = Number(value);
      return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum;
    }, `${label} must be between ${minimum} and ${maximum}`)
    .transform((value) => String(Number(value)));

const boundedText = (minimum: number, maximum: number, label: string): StringRule =>
  z.string().trim().min(minimum, `${label} is required`).max(maximum, `${label} is too long`);

const optionalBoundedText = (maximum: number, label: string): StringRule =>
  z.string().trim().max(maximum, `${label} is too long`);

const httpUrl = (options: { allowEmpty?: boolean; allowRelative?: boolean; label: string }): StringRule =>
  z.string().trim().max(2048, `${options.label} is too long`).superRefine((value, ctx) => {
    if (!value && options.allowEmpty) return;
    if (options.allowRelative && value.startsWith('/') && !value.startsWith('//')) return;
    try {
      const parsed = new URL(value);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
        throw new Error('unsupported URL');
      }
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${options.label} must be ${options.allowRelative ? 'a same-origin path or ' : ''}an http(s) URL without embedded credentials`,
      });
    }
  });

const modelName = z.string().trim().max(200, 'Model name is too long').refine(
  (value) => value === '' || /^[a-zA-Z0-9][a-zA-Z0-9:._/-]*$/.test(value),
  'Model name contains unsupported characters',
);

const remoteDesktopPrefixes = z.string().trim().max(1024).superRefine((value, ctx) => {
  const prefixes = value.split(',').map((entry) => entry.trim()).filter(Boolean);
  if (!prefixes.length || prefixes.some((entry) => (
    entry === '/'
    || !entry.startsWith('/')
    || entry.startsWith('//')
    || entry.includes('..')
    || /[?#\\\u0000-\u001f\u007f]/.test(entry)
  ))) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Remote Desktop prefixes must be comma-separated non-root same-origin path segments without traversal, query, fragment, backslash, or control characters',
    });
  }
}).transform((value) => value.split(',')
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => entry.length > 1 && entry.endsWith('/') ? entry.slice(0, -1) : entry)
  .join(','));

const exactRules: Record<string, StringRule> = {
  'appearance.theme': theme,
  'appearance.logoUrl': httpUrl({ allowEmpty: true, allowRelative: true, label: 'Logo URL' }),
  'appearance.portalName': boundedText(1, 80, 'Portal name'),
  'appearance.assistantName': boundedText(1, 80, 'Assistant name'),
  'appearance.accentColor': z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, 'Accent color must be a six-digit hex color').transform((value) => value.toLowerCase()),

  'notifications.newRegistration': booleanString,
  'notifications.userApproved': booleanString,
  'notifications.systemAlerts': booleanString,
  'notifications.passwordChange': booleanString,
  'notifications.newDeviceLogin': booleanString,

  'security.registrationMode': registrationMode,
  'security.maxLoginAttempts': integerString(1, 100, 'Maximum login attempts'),
  'security.sessionDurationHours': integerString(1, 8760, 'Session duration'),
  'security.sandboxDefaultEnabled': booleanString,
  'security.blockClosedRegistration': booleanString,

  'system.allowTelemetry': booleanString,
  'system.backupPath': boundedText(1, 4096, 'Backup path'),

  'remoteDesktop.url': httpUrl({ allowEmpty: true, allowRelative: true, label: 'Remote Desktop URL' }),
  'remoteDesktop.allowedPathPrefixes': remoteDesktopPrefixes,

  'smtp.host': optionalBoundedText(255, 'SMTP host'),
  'smtp.port': integerString(1, 65535, 'SMTP port'),
  'smtp.secure': booleanString,
  'smtp.user': optionalBoundedText(512, 'SMTP username'),
  'smtp.password': z.string().max(4096, 'SMTP password is too long'),
  'smtp.fromName': optionalBoundedText(128, 'SMTP sender name'),
  'smtp.fromEmail': z.string().trim().max(320).refine((value) => value === '' || z.string().email().safeParse(value).success, 'SMTP sender email is invalid'),

  'ollama.localEnabled': booleanString,
  'ollama.defaultModel': modelName,
};

const providerAvatarKey = /^appearance\.agentAvatar\.(OPENCLAW|CLAUDE_CODE|CODEX|GROK|AGENT_ZERO|GEMINI|OLLAMA)$/;
const ollamaTierKey = /^ollama\.local\.tier\.(snappy|smart|best)$/;
const avatarRule = httpUrl({ allowEmpty: true, allowRelative: true, label: 'Agent avatar URL' });

function resolveRule(key: string): StringRule | undefined {
  if (exactRules[key]) return exactRules[key];
  if (providerAvatarKey.test(key)) return avatarRule;
  if (ollamaTierKey.test(key)) return modelName;
  return undefined;
}

export const ADMIN_SETTINGS_SECRET_KEYS = new Set(['smtp.password']);

export function isAdminEditableSettingKey(key: string): boolean {
  return Boolean(resolveRule(key));
}

/**
 * Parse the OWNER settings patch at the API boundary. Unknown/dead keys fail
 * closed so a stale frontend cannot create placebo configuration rows.
 */
export function parseAdminSettingsPatch(input: unknown): Record<string, string> {
  const base = z.record(z.string(), z.string()).safeParse(input);
  if (!base.success) throw base.error;

  const entries = Object.entries(base.data);
  if (entries.length === 0) {
    throw new z.ZodError([{ code: z.ZodIssueCode.custom, path: [], message: 'At least one setting is required' }]);
  }
  if (entries.length > 64) {
    throw new z.ZodError([{ code: z.ZodIssueCode.custom, path: [], message: 'Too many settings in one request' }]);
  }

  const output: Record<string, string> = {};
  const issues: z.ZodIssue[] = [];
  for (const [requestedKey, rawValue] of entries) {
    const key = requestedKey === 'registrationMode' ? 'security.registrationMode' : requestedKey;
    const rule = resolveRule(key);
    if (!rule) {
      issues.push({
        code: z.ZodIssueCode.custom,
        path: [requestedKey],
        message: `Unknown or non-editable setting: ${requestedKey}`,
      });
      continue;
    }

    const parsed = rule.safeParse(rawValue);
    if (!parsed.success) {
      issues.push(...parsed.error.issues.map((issue) => ({
        ...issue,
        path: [requestedKey, ...issue.path],
      })));
      continue;
    }

    if (Object.prototype.hasOwnProperty.call(output, key) && output[key] !== parsed.data) {
      issues.push({
        code: z.ZodIssueCode.custom,
        path: [requestedKey],
        message: `Conflicting values were provided for ${key}`,
      });
      continue;
    }
    output[key] = parsed.data;
  }

  if (issues.length) throw new z.ZodError(issues);
  return output;
}
