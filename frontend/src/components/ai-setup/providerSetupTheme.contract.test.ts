import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const providerSetupSources = {
  claude: readFileSync(new URL('./SetupTokenFlow.tsx', import.meta.url), 'utf8'),
  bedrock: readFileSync(new URL('./AwsSdkSetupFlow.tsx', import.meta.url), 'utf8'),
  agentZero: readFileSync(new URL('../settings/AgentZeroOAuthPanel.tsx', import.meta.url), 'utf8'),
};

const darkOnlyNeutralUtilities = [
  /\bbg-slate-(?:700|800|900|950)(?:\/[^\s"']+)?\b/,
  /\bbg-black\/(?:10|15|20|25|30)\b/,
  /\bbg-white(?:\/[^\s"']+)?\b/,
  /\btext-white\b/,
  /\btext-slate-(?:100|200|300|400|500|600|900)\b/,
  /\bborder-slate-(?:600|700|800)\b/,
  /\bborder-white(?:\/[^\s"']+)?\b/,
];

describe('provider setup theme contract', () => {
  it.each(Object.entries(providerSetupSources))(
    'keeps %s neutral surfaces on semantic light/dark tokens',
    (_name, source) => {
      expect(source).toContain('bg-theme-surface');
      expect(source).toContain('border-theme-border');
      expect(source).toContain('text-theme-text');

      for (const forbiddenUtility of darkOnlyNeutralUtilities) {
        expect(source).not.toMatch(forbiddenUtility);
      }

      // Light-mode status overrides target the base hue class. Keep opacity as
      // a separate utility so warning/success copy does not fall back to a
      // pale dark-theme color on a light tinted card.
      expect(source).not.toMatch(/\btext-(?:red|amber|emerald|blue|violet|sky)-\d+\/\d+\b/);
    },
  );

  it('retains the deliberately dark modal scrim without using it for content cards', () => {
    expect(providerSetupSources.claude).toContain('bg-black/50 p-4 backdrop-blur-sm');
    expect(providerSetupSources.bedrock).toContain('bg-black/50 p-4 backdrop-blur-sm');
    expect(providerSetupSources.agentZero).not.toContain('bg-black/');
  });

  it('preserves status-specific warning, error, and success tones', () => {
    expect(providerSetupSources.claude).toContain('border-red-500/25 bg-red-500/10');
    expect(providerSetupSources.bedrock).toContain('border-amber-500/25 bg-amber-500/10');
    expect(providerSetupSources.bedrock).toContain('border-emerald-500/20 bg-emerald-500/10');
    expect(providerSetupSources.agentZero).toContain('border-red-500/20 bg-red-500/10');
    expect(providerSetupSources.agentZero).toContain('border-emerald-500/20 bg-emerald-500/10');
  });
});
