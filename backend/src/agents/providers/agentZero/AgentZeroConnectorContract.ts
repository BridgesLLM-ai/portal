export const AGENT_ZERO_CONNECTOR_PROTOCOL = 'a0-connector.v1';
export const AGENT_ZERO_CONNECTOR_VERSION = '0.1.0';
export const AGENT_ZERO_CONNECTOR_PATH = '/api/plugins/_a0_connector/v1';
export const AGENT_ZERO_WEBSOCKET_NAMESPACE = '/ws';
export const AGENT_ZERO_WEBSOCKET_HANDLER = 'plugins/_a0_connector/ws_connector';
export const AGENT_ZERO_VERSION = '2.5';
export const AGENT_ZERO_DEFAULT_BASE_URL = 'http://127.0.0.1:50001';

export interface AgentZeroConnectorCapabilities {
  protocol: typeof AGENT_ZERO_CONNECTOR_PROTOCOL;
  connectorVersion: typeof AGENT_ZERO_CONNECTOR_VERSION;
  agentZeroVersion: typeof AGENT_ZERO_VERSION;
  auth: ['session'];
  authRequired: boolean;
  transports: string[];
  websocketNamespace: typeof AGENT_ZERO_WEBSOCKET_NAMESPACE;
  websocketHandlers: string[];
  features: string[];
}

export interface AgentZeroCapabilitiesValidationOptions {
  requireAuthentication?: boolean;
}

export class AgentZeroConnectorContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentZeroConnectorContractError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringArray(value: unknown, maximum = 256): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, maximum)
    .map((item) => String(item || '').trim())
    .filter(Boolean);
}

export function isAgentZeroLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (normalized === 'localhost' || normalized === '::1') return true;
  return /^127(?:\.\d{1,3}){3}$/.test(normalized)
    && normalized.split('.').slice(1).every((part) => Number(part) <= 255);
}

export function normalizeAgentZeroBaseUrl(raw: string, allowRemote: boolean): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new AgentZeroConnectorContractError('Agent Zero base URL is invalid.');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new AgentZeroConnectorContractError('Agent Zero base URL must use HTTP or HTTPS.');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new AgentZeroConnectorContractError(
      'Agent Zero base URL cannot contain credentials, a query, or a fragment.',
    );
  }
  if (parsed.pathname && parsed.pathname !== '/') {
    throw new AgentZeroConnectorContractError('Agent Zero base URL must not contain a path.');
  }

  const loopback = isAgentZeroLoopbackHost(parsed.hostname);
  if (!loopback && !allowRemote) {
    throw new AgentZeroConnectorContractError(
      'Agent Zero must use a loopback base URL unless remote access is explicitly enabled.',
    );
  }
  if (!loopback && parsed.protocol !== 'https:') {
    throw new AgentZeroConnectorContractError('Remote Agent Zero access requires HTTPS.');
  }

  return parsed.origin;
}

export function normalizeAgentZeroVersion(value: unknown): typeof AGENT_ZERO_VERSION | null {
  const version = String(value || '').trim();
  return /^v?2\.5$/.test(version) ? AGENT_ZERO_VERSION : null;
}

/**
 * Validate the exact connector contract published by Agent Zero v2.5.
 *
 * The capabilities endpoint is intentionally public. Authentication is proved
 * separately by a protected `chats_list` request using a browser-style session.
 */
export function validateAgentZeroCapabilities(
  value: unknown,
  options: AgentZeroCapabilitiesValidationOptions = {},
): AgentZeroConnectorCapabilities {
  if (!isRecord(value)) {
    throw new AgentZeroConnectorContractError('Agent Zero returned an invalid capabilities response.');
  }

  const protocol = String(value.protocol || '').trim();
  if (protocol !== AGENT_ZERO_CONNECTOR_PROTOCOL) {
    throw new AgentZeroConnectorContractError(
      `Unsupported Agent Zero connector protocol '${protocol || 'unknown'}'; expected ${AGENT_ZERO_CONNECTOR_PROTOCOL}.`,
    );
  }

  const connectorVersion = String(value.version || '').trim().replace(/^v/, '');
  if (connectorVersion !== AGENT_ZERO_CONNECTOR_VERSION) {
    throw new AgentZeroConnectorContractError(
      `Unsupported Agent Zero connector version '${connectorVersion || 'unknown'}'; expected ${AGENT_ZERO_CONNECTOR_VERSION}.`,
    );
  }

  const websocketNamespace = String(value.websocket_namespace || '').trim();
  if (websocketNamespace !== AGENT_ZERO_WEBSOCKET_NAMESPACE) {
    throw new AgentZeroConnectorContractError(
      `Unsupported Agent Zero WebSocket namespace '${websocketNamespace || 'unknown'}'.`,
    );
  }

  const websocketHandlers = stringArray(value.websocket_handlers);
  if (!websocketHandlers.includes(AGENT_ZERO_WEBSOCKET_HANDLER)) {
    throw new AgentZeroConnectorContractError(
      'Agent Zero connector does not advertise its required WebSocket handler.',
    );
  }

  const auth = stringArray(value.auth);
  if (auth.length !== 1 || auth[0] !== 'session') {
    throw new AgentZeroConnectorContractError(
      "Agent Zero connector must advertise exactly the protected 'session' auth contract.",
    );
  }
  if (typeof value.auth_required !== 'boolean') {
    throw new AgentZeroConnectorContractError(
      'Agent Zero connector capabilities must include boolean auth_required.',
    );
  }
  if (options.requireAuthentication && value.auth_required !== true) {
    throw new AgentZeroConnectorContractError(
      'Agent Zero must require session authentication before Portal can use it.',
    );
  }

  const transports = stringArray(value.transports);
  if (!transports.includes('http') || !transports.includes('websocket')) {
    throw new AgentZeroConnectorContractError(
      'Agent Zero connector does not advertise both HTTP and WebSocket transports.',
    );
  }

  const agentZeroVersion = normalizeAgentZeroVersion(value.agent_zero_version);
  if (!agentZeroVersion) {
    throw new AgentZeroConnectorContractError(
      `Agent Zero runtime is outside the Portal-tested ${AGENT_ZERO_VERSION} release.`,
    );
  }

  const features = stringArray(value.features);
  if (features.includes('connector_login')) {
    throw new AgentZeroConnectorContractError(
      'Agent Zero connector advertises the removed connector_login feature.',
    );
  }

  return {
    protocol: AGENT_ZERO_CONNECTOR_PROTOCOL,
    connectorVersion: AGENT_ZERO_CONNECTOR_VERSION,
    agentZeroVersion,
    auth: ['session'],
    authRequired: value.auth_required,
    transports,
    websocketNamespace: AGENT_ZERO_WEBSOCKET_NAMESPACE,
    websocketHandlers,
    features,
  };
}
