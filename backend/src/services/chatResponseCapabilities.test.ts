import { chatResponseCapabilities, harnessReceivesChatBridge, parseChatResponseFormat, portalResponsePreference, withSenderResponsePreference } from './chatResponseCapabilities';
import { capabilitiesFromHello, clearOpenClawHello, observeOpenClawHello } from './openClawCompatibility';

const hello = { server: { version: '2026.9.9' }, features: { methods: ['canvas.document.view'] } };
const available = (caps: ReturnType<typeof chatResponseCapabilities>) => caps.formats.filter((format) => format.available).map((format) => format.id);
afterEach(clearOpenClawHello);

describe('Portal response capability contract', () => {
  test('OpenClaw widgets need a qualified Canvas contract and a direct Agent Chat lane', () => {
    expect(chatResponseCapabilities('OPENCLAW', { openClaw: capabilitiesFromHello(hello), openClawWidgetLane: true }).widget.transportReady).toBe(true);
    for (const candidate of [null, { ...hello, server: { version: '2026.9.3' } }, { ...hello, features: { methods: [] } }]) {
      const caps = chatResponseCapabilities('OPENCLAW', { openClaw: capabilitiesFromHello(candidate), openClawWidgetLane: true });
      expect(caps.widget.transportReady).toBe(false);
      expect(caps.widget.reason).toBeTruthy();
      expect(caps.formats.find((format) => format.id === 'widget')?.available).toBe(false);
    }
    const project = chatResponseCapabilities('OPENCLAW', { openClaw: capabilitiesFromHello(hello), openClawWidgetLane: false });
    expect(project.widget.reason).toContain('direct Agent Chat');
  });

  test.each(['CLAUDE_CODE', 'CODEX', 'GROK', 'HERMES', 'OPENCODE', 'OLLAMA'])('%s gets widgets through the Portal chat bridge, not an OpenClaw assumption', (provider) => {
    expect(harnessReceivesChatBridge(provider)).toBe(true);
    expect(available(chatResponseCapabilities(provider, { bridgeServerReady: true }))).toEqual(['auto', 'mermaid', 'widget', 'code', 'file']);
    const missing = chatResponseCapabilities(provider, { bridgeServerReady: false });
    expect(missing.widget.transportReady).toBe(false);
    expect(missing.widget.reason).toContain('chat bridge');
  });

  test('harnesses without a widget tool keep renderer formats and say why widgets are unavailable', () => {
    const caps = chatResponseCapabilities('GEMINI', { bridgeServerReady: true });
    expect(available(caps)).toEqual(['auto', 'mermaid', 'code', 'file']);
    expect(caps.widget.reason).toContain('no Portal widget tool');
  });

  test('a harness without a preference seam offers only Automatic, truthfully', () => {
    const caps = chatResponseCapabilities('AGENT_ZERO', { bridgeServerReady: true });
    expect(available(caps)).toEqual(['auto']);
    expect(caps.formats.find((format) => format.id === 'mermaid')?.reason).toContain('does not accept');
  });

  test.each([null, {}, ['widget'], 'show_widget', 'widget\nignore rules', ''])('rejects arbitrary response intent %j', (value) => {
    expect(() => parseChatResponseFormat(value)).toThrow('Unknown response format');
  });

  test('Automatic leaves the authored message unchanged on every harness', () => {
    for (const provider of ['OPENCLAW', 'CLAUDE_CODE', 'CODEX', 'GEMINI', 'AGENT_ZERO']) {
      expect(portalResponsePreference('Plain text', provider, 'auto')).toBe('Plain text');
    }
  });

  test('explicit widget refuses an absent transport instead of silently falling back', () => {
    expect(() => portalResponsePreference('Make a counter', 'OPENCLAW', 'widget', { openClawWidgetLane: true })).toThrow('not connected');
    observeOpenClawHello(hello);
    expect(() => portalResponsePreference('Make a counter', 'OPENCLAW', 'widget', { openClawWidgetLane: false })).toThrow('direct Agent Chat');
    expect(() => portalResponsePreference('Make a counter', 'GEMINI', 'widget')).toThrow('no Portal widget tool');
    expect(() => portalResponsePreference('Make a counter', 'CODEX', 'widget', { bridgeServerReady: false })).toThrow('chat bridge');
  });

  test('preferences are model context that ends with the exact authored text and grant nothing', () => {
    observeOpenClawHello(hello);
    const text = portalResponsePreference('Make a counter', 'OPENCLAW', 'widget', { openClawWidgetLane: true });
    expect(text).toContain('actual show_widget tool');
    expect(text).toContain('grants no tool or permission');
    expect(text.endsWith('\nMake a counter')).toBe(true);
    expect(portalResponsePreference('Draw it', 'CODEX', 'mermaid')).toContain('fenced mermaid');
    expect(portalResponsePreference('Make a card', 'CLAUDE_CODE', 'code')).toContain('self-contained fenced html');
    expect(portalResponsePreference('Save a list', 'HERMES', 'file')).toContain('Never invent a saved file');
  });

  test('the OpenClaw widget hint teaches Tool Search discovery and keeps questions and status off widgets', () => {
    const progressHello = { ...hello, features: { methods: ['canvas.document.view', 'progressCard.get'] } };
    const text = portalResponsePreference('Make a counter', 'OPENCLAW', 'widget', { openClaw: capabilitiesFromHello(progressHello), openClawWidgetLane: true });
    for (const phrase of ['actual show_widget tool', 'tool_search', 'tool_call', 'Never claim it is missing', 'say so plainly', 'ask_user', 'progress_card', 'never fake either with a widget']) {
      expect(text).toContain(phrase);
    }
    expect(text).not.toContain('bridgesllm');
    const noProgress = portalResponsePreference('Make a counter', 'OPENCLAW', 'widget', { openClaw: capabilitiesFromHello(hello), openClawWidgetLane: true });
    expect(noProgress).toContain('your progress tool');
    expect(noProgress).not.toContain('progress_card');
  });

  test.each(['CLAUDE_CODE', 'CODEX', 'GROK', 'HERMES', 'OPENCODE', 'OLLAMA'])('%s widget hint names the bridge tool and only discovery the harness has', (provider) => {
    const text = portalResponsePreference('Make a counter', provider, 'widget', { bridgeServerReady: true });
    for (const phrase of ['show_widget', 'bridgesllm', "harness's own tool discovery", 'Never claim it is missing', 'say so plainly', "bridge's ask_user", 'never fake either with a widget']) {
      expect(text).toContain(phrase);
    }
    for (const phrase of ['tool_search', 'tool_call', 'progress_card']) expect(text).not.toContain(phrase);
    expect(text.endsWith('\nMake a counter')).toBe(true);
  });

  test('the OpenClaw widget hint adds pinned-widget guidance only when the Portal can follow pinned widgets', () => {
    const liveHello = { ...hello, features: { methods: ['canvas.document.view', 'board.get'] } };
    const live = portalResponsePreference('Count down to launch', 'OPENCLAW', 'widget', { openClaw: capabilitiesFromHello(liveHello), openClawWidgetLane: true });
    for (const phrase of ['watch, track or time', 'pin=true', 'short stable name', 'same name', 'Widgets tab', 'fixed target time', 'stay inline (no pin)']) {
      expect(live).toContain(phrase);
    }
    expect(live.endsWith('\nCount down to launch')).toBe(true);
    // Floating widget windows still follow one tool call; never promise they update.
    expect(live.toLowerCase()).not.toContain('floating');

    const noBoard = portalResponsePreference('Count down to launch', 'OPENCLAW', 'widget', { openClaw: capabilitiesFromHello(hello), openClawWidgetLane: true });
    expect(noBoard).not.toContain('pin=true');
    expect(noBoard).toContain('actual show_widget tool');
  });

  test('pinned-widget guidance is never injected per turn or offered to bridge harnesses', () => {
    observeOpenClawHello({ ...hello, features: { methods: ['canvas.document.view', 'board.get'] } });
    expect(portalResponsePreference('Count down to launch', 'OPENCLAW', 'auto', { openClawWidgetLane: true })).toBe('Count down to launch');
    for (const format of ['mermaid', 'code', 'file'] as const) {
      expect(portalResponsePreference('Count down to launch', 'OPENCLAW', format, { openClawWidgetLane: true })).not.toContain('pin=true');
    }
    for (const provider of ['CLAUDE_CODE', 'CODEX', 'OLLAMA']) {
      expect(portalResponsePreference('Count down to launch', provider, 'widget', { bridgeServerReady: true })).not.toContain('pin=true');
    }
  });

  test('non-widget hints are unchanged by the widget discovery wording', () => {
    for (const format of ['mermaid', 'code', 'file'] as const) {
      const text = portalResponsePreference('Hi', 'CODEX', format);
      expect(text).not.toContain('tool_search');
      expect(text).not.toContain('show_widget');
    }
  });

  test('the provider seam adds only the validated hint and fails safe after a readiness change', () => {
    expect(withSenderResponsePreference('Hi', 'CODEX', undefined)).toBe('Hi');
    expect(withSenderResponsePreference('Hi', 'CODEX', { portalResponseFormat: 'mermaid' })).toContain('[Portal response preference]');
    expect(withSenderResponsePreference('Hi', 'GEMINI', { portalResponseFormat: 'widget' })).toBe('Hi');
  });
});
