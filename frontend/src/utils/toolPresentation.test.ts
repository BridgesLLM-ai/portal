import { describe, it, expect } from 'vitest';
import { canonicalToolName, getToolPresentation, getToolSummary, isAskQuestionTool } from './toolPresentation';

describe('native tool presentation', () => {
  it.each([
    ['tools.openclaw_direct__exec', 'exec'], ['functions.read', 'read'], ['mcp__brave__web_search', 'search'],
    ['openclaw:show_widget', 'widget'], ['tools.openclaw__progress_card', 'progress'],
    ['functions__ask_user', 'question'], ['openclaw__automations', 'schedule'],
    ['openclaw__create_goal', 'goal'], ['openclaw__dashboard', 'dashboard'], ['openclaw_direct__computer', 'browser'],
  ])('maps %s to a useful native glyph', (name, kind) => expect(getToolPresentation(name).key).toBe(kind));
  it('keeps BridgesLLM branding on our tools and invoked guides, not unrelated file reads', () => {
    expect(getToolPresentation('mcp__bridgesllm__search').key).toBe('bridgesllm');
    expect(getToolPresentation('tools.openclaw__read', { path: '/root/agent/workshop-skills/bridgesllm-portal/SKILL.md' }).key).toBe('bridgesllm');
    expect(getToolPresentation('read', { path: '/workspace/bridgesllm/data.json' }).key).toBe('read');
    expect(getToolPresentation('notbridgesllm__search').key).toBe('search');
  });
  it('recognizes a namespaced native question as interactive, not an inert pill', () => {
    expect(isAskQuestionTool('tools.openclaw__ask_user')).toBe(true);
    expect(isAskQuestionTool('mcp__notes__read')).toBe(false);
    expect(canonicalToolName('functions.AskUserQuestion')).toBe('ask_user_question');
    expect(getToolSummary({ name: 'openclaw__show_widget', arguments: { title: 'Counter' } })).toBe('Show Counter');
  });
});
