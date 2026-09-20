import { __gatewayHistoryTest } from '../routes/gateway';

describe('gateway runtime-history prune-only reconciliation', () => {
  const epoch = Date.parse('2026-08-08T10:00:00.000Z');
  const at = (seconds: number) => new Date(epoch + seconds * 1000).toISOString();
  const ms = (seconds: number) => epoch + seconds * 1000;
  const overlay = (overrides: Record<string, unknown> = {}) => ({
    id: 'runtime-test',
    role: 'assistant',
    content: 'POST',
    timestamp: at(40),
    __portal: { kind: 'runtime-turn-event-history', runId: 'run-test' },
    ...overrides,
  });
  const runtimeRows = (messages: any[]) => messages.filter((message) => (
    message?.__portal?.kind === 'runtime-turn-event-history'
  ));

  test.each(['plain', 'cumulative'])('hydrates empty tool results before suppressing duplicate calls (%s final)', (finalShape) => {
    const finalContent = finalShape === 'cumulative'
      ? 'CHATPOLISH_PROGRESS\n\nCHATPOLISH_DONE'
      : 'CHATPOLISH_DONE';
    const tools = [1, 2].map((revision) => ({
      id: `progress-call-${revision}`, name: 'progress_card',
      arguments: { plan: [{ step: 'Check chat', status: 'completed' }] },
      result: `Progress card updated (rev ${revision})`,
      startedAt: ms(revision * 10), endedAt: ms(revision * 10 + 1), status: 'done',
    }));
    // Browser-reproduced shape: user, tool-only, progress, tool-only, final.
    // Canonical hydration has a blank result; the runtime lane has the output.
    const canonical = [
      { id: 'u', role: 'user', content: 'Check chat', timestamp: at(0) },
      { id: 'tool-1', role: 'assistant', content: '', timestamp: at(10), toolCalls: [{ ...tools[0], result: '' }] },
      { id: 'progress', role: 'assistant', content: 'CHATPOLISH_PROGRESS', timestamp: at(12) },
      { id: 'tool-2', role: 'assistant', content: '', timestamp: at(20), toolCalls: [{ ...tools[1], result: '' }] },
      { id: 'final', role: 'assistant', content: finalContent, timestamp: at(22) },
    ];
    const source = __gatewayHistoryTest.collapseFragmentedToolOnlyAssistantHistory(canonical);
    const before = JSON.parse(JSON.stringify(source));
    const runtime = overlay({
      content: finalContent, timestamp: at(22), toolCalls: tools,
      segments: finalShape === 'cumulative'
        ? [{ text: 'CHATPOLISH_PROGRESS', kind: 'text', source: 'text', position: 'before', ts: ms(12) }]
        : undefined,
      __portal: { kind: 'runtime-turn-event-history', runId: 'run-test', terminal: true, complete: true },
    });
    const merged = __gatewayHistoryTest.mergeRuntimeHistoryMessages(source, [runtime], 20);

    expect(merged.flatMap((message: any) => message.toolCalls || [])).toEqual(tools);
    expect(merged.map((message: any) => message.id)).toEqual(['u', 'progress', 'final']);
    expect(merged.map((message: any) => message.content))
      .toEqual(['Check chat', 'CHATPOLISH_PROGRESS', 'CHATPOLISH_DONE']);
    expect(source).toEqual(before);
    // A second reload must neither duplicate tools nor lose their richer output.
    expect(__gatewayHistoryTest.mergeRuntimeHistoryMessages(source, [runtime], 20)).toEqual(merged);
  });

  // Browser-reproduced on a Claude CLI (claude-cli runtime) turn that narrates
  // between tool calls. OpenClaw's transcript holds each text block as its own
  // assistant row AND one aggregate row repeating all of them (the CLI result
  // text), and carries no tool calls. The Portal runtime lane holds the same
  // text as segments plus the tools. Agent Chat rendered the turn three times.
  describe('Claude CLI aggregate result mirror', () => {
    const t0 = 1789880593088;
    const toolCalls = [
      {
        id: 'toolu_one', name: 'Bash', identity: 'provider', arguments: { command: 'echo one' },
        result: 'one', startedAt: t0 + 3563, endedAt: t0 + 3674, status: 'done', order: 1,
      },
      {
        id: 'toolu_two', name: 'Bash', identity: 'provider', arguments: { command: 'echo two' },
        result: 'two', startedAt: t0 + 5307, endedAt: t0 + 5335, status: 'done', order: 3,
      },
    ];
    const canonical = () => [
      { id: 'u', role: 'user', content: 'Do these steps in order.', timestamp: t0 },
      { id: 'a', role: 'assistant', content: 'Starting now A.', stopReason: 'tool_use', api: 'anthropic-messages', provider: 'claude-cli', timestamp: t0 + 2949 },
      { id: 'b', role: 'assistant', content: 'Halfway there B.', stopReason: 'tool_use', api: 'anthropic-messages', provider: 'claude-cli', timestamp: t0 + 4858 },
      { id: 'c', role: 'assistant', content: 'All done C.', stopReason: 'end_turn', api: 'anthropic-messages', provider: 'claude-cli', timestamp: t0 + 6463 },
      { id: 'aggregate', role: 'assistant', content: 'Starting now A.\n\nHalfway there B.\n\nAll done C.', stopReason: 'stop', api: 'cli', provider: 'claude-cli', timestamp: t0 + 6732 },
    ];
    const runtime = () => ({
      id: 'runtime-turn-claude-cli',
      role: 'assistant',
      content: 'All done C.',
      timestamp: new Date(t0 + 6761).toISOString(),
      provenance: 'via OpenClaw',
      toolCalls,
      segments: [
        { text: 'Starting now A.', position: 'before', kind: 'text', source: 'text', ts: t0 + 2856, order: 0 },
        { text: 'Halfway there B.', position: 'before', kind: 'text', source: 'text', ts: t0 + 4934, order: 2 },
      ],
      __portal: { kind: 'runtime-turn-event-history', runId: 'run-claude-cli', terminal: true, complete: true, lastEventSeq: 13 },
    });
    const renderedText = (messages: any[]) => messages
      .filter((message) => message.role === 'assistant')
      .flatMap((message) => [
        ...(Array.isArray(message.segments) ? message.segments.map((segment: any) => segment.text) : []),
        message.content,
      ])
      .join('\n');
    const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;

    test('renders every sentence and every tool exactly once', () => {
      const source = canonical();
      const before = JSON.parse(JSON.stringify(source));
      const merged = __gatewayHistoryTest.mergeRuntimeHistoryMessages(source, [runtime()], 80);
      const text = renderedText(merged);

      for (const sentence of ['Starting now A.', 'Halfway there B.', 'All done C.']) {
        expect(occurrences(text, sentence)).toBe(1);
      }
      expect(merged.flatMap((message: any) => message.toolCalls || []).map((tool: any) => tool.id))
        .toEqual(['toolu_one', 'toolu_two']);
      expect(source).toEqual(before);
      // Reloading the same history must be a fixed point.
      expect(__gatewayHistoryTest.mergeRuntimeHistoryMessages(source, [runtime()], 80)).toEqual(merged);
    });

    test('collapses the aggregate even when the runtime lane is gone', () => {
      const merged = __gatewayHistoryTest.mergeRuntimeHistoryMessages(canonical(), [], 80);
      expect(merged.map((message: any) => message.id)).toEqual(['u', 'a', 'b', 'c']);
    });

    test('keeps a final row that merely resembles an aggregate', () => {
      const partial = canonical();
      partial[4] = { ...partial[4], content: 'Starting now A.\n\nHalfway there B.\n\nAll done C. One more thing.' };
      const kept = __gatewayHistoryTest.mergeRuntimeHistoryMessages(partial, [], 80);
      expect(kept.map((message: any) => message.id)).toContain('aggregate');

      // A repeat that carries its own tool call is real work, not a mirror.
      const withTool = canonical();
      withTool[4] = { ...withTool[4], toolCalls: [toolCalls[0]] } as any;
      expect(__gatewayHistoryTest.mergeRuntimeHistoryMessages(withTool, [], 80).map((message: any) => message.id))
        .toContain('aggregate');

      // A user turn in between means the repeat is not part of the same turn.
      const acrossTurns = [
        ...canonical().slice(0, 4),
        { id: 'u2', role: 'user', content: 'Say all of that again.', timestamp: t0 + 9000 },
        { ...canonical()[4], timestamp: t0 + 12000 },
      ];
      expect(__gatewayHistoryTest.mergeRuntimeHistoryMessages(acrossTurns, [], 80).map((message: any) => message.id))
        .toEqual(['u', 'a', 'b', 'c', 'u2', 'aggregate']);
    });

    test('keeps a row that differs from the join in case, separator, or order', () => {
      const ids = (messages: any[]) => __gatewayHistoryTest
        .mergeRuntimeHistoryMessages(messages, [], 80).map((message: any) => message.id);
      const turn = (finalContent: string) => [
        { id: 'u', role: 'user', content: 'Go.', timestamp: t0 },
        { id: 'a', role: 'assistant', content: 'Use /tmp/A', timestamp: t0 + 1000 },
        { id: 'b', role: 'assistant', content: 'then stop', timestamp: t0 + 2000 },
        { id: 'final', role: 'assistant', content: finalContent, timestamp: t0 + 3000 },
      ];
      // A different path is different content, whatever a case-folding match says.
      expect(ids(turn('Use /tmp/a\n\nthen stop'))).toContain('final');
      // The CLI result text joins blocks with a blank line and nothing else.
      expect(ids(turn('Use /tmp/A then stop'))).toContain('final');
      expect(ids(turn('Use /tmp/A\nthen stop'))).toContain('final');
      expect(ids(turn('then stop\n\nUse /tmp/A'))).toContain('final');
      // The exact join is the mirror, with or without edge whitespace.
      expect(ids(turn('Use /tmp/A\n\nthen stop'))).toEqual(['u', 'a', 'b']);
      expect(ids(turn('  Use /tmp/A\n\nthen stop\n'))).toEqual(['u', 'a', 'b']);
    });

    test('stays linear when a turn carries thousands of mirrors', () => {
      const rows: any[] = [
        { id: 'u', role: 'user', content: 'Go.', timestamp: t0 },
        { id: 'a', role: 'assistant', content: 'A', timestamp: t0 + 1 },
        { id: 'b', role: 'assistant', content: 'B', timestamp: t0 + 2 },
      ];
      for (let index = 0; index < 40_000; index += 1) {
        rows.push({ id: `m${index}`, role: 'assistant', content: 'A\n\nB', timestamp: t0 + 3 + index });
      }
      const startedAt = process.hrtime.bigint();
      const merged = __gatewayHistoryTest.mergeRuntimeHistoryMessages(rows, [], 80);
      const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      expect(merged.map((message: any) => message.id)).toEqual(['u', 'a', 'b']);
      // The rescanning version needed ~8e8 set lookups here (tens of seconds).
      expect(elapsedMs).toBeLessThan(1_500);
    });

    test('a mirror never becomes a part of a later mirror', () => {
      const rows = [
        { id: 'u', role: 'user', content: 'Go.', timestamp: t0 },
        { id: 'a', role: 'assistant', content: 'A', timestamp: t0 + 1 },
        { id: 'b', role: 'assistant', content: 'B', timestamp: t0 + 2 },
        { id: 'm1', role: 'assistant', content: 'A\n\nB', timestamp: t0 + 3 },
        // Would only match if the dropped row above had stayed in the run.
        { id: 'real', role: 'assistant', content: 'A\n\nB\n\nA\n\nB', timestamp: t0 + 4 },
      ];
      expect(__gatewayHistoryTest.mergeRuntimeHistoryMessages(rows, [], 80).map((message: any) => message.id))
        .toEqual(['u', 'a', 'b', 'real']);
    });
  });

  test.each([null, undefined, 7, 'malformed', []])(
    'fails closed without losing history when an exact tool owner has malformed sibling %p', (sibling) => {
      const tool = {
        id: 'stable-tool', name: 'progress_card', arguments: { revision: 1 },
        result: 'Progress card updated', status: 'done', startedAt: ms(10), endedAt: ms(11),
      };
      const source = [
        { id: 'u', role: 'user', content: 'go', timestamp: at(0) },
        { id: 'owner', role: 'assistant', content: 'progress', timestamp: at(12), toolCalls: [sibling, { ...tool, result: '' }] },
        { id: 'terminal', role: 'assistant', content: 'POST', timestamp: at(40) },
      ];
      const runtime = overlay({
        toolCalls: [tool],
        __portal: { kind: 'runtime-turn-event-history', terminal: true, complete: true },
      });
      const merged = __gatewayHistoryTest.mergeRuntimeHistoryMessages(source, [runtime], 20);

      expect(merged).toEqual([...source, runtime]);
      expect(merged[1].toolCalls[0]).toBe(sibling);
      expect((source[1].toolCalls?.[1] as any)?.result).toBe('');
    },
  );

  test.each([
    { result: 'conflicting result' },
    { arguments: { revision: 2 } },
    { name: 'different-tool' },
    { status: 'error' },
  ])('retains same-ID conflicting evidence even with an unindexed timestamp: %p', (conflict) => {
    const tool = {
      id: 'stable-tool', name: 'progress_card', arguments: { revision: 1 },
      result: 'Progress card updated', status: 'done', startedAt: ms(10), endedAt: ms(11),
    };
    const owner = {
      id: 'owner', role: 'assistant', content: 'progress', timestamp: at(12),
      toolCalls: [
        { ...tool, result: '' },
        { ...tool, result: '', ...conflict, startedAt: 'unindexed' },
      ],
    };
    const source = [
      { id: 'u', role: 'user', content: 'go', timestamp: at(0) },
      owner,
      { id: 'terminal', role: 'assistant', content: 'POST', timestamp: at(40) },
    ];
    const sourceSnapshot = JSON.parse(JSON.stringify(source));
    const runtime = overlay({
      toolCalls: [tool],
      __portal: { kind: 'runtime-turn-event-history', terminal: true, complete: true },
    });
    const merged = __gatewayHistoryTest.mergeRuntimeHistoryMessages(source, [runtime], 20);

    expect(merged.find((message: any) => message.id === 'owner')).toEqual(owner);
    expect(runtimeRows(merged)[0].toolCalls).toEqual([tool]);
    expect(source).toEqual(sourceSnapshot);
  });

  test.each(['POST', ''])('charges owner-array hydration to the prune budget (terminal %p)', (content) => {
    const tools = Array.from({ length: 128 }, (_, index) => ({
      id: `tool-${index}`, name: 'exec', arguments: { command: `inspect-${index}` },
      result: '', status: 'done', startedAt: ms(10), endedAt: ms(11),
    }));
    const earlierTool = { ...tools[0], id: 'earlier-tool', startedAt: ms(5), endedAt: ms(6) };
    const source = [
      { id: 'u', role: 'user', content: 'go', timestamp: at(0) },
      { id: 'earlier-owner', role: 'assistant', content: 'earlier', timestamp: at(7), toolCalls: [earlierTool] },
      { id: 'owner', role: 'assistant', content: 'progress', timestamp: at(12), toolCalls: tools },
      { id: 'terminal', role: 'assistant', content: 'POST', timestamp: at(40) },
    ];
    const sourceSnapshot = JSON.parse(JSON.stringify(source));
    const runtime = overlay({
      content, toolCalls: [
        { ...earlierTool, result: 'earlier runtime output' },
        { ...tools[0], result: 'runtime output' },
      ],
      __portal: { kind: 'runtime-turn-event-history', terminal: true, complete: true },
    });
    // The first owner can be hydrated; copying the second owner's many
    // siblings must exhaust the budget and roll back the entire staged merge.
    const merged = __gatewayHistoryTest.mergeRuntimeHistoryMessages(source, [runtime], 20, { prune: 64 });

    expect(merged).toEqual([...sourceSnapshot, runtime]);
    expect(source).toEqual(sourceSnapshot);
  });

  test.each(['POST', ''])('hydrates many exact calls with linear canonical visits (terminal %p)', (content) => {
    const count = 256;
    let idReads = 0;
    const tools = Array.from({ length: count }, (_, index) => ({
      id: `tool-${index}`, name: 'exec', arguments: { command: `inspect-${index}` },
      result: `output-${index}`, status: 'done', startedAt: ms(10), endedAt: ms(11),
    }));
    const durableTools = tools.map((tool) => ({
      ...tool,
      // Count actual canonical identity reads, not elapsed time or calls to a
      // particular helper. Per-runtime full-owner scans exceed this linear cap.
      get id() { idReads += 1; return tool.id; },
      result: '',
    }));
    const source = [
      { id: 'u', role: 'user', content: 'go', timestamp: at(0) },
      { id: 'owner', role: 'assistant', content: 'progress', timestamp: at(12), toolCalls: durableTools },
      { id: 'terminal', role: 'assistant', content: 'POST', timestamp: at(40) },
    ];
    const runtime = overlay({
      content, toolCalls: tools,
      __portal: { kind: 'runtime-turn-event-history', terminal: true, complete: true },
    });
    const merged = __gatewayHistoryTest.mergeRuntimeHistoryMessages(source, [runtime], 20, { prune: count * 16 });

    expect(idReads).toBeLessThanOrEqual(count * 24);
    expect(runtimeRows(merged)).toHaveLength(0);
    expect(merged.find((message: any) => message.id === 'owner').toolCalls).toEqual(tools);
    expect(durableTools.every((tool) => tool.result === '')).toBe(true);
  });

  test.each(['incomplete', 'active', 'truncated', 'fallback', 'conflict', 'ambiguous', 'other-turn', 'evicted-owner'])(
    'preserves richer terminal tool evidence when ownership is %s', (shape) => {
      const tool = {
        id: 'stable-tool', name: 'progress_card', arguments: { revision: 1 },
        result: 'Progress card updated', status: 'done', startedAt: ms(10), endedAt: ms(11),
      };
      const owner = {
        id: 'owner', role: 'assistant', content: 'progress', timestamp: at(12),
        toolCalls: [{ ...tool, result: shape === 'conflict' ? 'different durable result' : '' }],
      };
      const source = [
        { id: 'u', role: 'user', content: 'go', timestamp: at(0) },
        owner,
        ...(shape === 'ambiguous' ? [{ ...owner, id: 'second-owner' }] : []),
        ...(shape === 'other-turn' ? [{ id: 'next-u', role: 'user', content: 'again', timestamp: at(15) }] : []),
        ...(shape === 'evicted-owner' ? [{ id: 'later', role: 'assistant', content: 'later', timestamp: at(30) }] : []),
        { id: 'terminal', role: 'assistant', content: 'POST', timestamp: at(40) },
      ];
      const runtime: any = overlay({
        toolCalls: [{
          ...tool,
          ...(shape === 'fallback' ? { identity: 'fallback' } : {}),
          ...(shape === 'other-turn' ? { startedAt: ms(20), endedAt: ms(21) } : {}),
        }],
        __portal: {
          kind: 'runtime-turn-event-history', runId: 'run-test',
          terminal: shape !== 'active', complete: shape !== 'incomplete', truncated: shape === 'truncated',
        },
      });
      const merged = __gatewayHistoryTest.mergeRuntimeHistoryMessages(source, [runtime], shape === 'evicted-owner' ? 2 : 20);
      expect(runtimeRows(merged)[0].toolCalls).toEqual(runtime.toolCalls);
      if (shape !== 'evicted-owner') expect(merged.find((message: any) => message.id === owner.id)).toEqual(owner);
    },
  );

  test('prunes only activity already owned by durable rows in the same-run steer production shape', () => {
    const tool1 = {
      id: 'tool-1', name: 'exec', arguments: { cmd: 'one' }, result: 'one',
      startedAt: ms(8), endedAt: ms(9), status: 'done', order: 1,
    };
    const tool2 = {
      id: 'tool-2', name: 'process', arguments: { id: 'p1' }, result: 'two',
      startedAt: ms(18), endedAt: ms(420), status: 'done', order: 3,
    };
    // Canonical OpenClaw hydration knows the explicit identity and terminal
    // payload, but stamps both times from the tool-result row and has no order.
    const hydratedTool1 = {
      id: tool1.id, name: tool1.name, arguments: tool1.arguments, result: tool1.result,
      startedAt: ms(9), endedAt: ms(9), status: tool1.status,
    };
    const hydratedTool2 = {
      id: tool2.id, name: tool2.name, arguments: tool2.arguments, result: tool2.result,
      startedAt: ms(420), endedAt: ms(420), status: tool2.status,
    };
    const source = [
      { id: 'u1', role: 'user', content: 'start', timestamp: at(0) },
      {
        id: 'a-pre', role: 'assistant', content: 'PRE', timestamp: at(10),
        segments: [{ text: 'PRE', kind: 'text', source: 'text', position: 'before', ts: ms(5) }],
        toolCalls: [hydratedTool1],
      },
      {
        id: 'a-mid', role: 'assistant', content: 'middle', timestamp: at(20),
        segments: [{ text: 'represented thought', kind: 'thinking', source: 'reasoning', position: 'before', ts: ms(15) }],
        toolCalls: [hydratedTool2],
      },
      { id: 'foreign', role: 'user', content: 'FOREIGN_STEER', timestamp: at(400) },
      { id: 'a-post', role: 'assistant', content: 'POST', timestamp: at(430) },
    ];
    const sourceSnapshot = JSON.parse(JSON.stringify(source));
    const result = __gatewayHistoryTest.mergeRuntimeHistoryMessages(source, [overlay({
      segments: [
        { text: 'PRE', kind: 'text', source: 'text', position: 'before', ts: ms(5) },
        { text: 'represented thought', kind: 'thinking', source: 'reasoning', position: 'before', ts: ms(15) },
        { text: 'runtime-only thought', kind: 'thinking', source: 'reasoning', position: 'before', ts: ms(425) },
      ],
      toolCalls: [tool1, tool2],
      timestamp: at(430),
    })], 20);

    expect(source).toEqual(sourceSnapshot);
    sourceSnapshot.forEach((message: any) => {
      expect(result.find((candidate: any) => candidate.id === message.id)).toEqual(message);
    });
    expect(result.filter((message: any) => message.id === 'foreign')).toHaveLength(1);
    expect(result.filter((message: any) => message.content === 'POST')).toHaveLength(1);
    expect(result.flatMap((message: any) => message.toolCalls || []).map((tool: any) => tool.id).sort())
      .toEqual(['tool-1', 'tool-2']);
    expect(result.findIndex((message: any) => message?.__portal?.kind === 'runtime-turn-event-history'))
      .toBeLessThan(result.findIndex((message: any) => message.id === 'a-post'));
    expect(runtimeRows(result)).toEqual([
      expect.objectContaining({
        content: '',
        timestamp: at(425),
        segments: [expect.objectContaining({ text: 'runtime-only thought' })],
        toolCalls: undefined,
      }),
    ]);
  });

  test('requires one exact retained owner and preserves ambiguous or partial evidence', () => {
    const terminal = { id: 'terminal', role: 'assistant', content: 'POST', timestamp: at(40) };
    const merge = (owners: any[], runtime: any) => __gatewayHistoryTest.mergeRuntimeHistoryMessages(
      [{ id: 'u', role: 'user', content: 'go', timestamp: at(0) }, ...owners, terminal],
      [overlay(runtime)],
      20,
    );
    const exactSegment = {
      text: 'exact thought', kind: 'thinking', subject: 'plan',
      source: 'reasoning', position: 'before', ts: ms(10),
    };
    expect(runtimeRows(merge([
      { id: 'owner', role: 'assistant', content: 'owner', timestamp: at(10), segments: [exactSegment] },
    ], { segments: [exactSegment] }))).toHaveLength(0);

    const twoOwners = merge([
      { id: 'owner-1', role: 'assistant', content: 'one', timestamp: at(10), segments: [exactSegment] },
      { id: 'owner-2', role: 'assistant', content: 'two', timestamp: at(11), segments: [{ ...exactSegment, ts: ms(11) }] },
    ], { segments: [exactSegment] });
    expect(runtimeRows(twoOwners)[0].segments).toEqual([exactSegment]);

    const prefix = merge([
      {
        id: 'prefix-owner', role: 'assistant', content: 'owner', timestamp: at(10),
        segments: [{ ...exactSegment, text: 'exact thought extended' }],
      },
    ], { segments: [exactSegment] });
    expect(runtimeRows(prefix)[0].segments).toEqual([exactSegment]);

    const partialTool = {
      id: 'partial-tool', name: 'exec', arguments: { cmd: 'inspect' }, startedAt: ms(10),
    };
    const richTool = { ...partialTool, result: 'ok', endedAt: ms(12), status: 'done' };
    const partial = merge([
      { id: 'partial-owner', role: 'assistant', content: 'owner', timestamp: at(12), toolCalls: [partialTool] },
    ], { toolCalls: [richTool] });
    expect(runtimeRows(partial)[0].toolCalls).toEqual([richTool]);

    const olderTurn = __gatewayHistoryTest.mergeRuntimeHistoryMessages([
      { id: 'old-u', role: 'user', content: 'old', timestamp: at(0) },
      { id: 'old-a', role: 'assistant', content: 'old', timestamp: at(10), segments: [exactSegment] },
      { id: 'new-u', role: 'user', content: 'new', timestamp: at(20) },
      terminal,
    ], [overlay({ segments: [{ ...exactSegment, ts: ms(25) }] })], 20);
    expect(runtimeRows(olderTurn)[0].segments).toHaveLength(1);

    const tupleCollision = merge([
      {
        id: 'tuple-owner', role: 'assistant', content: 'owner', timestamp: at(10),
        segments: [{ ...exactSegment, subject: 'a', text: 'b:c' }],
      },
    ], { segments: [{ ...exactSegment, subject: 'a:b', text: 'c' }] });
    expect(runtimeRows(tupleCollision)[0].segments[0])
      .toEqual(expect.objectContaining({ subject: 'a:b', text: 'c' }));

    const sourceMismatch = merge([
      {
        id: 'source-owner', role: 'assistant', content: 'owner', timestamp: at(10),
        segments: [{ ...exactSegment, source: 'status' }],
      },
    ], { segments: [exactSegment] });
    expect(runtimeRows(sourceMismatch)[0].segments).toEqual([exactSegment]);

    const positionMismatch = merge([
      {
        id: 'position-owner', role: 'assistant', content: 'owner', timestamp: at(10),
        segments: [{ ...exactSegment, position: 'after' }],
      },
    ], { segments: [exactSegment] });
    expect(runtimeRows(positionMismatch)[0].segments).toEqual([exactSegment]);
  });

  test('accepts only explicit terminal activity and rejects malformed runtime tool endings', () => {
    const segment = {
      text: 'terminal PRE', kind: 'text', source: 'text', position: 'before', ts: ms(10),
    };
    const tool = {
      id: 'terminal-tool', name: 'exec', arguments: { cmd: 'inspect' }, result: 'ok',
      startedAt: ms(12), endedAt: ms(13), status: 'done',
    };
    const terminal = {
      id: 'terminal', role: 'assistant', content: 'POST', timestamp: at(40),
      segments: [segment], toolCalls: [tool],
    };
    const represented = __gatewayHistoryTest.mergeRuntimeHistoryMessages([
      { id: 'u', role: 'user', content: 'go', timestamp: at(0) },
      terminal,
    ], [overlay({ segments: [segment], toolCalls: [tool] })], 20);
    expect(runtimeRows(represented)).toHaveLength(0);
    expect(represented.find((message: any) => message.id === 'terminal')).toEqual(terminal);

    const synthesizedTopLevel = __gatewayHistoryTest.mergeRuntimeHistoryMessages([
      { id: 'u', role: 'user', content: 'go', timestamp: at(0) },
      { id: 'terminal', role: 'assistant', content: 'POST', timestamp: at(40) },
    ], [overlay({
      segments: [{ text: 'POST', kind: 'text', source: 'text', position: 'before', ts: ms(40) }],
    })], 20);
    expect(runtimeRows(synthesizedTopLevel)[0].segments).toHaveLength(1);

    for (const endedAt of ['bad', ms(11), ms(400)]) {
      const runtimeTool = { ...tool, startedAt: ms(12), endedAt };
      const invalidEnding = __gatewayHistoryTest.mergeRuntimeHistoryMessages([
        { id: 'u', role: 'user', content: 'go', timestamp: at(0) },
        { id: 'owner', role: 'assistant', content: 'owner', timestamp: at(13), toolCalls: [tool] },
        { id: 'terminal', role: 'assistant', content: 'POST', timestamp: at(40) },
      ], [overlay({ toolCalls: [runtimeTool] })], 20);
      expect(runtimeRows(invalidEnding)[0].toolCalls).toEqual([runtimeTool]);
    }
  });

  test('uses only retained-page owners and keeps a 250-turn limit-100 page overlay-free', () => {
    const owned = { text: 'owned', kind: 'thinking', source: 'reasoning', position: 'before', ts: ms(10) };
    const retained = __gatewayHistoryTest.mergeRuntimeHistoryMessages([
      { id: 'u', role: 'user', content: 'go', timestamp: at(0) },
      { id: 'owner', role: 'assistant', content: 'owner', timestamp: at(10), segments: [owned] },
      { id: 'terminal', role: 'assistant', content: 'POST', timestamp: at(40) },
    ], [overlay({ segments: [owned] })], 3);
    expect(runtimeRows(retained)).toHaveLength(0);

    const pagedOut = __gatewayHistoryTest.mergeRuntimeHistoryMessages([
      { id: 'u', role: 'user', content: 'go', timestamp: at(0) },
      { id: 'owner', role: 'assistant', content: 'owner', timestamp: at(10), segments: [owned] },
      { id: 'filler-1', role: 'assistant', content: 'one', timestamp: at(20) },
      { id: 'filler-2', role: 'assistant', content: 'two', timestamp: at(30) },
      { id: 'terminal', role: 'assistant', content: 'POST', timestamp: at(40) },
    ], [overlay({ segments: [owned] })], 2);
    expect(runtimeRows(pagedOut)[0]).toEqual(expect.objectContaining({ content: 'POST', segments: [owned] }));

    const source: any[] = [];
    const runtime: any[] = [];
    for (let index = 0; index < 250; index += 1) {
      const timestamp = epoch + index * 2000;
      source.push(
        { id: `u-${index}`, role: 'user', content: `question-${index}`, timestamp: new Date(timestamp).toISOString() },
        { id: `a-${index}`, role: 'assistant', content: `answer-${index}`, timestamp: new Date(timestamp + 1000).toISOString() },
      );
      runtime.push(overlay({
        id: `runtime-${index}`,
        content: `answer-${index}`,
        timestamp: new Date(timestamp + 1000).toISOString(),
        __portal: { kind: 'runtime-turn-event-history', runId: `run-${index}` },
      }));
    }
    const page = __gatewayHistoryTest.mergeRuntimeHistoryMessages(source, runtime, 100);
    expect(page).toHaveLength(100);
    expect(page.filter((message: any) => message.role === 'user')).toHaveLength(50);
    expect(page.filter((message: any) => message.role === 'assistant')).toHaveLength(50);
    expect(runtimeRows(page)).toHaveLength(0);
  });

  test('fails closed at same-millisecond and malformed user turn boundaries', () => {
    const sameMillisecond = __gatewayHistoryTest.mergeRuntimeHistoryMessages([
      { id: 'u1', role: 'user', content: 'first', timestamp: at(0) },
      { id: 'u2', role: 'user', content: 'boundary', timestamp: at(40) },
      { id: 'terminal', role: 'assistant', content: 'POST', timestamp: at(41) },
    ], [overlay()], 20);
    expect(runtimeRows(sameMillisecond)).toEqual([expect.objectContaining({ content: 'POST' })]);

    const boundarySegment = { text: 'edge', kind: 'text', source: 'text', position: 'before', ts: ms(20) };
    const segmentResult = __gatewayHistoryTest.mergeRuntimeHistoryMessages([
      { id: 'u1', role: 'user', content: 'first', timestamp: at(0) },
      { id: 'owner', role: 'assistant', content: 'edge', timestamp: at(10), segments: [boundarySegment] },
      { id: 'u2', role: 'user', content: 'boundary', timestamp: at(20) },
      { id: 'terminal', role: 'assistant', content: 'POST', timestamp: at(40) },
    ], [overlay({ segments: [boundarySegment] })], 20);
    expect(runtimeRows(segmentResult)[0].segments).toEqual([boundarySegment]);

    const malformedSource = [
      { id: 'bad-u', role: 'user', content: 'bad timestamp', timestamp: 'not-a-date' },
      { id: 'terminal', role: 'assistant', content: 'POST', timestamp: at(40) },
    ];
    const snapshot = JSON.parse(JSON.stringify(malformedSource));
    const malformed = __gatewayHistoryTest.mergeRuntimeHistoryMessages(malformedSource, [overlay()], 20);
    expect(malformedSource).toEqual(snapshot);
    expect(runtimeRows(malformed)).toEqual([expect.objectContaining({ content: 'POST' })]);
  });

  test('uses coherent PRE proof for cumulative tails without dropping malformed siblings', () => {
    const pre = { text: 'PRE', kind: 'text', source: 'text', position: 'before', ts: ms(5) };
    const source = [
      { id: 'u', role: 'user', content: 'go', timestamp: at(0) },
      { id: 'pre', role: 'assistant', content: 'PRE', timestamp: at(5), segments: [pre] },
      { id: 'terminal', role: 'assistant', content: 'PRE\nPOST', timestamp: at(40), model: 'model-kept' },
    ];
    const sourceSnapshot = JSON.parse(JSON.stringify(source));
    const malformed = { text: 'malformed sibling', kind: 'thinking', source: 'reasoning', position: 'before', ts: 'bad' };
    const outlier = { text: 'outlier sibling', kind: 'thinking', source: 'reasoning', position: 'before', ts: ms(400) };
    const result = __gatewayHistoryTest.mergeRuntimeHistoryMessages(source, [overlay({
      content: 'PRE\nPOST',
      segments: [pre, malformed, outlier],
    })], 20);

    expect(source).toEqual(sourceSnapshot);
    expect(result.find((message: any) => message.id === 'pre')).toEqual(sourceSnapshot[1]);
    expect(result.find((message: any) => message.id === 'terminal')).toEqual({
      ...sourceSnapshot[2],
      content: 'POST',
    });
    expect(runtimeRows(result)[0]).toEqual(expect.objectContaining({
      content: '',
      segments: [malformed, outlier],
    }));
  });

  test.each([
    ['turnIndex', { turnIndex: 0 }],
    ['ownership', { ownership: 0 }],
    ['match', { match: 0 }],
    ['prune', { prune: 0 }],
  ])('fails closed atomically when the %s work budget is exhausted', (_phase, workLimits) => {
    const source = [
      { id: 'u', role: 'user', content: 'go', timestamp: at(0) },
      { id: 'terminal', role: 'assistant', content: 'POST', timestamp: at(40) },
    ];
    const runtime = overlay({
      segments: [{ text: 'keep me', kind: 'thinking', source: 'reasoning', position: 'before', ts: ms(10) }],
      toolCalls: [{ id: 'tool', name: 'exec', arguments: { cmd: 'safe' }, result: 'ok', startedAt: ms(12), endedAt: ms(13), status: 'done' }],
    });
    const sourceSnapshot = JSON.parse(JSON.stringify(source));
    const runtimeSnapshot = JSON.parse(JSON.stringify(runtime));
    const result = __gatewayHistoryTest.mergeRuntimeHistoryMessages(source, [runtime], 20, workLimits);

    expect(source).toEqual(sourceSnapshot);
    expect(runtime).toEqual(runtimeSnapshot);
    expect(result.find((message: any) => message.id === 'terminal')).toEqual(sourceSnapshot[1]);
    expect(runtimeRows(result)).toEqual([runtimeSnapshot]);
  });

  test('keeps ambiguous no-ID and explicit-ID/fallback tool keyspaces standalone', () => {
    const terminal = { id: 'terminal', role: 'assistant', content: 'POST', timestamp: at(40) };
    const merge = (owner: any, runtimeTool: any) => {
      const source = [{ id: 'u', role: 'user', content: 'go', timestamp: at(0) }, owner, terminal];
      const snapshot = JSON.parse(JSON.stringify(source));
      const result = __gatewayHistoryTest.mergeRuntimeHistoryMessages(source, [overlay({ toolCalls: [runtimeTool] })], 20);
      snapshot.forEach((message: any) => {
        expect(result.find((candidate: any) => candidate.id === message.id)).toEqual(message);
      });
      expect(runtimeRows(result)[0].toolCalls).toEqual([runtimeTool]);
    };

    merge({
      id: 'no-id-owner', role: 'assistant', content: 'owner', timestamp: at(12),
      toolCalls: [
        { name: 'exec', arguments: { cmd: 'one' }, result: 'one', startedAt: ms(10), endedAt: ms(11), status: 'done' },
        { name: 'exec', arguments: { cmd: 'two' }, result: 'two', startedAt: ms(10), endedAt: ms(11), status: 'done' },
      ],
    }, { name: 'exec', arguments: { cmd: 'one' }, result: 'one', startedAt: ms(10), endedAt: ms(11), status: 'done' });

    merge({
      id: 'explicit-owner', role: 'assistant', content: 'owner', timestamp: at(12),
      toolCalls: [{ id: `exec:${ms(10)}:${ms(11)}`, name: 'exec', arguments: { cmd: 'same' }, result: 'ok', startedAt: ms(10), endedAt: ms(11), status: 'done' }],
    }, { name: 'exec', arguments: { cmd: 'same' }, result: 'ok', startedAt: ms(10), endedAt: ms(11), status: 'done' });

    const standalone = overlay({
      content: '',
      toolCalls: [{ id: 'runtime-only', name: 'exec', arguments: { cmd: 'runtime' } }],
    });
    const collapsed = __gatewayHistoryTest.collapseFragmentedToolOnlyAssistantHistory([
      {
        id: 'durable-tool-only', role: 'assistant', content: '', timestamp: at(10),
        toolCalls: [{ id: 'durable-only', name: 'exec', arguments: { cmd: 'durable' } }],
      },
      standalone,
    ]);
    expect(collapsed).toHaveLength(2);
    expect(collapsed[1]).toEqual(standalone);
  });
});
