import { describe, expect, it } from 'vitest';
import { buildToolCardModel, extractNestedToolRefs, parseToolName, resolveToolCardKind } from './toolCardRegistry';
import type { ToolCardInput, ToolCardKind, ToolCardModel, ToolCardSection } from './toolCardModel';

function tool(overrides: Partial<ToolCardInput>): ToolCardInput {
  return { id: 'call_1', name: 'exec', status: 'done', startedAt: 1_000, ...overrides };
}

/** Every string a card could render, recursively (nested cards included). */
function renderedStrings(model: ToolCardModel): string[] {
  const out: string[] = [model.title, model.subtitle || '', model.rawName, model.displayName, model.namespace || ''];
  for (const chip of model.chips) out.push(chip.label);
  const visit = (section: ToolCardSection) => {
    switch (section.type) {
      case 'code':
      case 'text':
        out.push(section.label, section.text);
        break;
      case 'fields':
        for (const row of section.rows) out.push(row.label, row.value);
        break;
      case 'diff':
        for (const line of section.lines) out.push(line.text);
        break;
      case 'steps':
        for (const step of section.steps) out.push(step.text);
        break;
      case 'links':
        for (const item of section.items) out.push(item.title, item.href || '', item.host || '', item.snippet || '');
        break;
      case 'refs':
        for (const item of section.items) out.push(item.name, item.namespace || '');
        break;
      case 'nested':
        for (const card of section.cards) out.push(...renderedStrings(card));
        break;
    }
  };
  model.sections.forEach(visit);
  return out;
}

function section<T extends ToolCardSection['type']>(model: ToolCardModel, type: T): Extract<ToolCardSection, { type: T }> | undefined {
  return model.sections.find((candidate): candidate is Extract<ToolCardSection, { type: T }> => candidate.type === type);
}

describe('tool names and aliases', () => {
  const cases: Array<[string, string, string | null, ToolCardKind]> = [
    ['exec', 'exec', null, 'shell'],
    ['functions.exec', 'exec', 'functions', 'shell'],
    ['default_api:exec', 'exec', 'default_api', 'shell'],
    ['tools.openclaw__sessions_send', 'sessions_send', 'openclaw', 'session'],
    ['openclaw_direct__exec', 'exec', 'openclaw_direct', 'shell'],
    ['mcp__github__create_issue', 'create_issue', 'mcp:github', 'generic'],
    ['MCP.github.listIssues', 'list_issues', 'mcp:github', 'generic'],
    ['bridgesllm__progress_card', 'progress_card', 'bridgesllm', 'progress'],
    ['multi_tool_use.parallel', 'parallel', 'multi_tool_use', 'parallel'],
    ['Bash', 'bash', null, 'shell'],
    ['TodoWrite', 'todo_write', null, 'progress'],
    ['WebFetch', 'web_fetch', null, 'web'],
    ['WebSearch', 'web_search', null, 'search'],
    ['str_replace_based_edit_tool', 'str_replace_based_edit_tool', null, 'edit'],
    ['brave_search', 'brave_search', null, 'search'],
    ['browser_navigate', 'browser_navigate', null, 'browser'],
    ['run_shell_command', 'run_shell_command', null, 'shell'],
    ['apply_patch', 'apply_patch', null, 'patch'],
    ['create_goal', 'create_goal', null, 'goal'],
    ['video_generate', 'video_generate', null, 'media'],
    ['Using tool: read', 'read', null, 'read'],
  ];

  it.each(cases)('%s → %s (%s, %s)', (raw, canonical, namespace, kind) => {
    const parsed = parseToolName(raw);
    expect(parsed.canonical).toBe(canonical);
    expect(parsed.namespace).toBe(namespace);
    expect(resolveToolCardKind(parsed.canonical)).toBe(kind);
  });

  it('gives every tool, however named, a non-empty name and title', () => {
    const names = ['', '   ', '<img src=x onerror=alert(1)>', 'x'.repeat(5000), '🙂', '__', 'mcp__srv__', 'a.b.', 'tool', 42 as unknown as string];
    for (const name of names) {
      const model = buildToolCardModel(tool({ name, arguments: { q: 1 } }));
      expect(model.displayName.length).toBeGreaterThan(0);
      expect(model.title.length).toBeGreaterThan(0);
      expect(model.rawName.length).toBeLessThanOrEqual(160);
    }
  });

  it('keeps an unknown tool’s real name instead of a generic label', () => {
    const model = buildToolCardModel(tool({ name: 'mcp__github__create_issue', arguments: { title: 'Bug', body: 'x' } }));
    expect(model.kind).toBe('generic');
    expect(model.displayName).toBe('Create issue');
    expect(model.title).toBe('Create issue · Bug');
    expect(model.rawName).toBe('mcp__github__create_issue');
    expect(model.chips.map((chip) => chip.label)).toContain('MCP · github');
  });

  it('strips bidi and zero-width control characters from names', () => {
    const name = `ex${String.fromCharCode(0x202e)}ec${String.fromCharCode(0x200b)}`;
    const model = buildToolCardModel(tool({ name, arguments: { command: 'ls' } }));
    expect(model.rawName).toBe('exec');
    expect(model.kind).toBe('shell');
  });
});

