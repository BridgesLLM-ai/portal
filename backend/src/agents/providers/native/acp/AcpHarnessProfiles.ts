import { PORTAL_TOOL_VERSIONS } from '../../../../config/toolVersions';
import type { AcpHarnessProfile } from './AcpStdioBroker';

export const HERMES_ACP_VERSION = PORTAL_TOOL_VERSIONS.hermes;
export const OPENCODE_ACP_VERSION = PORTAL_TOOL_VERSIONS.openCode;

const GENERAL_SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const GROK_SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export const GROK_ACP_PROFILE: AcpHarnessProfile = Object.freeze({
  id: 'GROK',
  displayName: 'Grok Build',
  sessionLabel: 'Grok',
  providerTag: 'grok-build',
  executable: 'grok',
  buildArgs: ({ model }) => {
    const args = ['--no-auto-update', 'agent'];
    if (model) args.push('--model', model);
    args.push('stdio');
    return args;
  },
  protocolVersion: 1,
  expectedAgentVersion: PORTAL_TOOL_VERSIONS.grokBuild,
  agentVersionSource: 'meta-agent-version',
  requiredCapabilities: ['loadSession'],
  authentication: { kind: 'none' },
  sessionIdPattern: GROK_SESSION_ID_PATTERN,
  modelControl: 'launch',
  supportsSessionList: false,
  supportsSessionClose: false,
  normalizeLaunchModel: (model) => {
    const lower = model.toLowerCase();
    if (lower.startsWith('xai/') || lower.startsWith('grok/')) {
      return model.split('/').slice(1).join('/');
    }
    return model;
  },
} satisfies AcpHarnessProfile);

export const HERMES_ACP_PROFILE: AcpHarnessProfile = Object.freeze({
  id: 'HERMES',
  displayName: 'Hermes',
  providerTag: 'hermes',
  executable: 'hermes',
  buildArgs: () => ['acp'],
  protocolVersion: 1,
  expectedAgentName: 'hermes-agent',
  expectedAgentVersion: HERMES_ACP_VERSION,
  agentVersionSource: 'agent-info',
  requiredCapabilities: [
    'loadSession',
    'sessionCapabilities.list',
    'sessionCapabilities.resume',
    'sessionCapabilities.fork',
  ],
  authentication: {
    kind: 'advertised-agent',
    excludedMethodIds: ['hermes-setup'],
  },
  sessionIdPattern: GENERAL_SESSION_ID_PATTERN,
  modelControl: 'session-model',
  supportsSessionList: true,
  supportsSessionClose: false,
} satisfies AcpHarnessProfile);

export const OPENCODE_ACP_PROFILE: AcpHarnessProfile = Object.freeze({
  id: 'OPENCODE',
  displayName: 'OpenCode',
  providerTag: 'opencode',
  executable: 'opencode',
  buildArgs: ({ cwd }) => [
    'acp',
    '--pure',
    '--cwd', cwd,
    '--hostname', '127.0.0.1',
    '--port', '0',
    '--no-mdns',
  ],
  protocolVersion: 1,
  expectedAgentName: 'OpenCode',
  expectedAgentVersion: OPENCODE_ACP_VERSION,
  agentVersionSource: 'agent-info',
  requiredCapabilities: [
    'loadSession',
    'sessionCapabilities.close',
    'sessionCapabilities.list',
    'sessionCapabilities.resume',
    'sessionCapabilities.fork',
  ],
  authentication: { kind: 'fixed', methodId: 'opencode-login' },
  sessionIdPattern: GENERAL_SESSION_ID_PATTERN,
  modelControl: 'config-option',
  modelConfigOptionId: 'model',
  supportsSessionList: true,
  supportsSessionClose: true,
} satisfies AcpHarnessProfile);
