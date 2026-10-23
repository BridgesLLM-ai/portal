// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDictation } from './useDictation';

class Speech {
  static instances: Speech[] = [];
  continuous = false;
  interimResults = false;
  lang = '';
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onresult: ((event: { results: { transcript: string }[][] }) => void) | null = null;
  start = vi.fn();
  abort = vi.fn();
  constructor() { Speech.instances.push(this); }
  result(...text: string[]) { this.onresult?.({ results: text.map(transcript => [{ transcript }]) }); }
}

let draft: string;
let write: ReturnType<typeof vi.fn<(value: string) => void>>;
let getUserMedia: ReturnType<typeof vi.fn>;
let stopTrack: ReturnType<typeof vi.fn>;
const currentSpeech = () => Speech.instances.at(-1)!;
const mount = () => renderHook(() => useDictation(() => draft, write));

beforeEach(() => {
  vi.useFakeTimers();
  Speech.instances = [];
  draft = 'Existing draft';
  write = vi.fn((value: string) => { draft = value; });
  stopTrack = vi.fn();
  getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] });
  vi.stubGlobal('SpeechRecognition', Speech);
  vi.stubGlobal('isSecureContext', true);
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (document as any).permissionsPolicy;
});

describe('dictation permission, lifecycle, and draft ownership', () => {
  it('requests permission and only reports listening after the browser starts; preserves draft and cumulative revisions', async () => {
    let grant!: (value: unknown) => void;
    getUserMedia.mockReturnValueOnce(new Promise(resolve => { grant = resolve; }));
    const { result } = mount();
    act(() => { result.current.toggle(); });
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(result.current.phase).toBe('requesting');
    expect(result.current.isListening).toBe(false);
    expect(Speech.instances).toHaveLength(0);
    await act(async () => { grant({ getTracks: () => [{ stop: stopTrack }] }); });
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(result.current.phase).toBe('starting');
    expect(result.current.isListening).toBe(false);
    act(() => { currentSpeech().onstart?.(); });
    expect(result.current.isListening).toBe(true);
    act(() => { currentSpeech().result('hello'); });
    expect(draft).toBe('Existing draft hello');
    act(() => { currentSpeech().result('hello world'); });
    expect(draft).toBe('Existing draft hello world');
    act(() => { currentSpeech().result('hello world', 'second sentence'); });
    expect(draft).toBe('Existing draft hello world second sentence');
    act(() => { result.current.stop(); });
    expect(currentSpeech().abort).toHaveBeenCalledOnce();
    expect(result.current.isActive).toBe(false);
    act(() => { currentSpeech().result('late stale text'); });
    expect(draft).toBe('Existing draft hello world second sentence');
  });

  it.each([
    ['NotAllowedError', /blocked.*site settings/i],
    ['NotFoundError', /no microphone/i],
    ['NotReadableError', /could not be opened/i],
  ])('shows an actionable %s capture failure without starting recognition', async (name, message) => {
    getUserMedia.mockRejectedValueOnce(new DOMException('fixture', name));
    const { result } = mount();
    await act(() => result.current.start());
    expect(result.current.phase).toBe('error');
    expect(result.current.message).toMatch(message);
    expect(result.current.isActive).toBe(false);
    expect(Speech.instances).toHaveLength(0);
    expect(draft).toBe('Existing draft');
  });

  it.each(['network', 'service-not-allowed', 'not-allowed', 'audio-capture', 'no-speech', 'aborted'])('surfaces speech error %s and never restarts a failed service', async (error) => {
    const { result } = mount();
    await act(() => result.current.start());
    const speech = currentSpeech();
    const end = speech.onend;
    act(() => { speech.onerror?.({ error }); end?.(); });
    expect(result.current.phase).toBe('error');
    expect(result.current.message.length).toBeGreaterThan(30);
    expect(result.current.isListening).toBe(false);
    expect(Speech.instances).toHaveLength(1);
    expect(speech.abort).toHaveBeenCalledOnce();
  });

  it('bounds a service that exposes an API but never starts', async () => {
    const { result } = mount();
    await act(() => result.current.start());
    act(() => { vi.advanceTimersByTime(15_000); });
    expect(result.current.message).toMatch(/did not start/);
    expect(result.current.isActive).toBe(false);
    expect(currentSpeech().abort).toHaveBeenCalledOnce();
  });

  it('bounds silence and retains dictated text without a restart loop', async () => {
    const { result } = mount();
    await act(() => result.current.start());
    act(() => { currentSpeech().onstart?.(); currentSpeech().result('saved text'); });
    act(() => { vi.advanceTimersByTime(30_000); });
    expect(result.current.message).toMatch(/No speech/);
    expect(draft).toBe('Existing draft saved text');
    expect(Speech.instances).toHaveLength(1);
  });

  it.each(['cancel', 'unmount', 'timeout'])('releases a late permission grant after %s without starting capture', async (action) => {
    let grant!: (value: unknown) => void;
    getUserMedia.mockReturnValueOnce(new Promise(resolve => { grant = resolve; }));
    const { result, unmount } = mount();
    act(() => { result.current.toggle(); });
    act(() => {
      if (action === 'unmount') unmount();
      else if (action === 'timeout') vi.advanceTimersByTime(60_000);
      else result.current.stop();
    });
    await act(async () => { grant({ getTracks: () => [{ stop: stopTrack }] }); });
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(Speech.instances).toHaveLength(0);
    expect(write).not.toHaveBeenCalled();
  });

  it('does not clobber manual edits or a submitted/cleared draft', async () => {
    const { result } = mount();
    await act(() => result.current.start());
    act(() => { currentSpeech().onstart?.(); currentSpeech().result('first'); });
    draft = 'Manual correction';
    act(() => { currentSpeech().result('stale dictated text'); });
    expect(draft).toBe('Manual correction');
    expect(result.current.message).toMatch(/draft changed/);
    expect(result.current.isActive).toBe(false);
  });

  it('does not overwrite edits made while permission was pending', async () => {
    let grant!: (value: unknown) => void;
    getUserMedia.mockReturnValueOnce(new Promise(resolve => { grant = resolve; }));
    const { result } = mount();
    act(() => { result.current.toggle(); });
    draft = 'Edited while prompt open';
    await act(async () => { grant({ getTracks: () => [{ stop: stopTrack }] }); });
    expect(draft).toBe('Edited while prompt open');
    expect(Speech.instances).toHaveLength(0);
    expect(result.current.message).toMatch(/draft changed/);
  });

  it('makes unsupported browsers and insecure contexts visible without asking for capture', async () => {
    vi.stubGlobal('SpeechRecognition', undefined);
    const { result, unmount } = mount();
    await act(() => result.current.start());
    expect(result.current.message).toMatch(/does not support/);
    unmount();
    vi.stubGlobal('SpeechRecognition', Speech);
    vi.stubGlobal('isSecureContext', false);
    const other = mount();
    await act(() => other.result.current.start());
    expect(other.result.current.message).toMatch(/trusted HTTPS/);
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('does not bypass a Permissions-Policy microphone block', async () => {
    (document as any).permissionsPolicy = { allowsFeature: () => false };
    const { result } = mount();
    await act(() => result.current.start());
    expect(result.current.message).toMatch(/disabled for this page/);
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('ignores stale callbacks after unmount and after a new dictation starts', async () => {
    const { result, unmount } = mount();
    await act(() => result.current.start());
    const staleStart = currentSpeech().onstart;
    const staleResult = currentSpeech().onresult;
    const staleEnd = currentSpeech().onend;
    act(() => { result.current.stop(); });
    await act(() => result.current.start());
    act(() => { staleStart?.(); staleResult?.({ results: [[{ transcript: 'stale' }]] }); staleEnd?.(); });
    expect(result.current.phase).toBe('starting');
    expect(write).not.toHaveBeenCalled();
    const liveStart = currentSpeech().onstart;
    unmount();
    act(() => { liveStart?.(); });
    expect(currentSpeech().abort).toHaveBeenCalledOnce();
  });
});
