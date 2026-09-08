import { AcpAgentProvider } from './native/acp/AcpAgentProvider';
import { OPENCODE_ACP_PROFILE } from './native/acp/AcpHarnessProfiles';
import { openCodeAdapter } from './native/adapters/opencode';

/** Exact-pinned OpenCode ACP provider for privileged Agent Chat sessions. */
export class OpenCodeProvider extends AcpAgentProvider {
  constructor() {
    super({
      providerName: 'OPENCODE',
      adapter: openCodeAdapter,
      profile: OPENCODE_ACP_PROFILE,
      securityTag: 'opencode-acp-host-operator',
    });
  }
}
