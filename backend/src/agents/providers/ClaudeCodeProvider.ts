import { NativeCliAdapterProvider } from './native/NativeCliAdapterProvider';
import { claudeCodeAdapter } from './native/adapters/claude';

export class ClaudeCodeProvider extends NativeCliAdapterProvider {
  constructor() {
    super(claudeCodeAdapter);
  }
}
