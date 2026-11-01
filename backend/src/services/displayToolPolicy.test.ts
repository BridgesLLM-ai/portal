import { diagnoseDisplayToolPolicy, type DisplayToolFinding } from './displayToolPolicy';

const agent = (tools: Record<string, unknown>, global: Record<string, unknown> = {}) => ({
  tools: global,
  agents: { entries: { main: { tools } } },
});
const hidden = (findings: DisplayToolFinding[]) => Object.fromEntries(findings.map(f => [f.tool, `${f.kind} ${f.setting}${f.entry ? ` "${f.entry}"` : ''}`]));
const AGENT = 'agents.entries.main.tools';

describe('display tool policy diagnostic (read-only)', () => {
  test.each([
    ['no policy at all', {}, {}],
    ['an implicit agent with no roster entry', { tools: {} }, {}],
    ['an allow list that names every display tool', agent({ allow: ['read', 'show_widget', 'progress_card', 'ask_user'] }), {}],
    ['an allow list without them', agent({ allow: ['read', 'exec'] }), {
      show_widget: `allow ${AGENT}.allow`, progress_card: `allow ${AGENT}.allow`, ask_user: `allow ${AGENT}.allow` }],
    ['alsoAllow adds what the allow list leaves out', agent({ allow: ['read'] }, { alsoAllow: ['show_widget', 'progress_card', 'ask_user'] }), {}],
    ['an agent alsoAllow without an allow list hides nothing', agent({ alsoAllow: ['read'] }), {}],
    ['groups in the allow list', agent({ allow: ['group:ui', 'group:agents'] }), {}],
    ['group:openclaw in the allow list', agent({ allow: ['group:openclaw'] }), {}],
    ['aliases in the allow list', agent({ allow: ['canvas', 'update_plan'] }), { ask_user: `allow ${AGENT}.allow` }],
    ['a wildcard allow', agent({ allow: ['*'] }), {}],
    ['a glob allow that matches concrete names', agent({ allow: ['show_*', '*_card', 'ask_*'] }), {}],
    ['a glob allow does not match group names', agent({ allow: ['group:*'] }), {
      show_widget: `allow ${AGENT}.allow`, progress_card: `allow ${AGENT}.allow`, ask_user: `allow ${AGENT}.allow` }],
    ['an empty allow list turns every tool off', agent({ allow: [] }), {
      show_widget: `empty-allow ${AGENT}.allow`, progress_card: `empty-allow ${AGENT}.allow`, ask_user: `empty-allow ${AGENT}.allow` }],
    ['a global allow applies when the agent has none', agent({}, { allow: ['read', 'ask_user'] }), {
      show_widget: 'allow tools.allow', progress_card: 'allow tools.allow' }],
    ['an agent allow list replaces the global one', agent({ allow: ['group:openclaw'] }, { allow: ['read'] }), {}],
    ['a literal canvas deny hides widgets', agent({}, { deny: ['canvas'] }), { show_widget: 'deny tools.deny "canvas"' }],
    ['a group:ui deny hides widgets only', agent({ deny: ['group:ui'] }), { show_widget: `deny ${AGENT}.deny "group:ui"` }],
    ['a group:openclaw deny hides all three', agent({ deny: ['Group:OpenClaw'] }), {
      show_widget: `deny ${AGENT}.deny "Group:OpenClaw"`, progress_card: `deny ${AGENT}.deny "Group:OpenClaw"`,
      ask_user: `deny ${AGENT}.deny "Group:OpenClaw"` }],
    ['a glob deny', agent({ deny: ['*_user'] }), { ask_user: `deny ${AGENT}.deny "*_user"` }],
    ['a deny wins over an allow', agent({ allow: ['show_widget', 'progress_card', 'ask_user'], deny: ['update_plan'] }), {
      progress_card: `deny ${AGENT}.deny "update_plan"` }],
    ['a provider deny is reported with its provider', agent({}, { byProvider: { 'openai/gpt-5.4': { deny: ['show_widget'] } } }), {
      show_widget: 'deny tools.byProvider.openai/gpt-5.4.deny "show_widget"' }],
    ['another agent\'s policy is not this agent\'s', { agents: { entries: { other: { tools: { deny: ['*'] } } } } }, {}],
  ])('%s', (_label, config, expected) => {
    expect(hidden(diagnoseDisplayToolPolicy(config, 'main'))).toEqual(expected);
  });

  test('unreadable shapes claim nothing', () => {
    for (const config of [null, 'text', [], { tools: [] }, { agents: { entries: { main: { tools: 'x' } } } }]) {
      expect(diagnoseDisplayToolPolicy(config, 'main')).toEqual([]);
    }
  });
});
