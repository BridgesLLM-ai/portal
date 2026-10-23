import { describe, expect, it } from 'vitest';
import {
  buildActivityUnits,
  carriesInteractiveOutput,
  selectNewestActivityUnits,
  standaloneToolReason,
  summarizeActivityGroup,
  type ActivityEntry,
  type ActivityTool,
  type ActivityUnit,
} from './toolActivityModel';

type Tool = ActivityTool & { startedAt: number };

function tool(id: string, name = 'read', status: Tool['status'] = 'done', extra: Partial<Tool> = {}): Tool {
  return { id, name, status, startedAt: 1, arguments: { path: `/workspace/${id}.ts` }, ...extra };
}

const t = (value: Tool): ActivityEntry<Tool, string> => ({ kind: 'tool', tool: value });
const prose = (key: string): ActivityEntry<Tool, string> => ({ kind: 'boundary', key, value: key, prose: true });
const thinking = (key: string): ActivityEntry<Tool, string> => ({ kind: 'boundary', key, value: key, prose: false });

function shape(units: ActivityUnit<Tool, string>[]): string[] {
  return units.map((unit) => {
    if (unit.kind === 'boundary') return `|${unit.key}|`;
    if (unit.kind === 'tool') return unit.reason ? `${unit.tool.id}!${unit.reason}` : unit.tool.id;
    return `[${unit.tools.map((member) => member.id).join(',')}]`;
  });
}

/** Every tool object, in order, exactly once: grouping is presentation only. */
function flattenTools(units: ActivityUnit<Tool, string>[]): Tool[] {
  return units.flatMap((unit) => (unit.kind === 'group' ? unit.tools : unit.kind === 'tool' ? [unit.tool] : []));
}

describe('tool activity units', () => {
  it('groups consecutive ordinary calls and keeps a lone call as its plain card', () => {
    const units = buildActivityUnits([t(tool('a')), t(tool('b')), t(tool('c')), prose('p1'), t(tool('d'))]);
    expect(shape(units)).toEqual(['[a,b,c]', '|p1|', 'd']);
    expect(units[0]).toMatchObject({ kind: 'group', key: 'group:a' });
  });

  it('never crosses prose or thinking boundaries and preserves chronology and identity', () => {
    const tools = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => tool(id));
    const entries = [t(tools[0]), t(tools[1]), thinking('th'), t(tools[2]), t(tools[3]), prose('p'), t(tools[4]), t(tools[5])];
    const units = buildActivityUnits(entries);
    expect(shape(units)).toEqual(['[a,b]', '|th|', '[c,d]', '|p|', '[e,f]']);
    const flat = flattenTools(units);
    expect(flat).toHaveLength(tools.length);
    flat.forEach((value, index) => expect(value).toBe(tools[index]));
  });

  it('keeps every show_widget standalone at its own position in every state', () => {
    const states: Array<[string, Partial<Tool>]> = [
      ['w-running', { status: 'running' }],
      ['w-error', { status: 'error', result: 'Widget failed' }],
      ['w-dashboard', { result: JSON.stringify({ schema: 'bridgesllm.widget-ref.v1', toolCallId: 'w-dashboard', title: 'Pinned', mode: 'dashboard' }) }],
      ['w-unsupported', { result: JSON.stringify({ schema: 'bridgesllm.widget-ref.v1', toolCallId: 'w-unsupported', title: 'Raw', mode: 'unsupported' }) }],
      ['w-inline', { result: JSON.stringify({ schema: 'bridgesllm.widget-ref.v1', toolCallId: 'w-inline', title: 'Chart', mode: 'inline' }) }],
    ];
    for (const [id, extra] of states) {
      const widget = tool(id, 'show_widget', extra.status || 'done', extra);
      const units = buildActivityUnits([t(tool('a')), t(tool('b')), t(widget), t(tool('c')), t(tool('d'))], { proseFollows: true });
      expect(shape(units)).toEqual(['[a,b]', `${id}!widget`, '[c,d]']);
      const standalone = units[1];
      expect(standalone.kind === 'tool' && standalone.tool).toBe(widget);
    }
    expect(standaloneToolReason(tool('ns', 'functions.show_widget'))).toBe('widget');
  });

  it('keeps questions, approvals, progress, goals, media and canvas visible', () => {
    expect(standaloneToolReason(tool('q', 'AskUserQuestion'))).toBe('question');
    expect(standaloneToolReason(tool('q2', 'request_user_input', 'running'))).toBe('question');
    expect(standaloneToolReason(tool('ap', 'ExitPlanMode'))).toBe('approval');
    expect(standaloneToolReason(tool('pr', 'update_plan'))).toBe('progress');
    expect(standaloneToolReason(tool('td', 'TodoWrite'))).toBe('progress');
    expect(standaloneToolReason(tool('go', 'update_goal'))).toBe('progress');
    expect(standaloneToolReason(tool('im', 'image_generate'))).toBe('media');
    expect(standaloneToolReason(tool('cv', 'canvas'))).toBe('interactive');
    for (const name of ['read', 'exec', 'grep', 'web_fetch', 'browser', 'sessions_spawn', 'apply_patch', 'mcp__github__list_issues']) {
      expect(standaloneToolReason(tool(name, name))).toBeNull();
    }
  });

  it('never groups an unknown tool whose output carries an interactive payload', () => {
    const appUi = tool('mcp-app', 'mcp__charts__render', 'done', { result: '{"content":[{"type":"resource","resource":{"uri":"ui://charts/view"}}]}' });
    const canvasRef = tool('plugin', 'plugin__present', 'done', { result: JSON.stringify({ kind: 'canvas', view: { id: 'cv_1', url: '/__openclaw__/canvas/documents/cv_1/index.html' } }) });
    expect(standaloneToolReason(appUi)).toBe('interactive');
    expect(standaloneToolReason(canvasRef)).toBe('interactive');
    // Known data families stay ordinary even when the data mentions such keys.
    const readJson = tool('rj', 'read', 'done', { result: JSON.stringify({ presentation: { target: 'x' } }) });
    expect(standaloneToolReason(readJson)).toBeNull();
    expect(carriesInteractiveOutput('plain text output')).toBe(false);
    expect(carriesInteractiveOutput('{not json')).toBe(false);
    expect(carriesInteractiveOutput(`{"kind":"canvas"${' '.repeat(300 * 1024)}}`)).toBe(false);
  });

  it('keeps an unanswered failure standalone and folds it once prose follows', () => {
    const fail = tool('f', 'exec', 'error', { result: 'exit 1' });
    const trailing = buildActivityUnits([t(tool('a')), t(tool('b')), t(fail), t(tool('c')), t(tool('d'))]);
    expect(shape(trailing)).toEqual(['[a,b]', 'f!failure', '[c,d]']);

    const answered = buildActivityUnits([t(tool('a')), t(tool('b')), t(fail), t(tool('c')), t(tool('d'))], { proseFollows: true });
    expect(shape(answered)).toEqual(['[a,b,f,c,d]']);

    const laterProse = buildActivityUnits([t(tool('a')), t(fail), t(tool('c')), prose('p')]);
    expect(shape(laterProse)).toEqual(['[a,f,c]', '|p|']);

    // Thinking is not an answer: the failure stays visible.
    const onlyThinking = buildActivityUnits([t(tool('a')), t(fail), t(tool('c')), thinking('th')]);
    expect(shape(onlyThinking)).toEqual(['a', 'f!failure', 'c', '|th|']);
  });

  it('keeps the group key stable while a live group grows and dedupes repeated IDs', () => {
    const first = buildActivityUnits([t(tool('a')), t(tool('b'))]);
    const grown = buildActivityUnits([t(tool('a')), t(tool('b')), t(tool('c', 'exec', 'running'))]);
    expect(first[0].key).toBe('group:a');
    expect(grown[0].key).toBe('group:a');
    const duplicated = buildActivityUnits([t(tool('a')), t(tool('b')), prose('p'), t(tool('a')), t(tool('c'))]);
    expect(duplicated.map((unit) => unit.key)).toEqual(['group:a', 'p', 'group:a#2']);
  });
});