describe('malformed, partial and hostile input', () => {
  it('shows a preparing card while streamed JSON is incomplete', () => {
    const model = buildToolCardModel(tool({ status: 'running', arguments: '{"command": "ls -l' }));
    expect(model.argsState).toBe('partial');
    expect(model.title).toBe('Exec…');
    expect(model.sections).toEqual([]);
  });

  it('falls back to the generic card with the unreadable text once settled', () => {
    const model = buildToolCardModel(tool({ status: 'done', arguments: '{"command": "ls -l' }));
    expect(model.argsState).toBe('malformed');
    expect(model.kind).toBe('generic');
    expect(model.chips[0]).toEqual({ label: 'unreadable arguments', tone: 'warn' });
    expect(model.sections[0]).toMatchObject({ type: 'code', label: 'Arguments (unreadable)' });
  });

  it('survives non-object arguments, cycles, depth and throwing getters', () => {
    const cyclic: Record<string, unknown> = { command: 'ls' };
    cyclic.self = cyclic;
    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 1000; i += 1) deep = { next: deep };
    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, 'command', { enumerable: true, get() { throw new Error('boom'); } });
    for (const args of [[1, 2, 3], 42, null, cyclic, deep, hostile]) {
      for (const name of ['exec', 'mcp__x__y', 'parallel', 'progress_card']) {
        expect(() => buildToolCardModel(tool({ name, arguments: args }))).not.toThrow();
      }
    }
    expect(buildToolCardModel(tool({ name: 'mcp__x__y', arguments: deep })).sections[0]).toMatchObject({
      type: 'fields',
      rows: [{ label: 'next', value: '{1 field}' }],
    });
    expect(buildToolCardModel(tool({ name: 'exec', arguments: hostile })).kind).toBe('generic');
  });

  it('bounds huge results', () => {
    const model = buildToolCardModel(tool({ arguments: { command: 'cat big' }, result: 'y'.repeat(2_000_000) }));
    const output = section(model, 'code');
    const last = model.sections[model.sections.length - 1];
    expect(output).toBeDefined();
    expect(last).toMatchObject({ type: 'code', label: 'Output', truncated: true });
    expect((last as { text: string }).text.length).toBeLessThanOrEqual(4000);
  });

  it('keeps the tool call identity and status verbatim', () => {
    const model = buildToolCardModel(tool({ id: 'toolu_01ABC', status: 'error', arguments: { command: 'false' }, result: 'boom', endedAt: 3_500 }));
    expect(model.id).toBe('toolu_01ABC');
    expect(model.status).toBe('error');
    expect(model.durationMs).toBe(2_500);
    expect(model.sections[model.sections.length - 1]).toMatchObject({ type: 'code', label: 'Error', text: 'boom' });
  });
});

