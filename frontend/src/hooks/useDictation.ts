import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

type Phase = 'idle' | 'requesting' | 'starting' | 'listening' | 'error';
type Recognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  start(): void;
  abort(): void;
};
type SpeechWindow = {
  SpeechRecognition?: new () => Recognition;
  webkitSpeechRecognition?: new () => Recognition;
};

function failureMessage(code: string): string {
  switch (code) {
    case 'NotAllowedError': case 'PermissionDeniedError': case 'not-allowed':
      return 'Microphone access was blocked. Allow microphone access for this Portal in your browser’s site settings and check your device’s microphone privacy settings, then try again.';
    case 'NotFoundError': case 'DevicesNotFoundError': case 'audio-capture':
      return 'No microphone is available. Connect or select a microphone in your browser and device settings, then try again.';
    case 'NotReadableError': case 'TrackStartError':
      return 'The microphone could not be opened. Check whether another app is using it, then try again.';
    case 'network': case 'service-not-allowed':
      return 'Your browser’s speech-recognition service is unavailable or blocked. Check your browser and organization’s network policy, or use your device’s built-in dictation in this text box.';
    case 'no-speech':
      return 'No speech was detected. Check the selected microphone and try again.';
    case 'language-not-supported':
      return 'Your browser’s speech service does not support this language. Use your device’s built-in dictation in this text box.';
    case 'aborted':
      return 'Dictation was interrupted. Your draft is preserved; click the microphone to try again.';
    default:
      return 'Dictation could not start. Check your browser’s microphone settings, or use your device’s built-in dictation in this text box.';
  }
}

/** Browser dictation only: no Portal audio upload, auto-send, or silent retry.
 * A constructor alone is not evidence that capture or the browser service works.
 */
export function useDictation(readDraft: () => string, writeDraft: (value: string) => void) {
  const [state, setState] = useState<{ phase: Phase; message: string }>({ phase: 'idle', message: '' });
  const io = useRef({ readDraft, writeDraft });
  io.current = { readDraft, writeDraft };
  const active = useRef(false);
  const generation = useRef(0);
  const recognitionRef = useRef<Recognition | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const Constructor = typeof window === 'undefined' ? undefined
    : (window as unknown as SpeechWindow).SpeechRecognition || (window as unknown as SpeechWindow).webkitSpeechRecognition;
  const isSupported = !!Constructor;

  const clearTimer = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  const dispose = useCallback(() => {
    active.current = false;
    generation.current++;
    clearTimer();
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    if (recognition) {
      recognition.onstart = recognition.onend = recognition.onerror = recognition.onresult = null;
      try { recognition.abort(); } catch { /* already ended */ }
    }
  }, [clearTimer]);
  const stop = useCallback(() => {
    dispose();
    setState({ phase: 'idle', message: '' });
  }, [dispose]);
  const fail = useCallback((message: string) => {
    dispose();
    setState({ phase: 'error', message });
  }, [dispose]);

  const start = useCallback(async () => {
    if (active.current) return;
    if (!Constructor) {
      fail('This browser does not support speech recognition. Use a supported browser or your device’s built-in dictation in this text box.');
      return;
    }
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      fail('Microphone access requires a trusted HTTPS connection. Open the Portal at its secure address; do not bypass certificate warnings.');
      return;
    }
    const policy = (document as Document & { permissionsPolicy?: { allowsFeature(name: string): boolean }; featurePolicy?: { allowsFeature(name: string): boolean } });
    if ((policy.permissionsPolicy || policy.featurePolicy)?.allowsFeature('microphone') === false) {
      fail('Microphone access is disabled for this page. Open the Portal directly in its own browser tab; if it is still blocked, contact your administrator.');
      return;
    }
    dispose();
    active.current = true;
    const epoch = generation.current;
    const current = () => active.current && generation.current === epoch;
    const base = io.current.readDraft();
    let lastWritten = base;
    let heard = false;
    setState({ phase: 'requesting', message: 'Allow microphone access in your browser to begin dictation. If permission is already granted, no prompt is needed.' });
    timer.current = setTimeout(() => {
      if (current()) fail('Microphone permission is still pending. Check your browser’s permission prompt or site settings, then try again.');
    }, 60_000);
    try {
      // Request capture explicitly so missing/denied permission cannot masquerade
      // as listening. Release the probe before the speech service owns capture.
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const track of stream.getTracks()) track.stop();
      if (!current()) return; // a late permission grant after cancel/unmount
      clearTimer();
      if (io.current.readDraft() !== lastWritten) {
        fail('Dictation stopped because the draft changed. Click the microphone again to continue from your current draft.');
        return;
      }
      const recognition = new Constructor();
      recognitionRef.current = recognition;
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = document.documentElement.lang || navigator.language || 'en-US';
      const armSilenceTimer = () => {
        clearTimer();
        timer.current = setTimeout(() => { if (current()) fail(failureMessage('no-speech')); }, 30_000);
      };
      recognition.onstart = () => {
        if (!current()) return;
        setState({ phase: 'listening', message: 'Listening… Speak your message, then click the microphone to stop. Dictation never sends your message.' });
        armSilenceTimer();
      };
      recognition.onresult = (event) => {
        if (!current()) return;
        if (io.current.readDraft() !== lastWritten) {
          fail('Dictation stopped because the draft changed. Click the microphone again to continue from your current draft.');
          return;
        }
        // Results are cumulative for this recognition instance. Replacing the
        // dictated suffix prevents interim/final revisions from duplicating text.
        const text = Array.from(event.results).map(result => result[0]?.transcript || '').join(' ').trim();
        if (!text) return;
        heard = true;
        lastWritten = base + (base && !/\s$/.test(base) ? ' ' : '') + text;
        io.current.writeDraft(lastWritten);
        armSilenceTimer();
      };
      recognition.onerror = (event) => { if (current()) fail(failureMessage(event.error)); };
      recognition.onend = () => {
        if (!current()) return;
        if (!heard) fail(failureMessage('no-speech'));
        else stop();
      };
      setState({ phase: 'starting', message: 'Starting your browser’s speech-recognition service…' });
      timer.current = setTimeout(() => {
        if (current()) fail('The browser’s speech-recognition service did not start. Try a supported browser or use your device’s built-in dictation in this text box.');
      }, 15_000);
      recognition.start();
    } catch (error) {
      // DOMException (including permission failures) is not an Error in every
      // browser realm. Read only its name; never expose arbitrary exception text.
      const name = error && typeof error === 'object' && 'name' in error && typeof error.name === 'string' ? error.name : 'unknown';
      if (current()) fail(failureMessage(name));
    }
  }, [Constructor, clearTimer, dispose, fail, stop]);

  const toggle = useCallback(() => { if (active.current) stop(); else void start(); }, [start, stop]);
  useEffect(() => dispose, [dispose]);
  return {
    ...state, isSupported,
    isListening: state.phase === 'listening',
    isActive: state.phase === 'requesting' || state.phase === 'starting' || state.phase === 'listening',
    start, stop, toggle,
  };
}

/** Bridge to the main chat's assistant-ui controlled textarea. Updating only
 * the DOM value would display text without adding it to the actual composer.
 */
export function useTextareaDictation(ref: RefObject<HTMLTextAreaElement | null>) {
  return useDictation(() => ref.current?.value || '', (text) => {
    const input = ref.current;
    if (!input) return;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
