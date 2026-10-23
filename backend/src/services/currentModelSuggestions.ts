/** Candidate ordering from the official vendor model docs and the native runtime catalog
 * (2026-10-20). This is guidance, never entitlement or dispatch authority. */
const candidates: readonly [string, string][] = [
  ['openai/gpt-6.1-sol', 'Coding and everyday work'],
  ['openai/gpt-6-astra', 'Demanding, long-running work'],
  ['openai/gpt-6-sol', 'General-purpose GPT-6 work'],
  ['openai/gpt-6-luna', 'Lower-cost GPT-6 work'],
  ['anthropic/claude-sonnet-5-5', 'Balanced Claude work'],
  ['anthropic/claude-opus-5-5', 'Complex coding and reasoning'],
  ['anthropic/claude-fable-5-1', 'Demanding Claude work'],
  ['anthropic/claude-haiku-5-5', 'Fast, lower-cost Claude work'],
  ['google/gemini-4-argon', 'Current Gemini API work'],
];
export function suggestReadyModels(models: readonly { id: string; ready: boolean }[]): Array<{ id: string; reason: string }> {
  const ready = new Set(models.filter(model => model.ready === true).map(model => model.id));
  return candidates.filter(([id]) => ready.has(id)).map(([id, reason]) => ({ id, reason }));
}