describe('tool activity summary', () => {
  it('counts running, failed and completed calls verbatim and names the newest running call', () => {
    const tools = [
      tool('a', 'read'),
      tool('b', 'exec', 'error', { result: 'denied' }),
      tool('c', 'exec', 'running', { arguments: { command: 'npm test' } }),
      tool('d', 'grep', 'running'),
      tool('e', 'read'),
    ];
    const summary = summarizeActivityGroup(tools);
    expect(summary).toMatchObject({ total: 5, running: 2, failed: 1, completed: 2, branded: false });
    expect(summary.current).toBe(tools[3]);
    expect(summary.families.map((family) => [family.key, family.count])).toEqual([['read', 2], ['exec', 2], ['search', 1]]);
  });

  it('marks BridgesLLM skill use for the branded glyph', () => {
    const summary = summarizeActivityGroup([
      tool('s', 'skill', 'done', { arguments: { skill: 'bridgesllm-portal' } }),
      tool('r', 'read'),
    ]);
    expect(summary.branded).toBe(true);
    expect(summary.families[0].key).toBe('bridgesllm');
  });
});

describe('tool activity window', () => {
  it('windows whole units so a long group keeps its key and full count', () => {
    const entries: ActivityEntry<Tool, string>[] = [];
    for (let index = 0; index < 5; index += 1) {
      entries.push(t(tool(`q${index}`, 'ask_user')));
    }
    for (let index = 0; index < 200; index += 1) entries.push(t(tool(`r${index}`)));
    const units = buildActivityUnits(entries);
    expect(units).toHaveLength(6);
    const window = selectNewestActivityUnits(units, 3, 0);
    expect(window.units).toHaveLength(3);
    expect(window.hiddenUnits).toBe(3);
    expect(window.hiddenTools).toBe(3);
    const group = window.units[2];
    expect(group.kind === 'group' && group.tools).toHaveLength(200);
    expect(group.key).toBe('group:r0');
    expect(selectNewestActivityUnits(units, 3, 3).hiddenUnits).toBe(0);
  });
});
