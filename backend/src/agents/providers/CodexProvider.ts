import { NativeCliAdapterProvider } from './native/NativeCliAdapterProvider';
import { codexAdapter } from './native/adapters/codex';

export class CodexProvider extends NativeCliAdapterProvider {
  constructor() {
    super(codexAdapter);
  }
}
