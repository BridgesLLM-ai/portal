import { AcpAgentProvider } from './native/acp/AcpAgentProvider';
import { HERMES_ACP_PROFILE } from './native/acp/AcpHarnessProfiles';
import { hermesAdapter } from './native/adapters/hermes';

/** Exact-pinned Hermes ACP provider for privileged Agent Chat sessions. */
export class HermesProvider extends AcpAgentProvider {
  constructor() {
    super({
      providerName: 'HERMES',
      adapter: hermesAdapter,
      profile: HERMES_ACP_PROFILE,
      securityTag: 'hermes-acp-host-operator',
    });
  }
}
