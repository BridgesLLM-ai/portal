import type { AgentSessionId } from '../AgentProvider.interface';
import { NativeCliAdapterProvider } from './native/NativeCliAdapterProvider';
import { codexAdapter } from './native/adapters/codex';
import { stopCodexProjectRuntimesForContext } from './native/projectSandbox/CodexProjectEgressRuntime';

export class CodexProvider extends NativeCliAdapterProvider {
  constructor() {
    super(codexAdapter);
  }

  override async terminateSession(sessionId: AgentSessionId): Promise<void> {
    const session = this.requireSession(sessionId);
    if (session.executionContext?.scope === 'PROJECT_SANDBOX') {
      // A Portal restart can lose the local docker-exec child and its abort
      // closure while the in-container Codex process keeps running. Stop only
      // fully attested runtimes for this immutable actor/project before the
      // session record is allowed to disappear.
      await stopCodexProjectRuntimesForContext(session.executionContext);
    }
    await super.terminateSession(sessionId);
  }
}
