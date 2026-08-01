import {
  TERMINAL_ACTIONS,
  buildTerminalProbeEnv,
  classifyTerminalCommand,
  parseSystemdServiceCapability,
  parseToolHelpCommands,
  rankTerminalSuggestions,
  resolveTerminalActions,
  TerminalServiceCapability,
  TerminalToolCapability,
  unwrapTerminalCommand,
} from '../services/terminalCapabilities';

describe('terminal runtime capability contract', () => {
  test('discovers top-level commands from an installed tool help page', () => {
    const output = `Usage: openclaw [options] [command]

Commands:
  gateway [options]     Manage the gateway
  models                Inspect and configure models
  status                Show runtime status

Options:
  -V, --version         output the version number`;

    expect(parseToolHelpCommands('openclaw', output)).toEqual([
      'openclaw gateway',
      'openclaw models',
      'openclaw status',
    ]);
    expect(parseToolHelpCommands('agy', 'Available subcommands:\n  models    List available models\n  plugins   Manage plugins')).toEqual([
      'agy models',
      'agy plugins',
    ]);
  });

  test('classifies read-only, service-changing, and destructive commands', () => {
    expect(classifyTerminalCommand('journalctl -u bridgesllm-product -n 100')).toEqual({
      risk: 'read_only', confirmation: 'none', message: null,
    });
    expect(classifyTerminalCommand('openclaw status && systemctl restart bridgesllm-product')).toMatchObject({
      risk: 'service_change', confirmation: 'explicit',
    });
    expect(classifyTerminalCommand('openclaw update')).toMatchObject({
      risk: 'service_change', confirmation: 'explicit',
    });
    expect(classifyTerminalCommand('cd /tmp && rm -rf ./cache')).toMatchObject({
      risk: 'destructive', confirmation: 'typed',
    });
    expect(classifyTerminalCommand('rm notes.txt')).toMatchObject({
      risk: 'destructive', confirmation: 'typed',
    });
  });

  test('unwraps common privilege and environment launchers before classification', () => {
    expect(unwrapTerminalCommand('env FOO=bar command sudo -u root systemctl restart openclaw')).toBe(
      'systemctl restart openclaw',
    );
    expect(classifyTerminalCommand('sudo systemctl restart bridgesllm-product')).toMatchObject({
      risk: 'service_change', confirmation: 'explicit',
    });
    expect(classifyTerminalCommand('doas git pull --ff-only')).toMatchObject({
      risk: 'service_change', confirmation: 'explicit',
    });
    expect(classifyTerminalCommand('sudo git -C /srv/project checkout release')).toMatchObject({
      risk: 'service_change', confirmation: 'explicit',
    });
    expect(classifyTerminalCommand('env DEPLOY=1 systemctl --user restart worker')).toMatchObject({
      risk: 'service_change', confirmation: 'explicit',
    });
    expect(classifyTerminalCommand('env FOO=bar command sudo -u root docker compose up -d')).toMatchObject({
      risk: 'service_change', confirmation: 'explicit',
    });
    expect(classifyTerminalCommand('sudo docker compose exec api npm ci')).toMatchObject({
      risk: 'service_change', confirmation: 'explicit',
    });
    expect(classifyTerminalCommand('doas python3 -m pip install package-name')).toMatchObject({
      risk: 'service_change', confirmation: 'explicit',
    });
    expect(classifyTerminalCommand('command git clone https://example.invalid/repo.git')).toMatchObject({
      risk: 'service_change', confirmation: 'explicit',
    });
    expect(classifyTerminalCommand('env -i PATH=/usr/bin sudo rm -rf /tmp/example')).toMatchObject({
      risk: 'destructive', confirmation: 'typed',
    });
    expect(classifyTerminalCommand('command sudo git -C /srv/project push -f origin main')).toMatchObject({
      risk: 'destructive', confirmation: 'typed',
    });
    expect(classifyTerminalCommand('command -v systemctl')).toEqual({
      risk: 'read_only', confirmation: 'none', message: null,
    });
    expect(classifyTerminalCommand("bash -c 'rm -rf /tmp/example'")).toMatchObject({
      risk: 'destructive', confirmation: 'typed',
    });
    expect(classifyTerminalCommand('echo $(sudo systemctl restart docker)')).toMatchObject({
      risk: 'service_change', confirmation: 'explicit',
    });
    expect(classifyTerminalCommand('find /tmp/cache -type f -delete')).toMatchObject({
      risk: 'destructive', confirmation: 'typed',
    });
    expect(classifyTerminalCommand('printf "%s\\n" /tmp/a | xargs rm')).toMatchObject({
      risk: 'destructive', confirmation: 'typed',
    });
  });

  test('uses a disposable probe home without inheriting credentials or runtime state', () => {
    const previousSecret = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'must-not-be-inherited';
    try {
      const env = buildTerminalProbeEnv('/tmp/terminal-probe-test', '/test/bin');
      expect(env).toMatchObject({
        PATH: '/test/bin',
        HOME: '/tmp/terminal-probe-test',
        XDG_CONFIG_HOME: '/tmp/terminal-probe-test/.config',
        XDG_CACHE_HOME: '/tmp/terminal-probe-test/.cache',
        XDG_DATA_HOME: '/tmp/terminal-probe-test/.local/share',
        XDG_STATE_HOME: '/tmp/terminal-probe-test/.local/state',
        TERM: 'dumb',
        NO_COLOR: '1',
      });
      expect(env.OPENAI_API_KEY).toBeUndefined();
      expect(env.OPENCLAW_HOME).toBeUndefined();
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    } finally {
      if (previousSecret === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousSecret;
    }
  });

  test('ranks actual PATH and tool-help discoveries instead of a static encyclopedia', () => {
    const tool: TerminalToolCapability = {
      id: 'openclaw',
      label: 'OpenClaw',
      category: 'openclaw',
      installed: true,
      executable: '/usr/bin/openclaw',
      version: '2026.7.1',
      helpCommand: 'openclaw --help',
      sourceUrl: 'https://docs.openclaw.ai/',
      commands: ['openclaw gateway', 'openclaw models'],
    };

    expect(rankTerminalSuggestions('openclaw gate', [tool], ['bash'], 5)[0]).toMatchObject({
      command: 'openclaw gateway',
      source: 'tool-help',
    });
    expect(rankTerminalSuggestions('bash', [tool], ['bash'], 5)[0]).toMatchObject({
      command: 'bash',
      source: 'path',
    });
  });

  test('maps live tools and services to action availability', () => {
    const tools: TerminalToolCapability[] = [
      {
        id: 'systemctl', label: 'systemd', category: 'system', installed: true,
        executable: '/usr/bin/systemctl', version: 'systemd 255', helpCommand: 'systemctl --help',
        sourceUrl: 'https://example.invalid/systemd', commands: [],
      },
      {
        id: 'curl', label: 'curl', category: 'network', installed: true,
        executable: '/usr/bin/curl', version: 'curl 8', helpCommand: 'curl --help',
        sourceUrl: 'https://example.invalid/curl', commands: [],
      },
    ];
    const services: TerminalServiceCapability[] = [
      {
        id: 'portal', label: 'Portal', unit: 'bridgesllm-product.service', installed: true,
        status: 'active', activeState: 'active', subState: 'running',
      },
      {
        id: 'openclaw-gateway', label: 'OpenClaw', unit: 'openclaw-gateway.service', installed: false,
        status: 'not-installed', activeState: 'inactive', subState: 'dead',
      },
    ];
    const actions = resolveTerminalActions(TERMINAL_ACTIONS, tools, services, ['journalctl']);
    expect(actions.find((action) => action.id === 'portal-health')).toMatchObject({
      available: true, unmetRequirements: [],
    });
    expect(actions.find((action) => action.id === 'restart-openclaw')).toMatchObject({
      available: false, unmetRequirements: ['service:openclaw-gateway'],
    });
    expect(rankTerminalSuggestions('', tools, ['journalctl'], 20, actions).some((entry) => entry.command.includes('openclaw-gateway'))).toBe(false);
  });

  test('parses systemd service state without treating missing units as installed', () => {
    expect(parseSystemdServiceCapability(
      { id: 'portal', label: 'Portal', unit: 'bridgesllm-product.service' },
      'LoadState=loaded\nActiveState=active\nSubState=running\n',
    )).toMatchObject({ installed: true, status: 'active', activeState: 'active', subState: 'running' });
    expect(parseSystemdServiceCapability(
      { id: 'missing', label: 'Missing', unit: 'missing.service' },
      'LoadState=not-found\nActiveState=inactive\nSubState=dead\n',
    )).toMatchObject({ installed: false, status: 'not-installed' });
  });

  test('keeps curated actions bounded and requires confirmation for mutations', () => {
    expect(TERMINAL_ACTIONS.length).toBeLessThanOrEqual(12);
    expect(TERMINAL_ACTIONS.some((action) => action.command.includes('doctor --fix'))).toBe(false);
    const ollamaRuntime = TERMINAL_ACTIONS.find((action) => action.id === 'ollama-runtime');
    expect(ollamaRuntime).toMatchObject({
      title: 'Local Ollama runtime',
      description: expect.stringContaining('Portal host loopback'),
    });
    expect(ollamaRuntime?.command).toContain(
      'curl -fsS --noproxy "*" --max-time 5 --max-redirs 0 http://127.0.0.1:11434/api/version',
    );
    expect(ollamaRuntime?.command).toContain(
      'env OLLAMA_HOST=http://127.0.0.1:11434 timeout 5s ollama ps',
    );
    for (const action of TERMINAL_ACTIONS) {
      if (action.risk === 'read_only') expect(action.confirmation).toBe('none');
      else expect(action.confirmation).not.toBe('none');
    }
  });
});