describe('secrets never reach the card', () => {
  // Construct a synthetic credential at runtime; no literal key prefix in the export.
  const anthropic = ["sk", "ant", "api03", 'A'.repeat(40)].join('-');
  const github = `ghp_${'b'.repeat(36)}`;

  it('redacts credentials in commands and output', () => {
    const model = buildToolCardModel(tool({
      arguments: {
        command: `curl -H "Authorization: Bearer ${anthropic}" -H 'X-Api-Key: KEYVALUE9' https://user:PWVALUE9@example.com/?token=TOKVALUE9 --password PASSVALUE9 && export GITHUB_TOKEN=${github}`,
      },
      result: `ok ${anthropic}\n-----BEGIN RSA PRIVATE KEY-----\nMIIBOGUSKEY\n-----END RSA PRIVATE KEY-----\nAuthorization: Bearer short1`,
    }));
    const all = renderedStrings(model).join('\n');
    for (const needle of [anthropic, github, 'KEYVALUE9', 'PWVALUE9', 'TOKVALUE9', 'PASSVALUE9', 'MIIBOGUSKEY', 'short1']) {
      expect(all).not.toContain(needle);
    }
    expect(all).toContain('Authorization: Bearer ••••••');
    expect(all).toContain('[private key hidden]');
  });

  it('masks secret-named arguments but not look-alikes', () => {
    const model = buildToolCardModel(tool({
      name: 'mcp__vault__put',
      arguments: { apiKey: 'KEYVALUE1', password: 'PASSVALUE1', accessToken: 'TOKVALUE1', sessionKey: 'agent:main:x', maxTokens: 5, tokenBudget: 10 },
    }));
    const rows = section(model, 'fields')?.rows || [];
    const byLabel = Object.fromEntries(rows.map((row) => [row.label, row]));
    expect(byLabel.apiKey).toMatchObject({ value: '••••••', redacted: true });
    expect(byLabel.password).toMatchObject({ value: '••••••', redacted: true });
    expect(byLabel.accessToken).toMatchObject({ value: '••••••', redacted: true });
    expect(byLabel.sessionKey.value).toBe('agent:main:x');
    expect(byLabel.maxTokens.value).toBe('5');
    expect(byLabel.tokenBudget.value).toBe('10');
    expect(renderedStrings(model).join('\n')).not.toMatch(/KEYVALUE1|PASSVALUE1|TOKVALUE1/);
  });

  it('never shows text typed into the browser', () => {
    const model = buildToolCardModel(tool({ name: 'browser', arguments: { action: 'act', request: { kind: 'type', ref: 'e12', text: 'SuperSecret!' } } }));
    const all = renderedStrings(model).join('\n');
    expect(all).not.toContain('SuperSecret!');
    expect(section(model, 'fields')?.rows).toContainEqual({ label: 'typed', value: '12 characters (hidden)', redacted: true });
  });
});

describe('links are http(s) only', () => {
  it('refuses script, data and credential-bearing URLs', () => {
    const hrefFor = (url: string) => section(buildToolCardModel(tool({ name: 'web_fetch', arguments: { url } })), 'links')?.items[0];
    expect(hrefFor('javascript:alert(1)')?.href).toBeNull();
    expect(hrefFor('data:text/html,<script>alert(1)</script>')?.href).toBeNull();
    const credentialed = hrefFor('https://user:pass@evil.example/x');
    expect(credentialed?.href).toBeNull();
    expect(credentialed?.title).not.toContain('pass');
    expect(hrefFor('https://example.com/a?b=1')?.href).toBe('https://example.com/a?b=1');
  });

  it('renders search results as safe links', () => {
    const model = buildToolCardModel(tool({
      name: 'web_search',
      arguments: { query: 'openclaw' },
      result: JSON.stringify({ results: [
        { title: '<script>x</script>', url: 'javascript:alert(1)' },
        { title: 'Docs', url: 'https://docs.example/a', snippet: 'Guide' },
      ] }),
    }));
    expect(model.title).toBe('Search “openclaw”');
    const links = section(model, 'links');
    expect(links?.items.map((item) => item.href)).toEqual([null, 'https://docs.example/a']);
    expect(links?.items[0].title).toBe('<script>x</script>');
    expect(model.sections.some((candidate) => candidate.type === 'code')).toBe(false);
  });

  it('keeps local media references as text', () => {
    const model = buildToolCardModel(tool({
      name: 'video_generate',
      arguments: { prompt: 'A cat', aspectRatio: '16:9', images: ['javascript:alert(1)', 'https://cdn.example/a.png', '/tmp/x.png'] },
    }));
    expect(model.title).toBe('Generate video');
    expect(section(model, 'links')?.items.map((item) => item.href)).toEqual([null, 'https://cdn.example/a.png', null]);
  });
});

