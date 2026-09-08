export type UnqualifiedNativeBinaryProvider = 'GEMINI' | 'GROK';

export const UNQUALIFIED_NATIVE_BINARY_PROVIDERS = Object.freeze([
  'GEMINI',
  'GROK',
] as const satisfies readonly UnqualifiedNativeBinaryProvider[]);

export const UNQUALIFIED_NATIVE_BINARY_TOOL_IDS = Object.freeze(new Set([
  'gemini',
  'grok-build',
]));

const PROVIDER_NAMES: Readonly<Record<UnqualifiedNativeBinaryProvider, string>> = Object.freeze({
  GEMINI: 'Google Antigravity',
  GROK: 'Grok Build',
});

export const NATIVE_BINARY_QUALIFICATION_CODE = 'NATIVE_BINARY_RUNTIME_UNQUALIFIED';

export function isNativeBinaryProvider(provider: string): provider is UnqualifiedNativeBinaryProvider {
  return (UNQUALIFIED_NATIVE_BINARY_PROVIDERS as readonly string[]).includes(provider);
}

export function isUnqualifiedNativeBinaryProvider(
  provider: string,
): boolean {
  return isNativeBinaryProvider(provider)
    && (process.platform !== 'linux' || process.arch !== 'x64');
}

export function isUnqualifiedNativeBinaryToolId(toolId: string): boolean {
  return UNQUALIFIED_NATIVE_BINARY_TOOL_IDS.has(toolId)
    && (process.platform !== 'linux' || process.arch !== 'x64');
}

export function unqualifiedNativeBinaryReason(provider: UnqualifiedNativeBinaryProvider): string {
  return `${PROVIDER_NAMES[provider]} Host Operator chats are supported on Linux x86-64 with the Portal-tested CLI. `
    + 'Project Sandbox execution is not available for this harness.';
}

export class NativeBinaryRuntimeUnqualifiedError extends Error {
  readonly code = NATIVE_BINARY_QUALIFICATION_CODE;
  readonly statusCode = 503;
  readonly retryable = false;
  readonly provider: UnqualifiedNativeBinaryProvider;

  constructor(provider: UnqualifiedNativeBinaryProvider) {
    super(unqualifiedNativeBinaryReason(provider));
    this.name = 'NativeBinaryRuntimeUnqualifiedError';
    this.provider = provider;
  }
}
