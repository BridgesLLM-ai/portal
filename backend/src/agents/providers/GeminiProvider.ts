import { NativeCliAdapterProvider } from './native/NativeCliAdapterProvider';
import { geminiAdapter } from './native/adapters/gemini';

export class GeminiProvider extends NativeCliAdapterProvider {
  constructor() {
    super(geminiAdapter);
  }
}