describe('structured families', () => {
  it('separates shell commands from code mode cells', () => {
    expect(buildToolCardModel(tool({ arguments: { command: 'ls -la', workdir: '/srv/app' } }))).toMatchObject({
      kind: 'shell', title: 'Run ls -la', subtitle: '/srv/app',
    });
    expect(buildToolCardModel(tool({ name: 'shell', arguments: { command: ['bash', '-lc', 'git status'] } })).title).toBe('Run git status');

    const openclaw = buildToolCardModel(tool({
      arguments: {
        title: 'Collect',
        code: "const a = await read({path:'x'});\nconst b = await web_search({query:'y'});\nawait MCP.github.listIssues({});\nawait read({path:'z'});\nawait Promise.all([]);",
      },
    }));
    expect(openclaw.kind).toBe('code');
    expect(openclaw.title).toBe('Code: Collect');
    expect(section(openclaw, 'refs')?.items).toEqual([
      { name: 'read', namespace: null, count: 2 },
      { name: 'web_search', namespace: null, count: 1 },
      { name: 'list_issues', namespace: 'mcp:github', count: 1 },
    ]);

    const codex = buildToolCardModel(tool({
      arguments: 'text(await tools.openclaw__sessions_send({sessionKey:"k"}));\ntext(await tools.openclaw_direct__exec({command:"ls"}));',
    }));
    expect(codex.kind).toBe('code');
    expect(section(codex, 'refs')?.items).toEqual([
      { name: 'sessions_send', namespace: 'openclaw', count: 1 },
      { name: 'exec', namespace: 'openclaw_direct', count: 1 },
    ]);
  });

  it('reports exit codes found in output', () => {
    const model = buildToolCardModel(tool({ arguments: { command: 'make' }, result: 'error\n(Command exited with code 2)' }));
    expect(model.chips[0]).toEqual({ label: 'exit 2', tone: 'bad' });
  });

  it('renders edits and patches as diffs', () => {
    const edit = buildToolCardModel(tool({
      name: 'MultiEdit',
      arguments: { file_path: '/repo/src/a.ts', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd' }] },
    }));
    expect(edit.title).toBe('Edit src/a.ts');
    expect(edit.chips[0].label).toBe('2 edits');
    expect(section(edit, 'diff')?.lines.map((line) => line.kind)).toEqual(['del', 'add', 'meta', 'del', 'add']);

    const patch = buildToolCardModel(tool({
      name: 'apply_patch',
      arguments: '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** Add File: src/b.ts\n+hello\n*** End Patch',
    }));
    expect(patch.title).toBe('Patch 2 files');
    expect(section(patch, 'diff')?.lines.filter((line) => line.kind === 'add').length).toBe(2);
  });

  it('shows plans with verbatim step states and bounds them', () => {
    const model = buildToolCardModel(tool({
      name: 'progress_card',
      arguments: { markdown: '**x** <b>y</b>', plan: [{ step: 'a', status: 'completed' }, { step: 'b', status: 'in_progress' }, { step: 'c', status: 'weird' }] },
    }));
    expect(model.title).toBe('Update progress · 1/3');
    expect(section(model, 'steps')?.steps.map((step) => step.status)).toEqual(['completed', 'in_progress', 'unknown']);
    expect(section(model, 'text')?.text).toBe('**x** <b>y</b>');
    expect(buildToolCardModel(tool({ name: 'progress_card', arguments: { markdown: '', plan: [] } })).title).toBe('Clear progress card');
    const long = buildToolCardModel(tool({ name: 'update_plan', arguments: { plan: Array.from({ length: 80 }, (_, i) => ({ step: `s${i}`, status: 'pending' })) } }));
    expect(section(long, 'steps')).toMatchObject({ truncated: true });
    expect(section(long, 'steps')?.steps.length).toBe(50);
  });

  it('summarizes goals and child sessions from their own payloads', () => {
    expect(buildToolCardModel(tool({ name: 'create_goal', arguments: { objective: 'Ship it', token_budget: 5000 } }))).toMatchObject({
      kind: 'goal', title: 'Set goal: Ship it', chips: [{ label: 'budget 5000 tokens', tone: 'neutral' }],
    });
    expect(buildToolCardModel(tool({ name: 'update_goal', arguments: { status: 'complete', note: 'done' } })).title).toBe('Goal → complete');

    const spawn = buildToolCardModel(tool({
      name: 'sessions_spawn',
      arguments: { agentId: 'kernel', task: 'Research', model: 'openai/gpt-6.1-sol' },
      result: '{"status":"accepted","childSessionKey":"agent:kernel:dashboard:c765","runId":"ba04"}',
    }));
    expect(spawn.title).toBe('Spawn kernel');
    expect(spawn.chips).toContainEqual({ label: 'accepted', tone: 'good' });
    expect(section(spawn, 'fields')?.rows).toEqual([
      { label: 'child session', value: 'agent:kernel:dashboard:c765', mono: true },
      { label: 'run', value: 'ba04', mono: true },
    ]);
    // The structured outcome replaces the raw JSON result.
    expect(spawn.sections.some((candidate) => candidate.type === 'code')).toBe(false);
  });
});

describe('nested tool calls', () => {
  it('renders parallel calls as nested cards with derived keys', () => {
    const model = buildToolCardModel(tool({
      id: 'call_9',
      name: 'multi_tool_use.parallel',
      arguments: { tool_uses: [
        { recipient_name: 'functions.exec', parameters: { command: 'pwd' } },
        { recipient_name: 'functions.unknown_thing', parameters: { a: 1 } },
        { recipient_name: 'functions.read', parameters: '{bad' },
      ] },
    }));
    const nested = section(model, 'nested');
    expect(model.title).toBe('Run 3 tools in parallel');
    expect(nested?.cards.map((card) => [card.id, card.kind, card.title])).toEqual([
      ['call_9#0', 'shell', 'Run pwd'],
      ['call_9#1', 'generic', 'Unknown thing'],
      ['call_9#2', 'generic', 'Read'],
    ]);
  });

  it('stops nesting at the depth bound', () => {
    let args: Record<string, unknown> = { tool_uses: [{ recipient_name: 'functions.exec', parameters: { command: 'ls' } }] };
    for (let i = 0; i < 4; i += 1) args = { tool_uses: [{ recipient_name: 'multi_tool_use.parallel', parameters: args }] };
    const depthOf = (model: ToolCardModel): number => {
      const nested = section(model, 'nested');
      return nested && nested.cards.length ? 1 + Math.max(...nested.cards.map(depthOf)) : 0;
    };
    expect(depthOf(buildToolCardModel(tool({ name: 'parallel', arguments: args })))).toBe(2);
  });

  it('lists code-mode references without treating identifiers as calls', () => {
    const refs = extractNestedToolRefs('const tool = await catalog.search("x"); await tool({}); await sleep(1); await nodes.list(); await exec({code:"1"});');
    expect(refs.items).toEqual([{ name: 'exec', namespace: null, count: 1 }]);
  });
});

describe('native harness tools', () => {
  it('lists Codex file changes with their paths and change kinds', () => {
    const model = buildToolCardModel(tool({ id: 'item_4', name: 'file_change', arguments: { changes: [
      { path: '/repo/src/app.ts', kind: 'update' },
      { path: '/repo/src/new.ts', kind: 'add' },
      { path: '/repo/old.ts', kind: 'delete' },
    ] } }));
    expect(model.kind).toBe('patch');
    expect(model.title).toBe('Change 3 files');
    expect(model.chips.map((entry) => entry.label)).toEqual(['1 added', '1 updated', '1 deleted']);
    expect(section(model, 'fields')?.rows.map((row) => [row.label, row.value])).toEqual([
      ['updated', '/repo/src/app.ts'],
      ['added', '/repo/src/new.ts'],
      ['deleted', '/repo/old.ts'],
    ]);
  });

  it('names a single file change by its kind and path', () => {
    const added = buildToolCardModel(tool({ name: 'file_change', arguments: { changes: [{ path: '/repo/src/new.ts', kind: 'add' }] } }));
    expect(added.title).toBe('Add src/new.ts');
    expect(added.subtitle).toBe('/repo/src/new.ts');
    expect(added.chips.map((entry) => entry.label)).toEqual(['added']);
    const deleted = buildToolCardModel(tool({ name: 'delete', arguments: { path: '/repo/tmp/old.log' } }));
    expect([deleted.kind, deleted.title]).toEqual(['patch', 'Delete tmp/old.log']);
    const moved = buildToolCardModel(tool({ name: 'move', arguments: { from: '/repo/a/one.ts', to: '/repo/b/two.ts' } }));
    expect(moved.title).toBe('Move a/one.ts → b/two.ts');
  });

  it('renders Codex plans, web searches and MCP calls usefully', () => {
    const plan = buildToolCardModel(tool({ name: 'update_plan', arguments: { plan: [
      { step: 'Read the failing test', status: 'completed' },
      { step: 'Fix the parser', status: 'in_progress' },
    ] } }));
    expect([plan.kind, plan.title]).toEqual(['progress', 'Update plan · 1/2']);
    expect(section(plan, 'steps')?.steps.map((step) => step.status)).toEqual(['completed', 'in_progress']);
    const search = buildToolCardModel(tool({ name: 'web_search', arguments: { query: 'vite 8 release notes' } }));
    expect([search.kind, search.title]).toEqual(['search', 'Search “vite 8 release notes”']);
    const mcp = buildToolCardModel(tool({ name: 'mcp__github__create_issue', arguments: { title: 'Flaky CI', body: 'details' }, result: 'Created #42' }));
    expect(mcp.namespace).toBe('mcp:github');
    expect(mcp.title).toBe('Create issue · Flaky CI');
    expect(mcp.chips.map((entry) => entry.label)).toContain('MCP · github');
    expect(section(mcp, 'code')?.text).toBe('Created #42');
  });

  it('gives every harness’s common tools a specific card', () => {
    const common: Array<[string, Record<string, unknown>, ToolCardKind, string]> = [
      // Claude Code
      ['Bash', { command: 'npm test' }, 'shell', 'Run npm test'],
      ['Read', { file_path: '/repo/src/a.ts' }, 'read', 'Read src/a.ts'],
      ['Edit', { file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' }, 'edit', 'Edit src/a.ts'],
      ['MultiEdit', { file_path: '/repo/src/a.ts', edits: [{ old_string: 'a', new_string: 'b' }] }, 'edit', 'Edit src/a.ts'],
      ['Write', { file_path: '/repo/src/a.ts', content: 'x' }, 'write', 'Write src/a.ts'],
      ['Grep', { pattern: 'TODO' }, 'search', 'Search “TODO”'],
      ['Glob', { pattern: '**/*.ts' }, 'search', 'Match **/*.ts'],
      ['WebFetch', { url: 'https://example.com/a' }, 'web', 'Fetch example.com'],
      ['TodoWrite', { todos: [{ content: 'Ship it', status: 'pending' }] }, 'progress', 'Update to-dos · 0/1'],
      ['Task', { subagent_type: 'Explore', prompt: 'Find the bug' }, 'session', 'Spawn Explore'],
      ['BashOutput', { bash_id: 'b1' }, 'process', 'Process check output b1'],
      ['KillBash', { shell_id: 'b1' }, 'process', 'Process stop b1'],
      // Codex
      ['shell', { command: 'cargo test' }, 'shell', 'Run cargo test'],
      // Antigravity
      ['run_command', { CommandLine: 'npm run lint', Cwd: '/repo' }, 'shell', 'Run npm run lint'],
      ['view_file', { AbsolutePath: '/tmp/fact.txt' }, 'read', 'Read /tmp/fact.txt'],
      ['list_dir', { DirectoryPath: '/repo/src/lib' }, 'read', 'List src/lib'],
      ['write_to_file', { TargetFile: '/repo/docs/notes.md', CodeContent: '# Notes' }, 'write', 'Write docs/notes.md'],
      ['replace_file_content', { TargetFile: '/repo/src/a.ts', ReplacementChunks: [{ TargetContent: 'a', ReplacementContent: 'b' }] }, 'edit', 'Edit src/a.ts'],
      ['grep_search', { Query: 'TODO', SearchPath: '/repo' }, 'search', 'Search “TODO”'],
      ['find_by_name', { Pattern: '*.md', SearchDirectory: '/repo' }, 'search', 'Find files “*.md”'],
      ['read_url_content', { Url: 'https://example.com/docs' }, 'web', 'Fetch example.com'],
      ['command_status', { CommandId: 'c1' }, 'process', 'Process check output c1'],
      // ACP harnesses (Grok, Hermes, OpenCode) report tool kinds
      ['read', { filePath: '/repo/src/a.ts' }, 'read', 'Read src/a.ts'],
      ['edit', { filePath: '/repo/src/a.ts', oldString: 'a', newString: 'b' }, 'edit', 'Edit src/a.ts'],
      ['edit', { filePath: '/repo/src/new.ts', content: 'export {}' }, 'write', 'Write src/new.ts'],
      ['search', { pattern: 'TODO', path: '/repo' }, 'search', 'Search “TODO”'],
      ['fetch', { url: 'https://example.com/x' }, 'web', 'Fetch example.com'],
      // Bridge tools (every harness)
      ['ask_user', { question: 'Ship it?' }, 'question', 'Ask: Ship it?'],
    ];
    for (const [name, args, kind, title] of common) {
      const model = buildToolCardModel(tool({ name, arguments: args }));
      expect([name, model.kind, model.title]).toEqual([name, kind, title]);
    }
    const edit = buildToolCardModel(tool({ name: 'edit', arguments: { filePath: '/repo/a.ts', oldString: 'before', newString: 'after', replaceAll: true } }));
    expect(section(edit, 'diff')?.lines).toEqual([{ kind: 'del', text: 'before' }, { kind: 'add', text: 'after' }]);
    expect(edit.chips.map((entry) => entry.label)).toContain('replace all');
  });
});
