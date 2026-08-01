import type { ProviderModelDescriptor } from '../agents/providerModels';
import {
  ClaudeCodeProjectModelSelectionError,
  claudeCodeCliModelId,
  resolveClaudeCodeProjectModelFromCatalog,
} from './claudeCodeProjectModel';

const catalog: ProviderModelDescriptor[] = [{
  id: 'anthropic/claude-sonnet-4-6',
  alias: 'sonnet',
  provider: 'claude-code',
  displayName: 'Claude Sonnet 4.6',
  source: 'declared',
}];

describe('Claude Code Project model selection', () => {
  it('resolves only models in the authoritative declared catalog', () => {
    expect(resolveClaudeCodeProjectModelFromCatalog({
      catalog,
      candidates: [],
      explicitModel: 'sonnet',
    })).toBe('anthropic/claude-sonnet-4-6');
    expect(() => resolveClaudeCodeProjectModelFromCatalog({
      catalog,
      candidates: [],
      explicitModel: 'anthropic/claude-invented-99',
    })).toThrow(ClaudeCodeProjectModelSelectionError);
  });

  it('passes a provider-free model identity to the Claude CLI', () => {
    expect(claudeCodeCliModelId('anthropic/claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
  });
});
