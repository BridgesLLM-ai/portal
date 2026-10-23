// @vitest-environment jsdom
import '../test/setup';
import React, { useRef } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AssistantRuntimeProvider, ComposerPrimitive, useExternalStoreRuntime, type ThreadMessage, type AppendMessage } from '@assistant-ui/react';
import { useTextareaDictation } from './useDictation';

afterEach(() => vi.unstubAllGlobals());

it('writes dictation into the main chat assistant-ui draft, not only its DOM; never sends without submission', async () => {
  let speech: any;
  const onNew = vi.fn(async (_message: AppendMessage) => {});
  const stopTrack = vi.fn();
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('SpeechRecognition', class {
    start = vi.fn(); abort = vi.fn();
    constructor() {
      // eslint-disable-next-line @typescript-eslint/no-this-alias -- the test drives the instance the component constructed
      speech = this;
    }
  });
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true,
    value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] }) } });
  let readComposer!: () => string;
  function MainComposer() {
    const runtime = useExternalStoreRuntime<ThreadMessage>({ isRunning: false, messages: [], onNew });
    readComposer = () => runtime.thread.composer.getState().text;
    const ref = useRef<HTMLTextAreaElement>(null);
    const dictation = useTextareaDictation(ref);
    return <AssistantRuntimeProvider runtime={runtime}>
      {dictation.message && <p role={dictation.phase === 'error' ? 'alert' : 'status'}>{dictation.message}</p>}
      <ComposerPrimitive.Root onSubmitCapture={dictation.stop}>
        <ComposerPrimitive.Input ref={ref} aria-label="Message agent" />
        <button type="button" onClick={dictation.toggle}>{dictation.isActive ? 'Stop dictation' : 'Start dictation'}</button>
        <ComposerPrimitive.Send onClick={dictation.stop}>Send</ComposerPrimitive.Send>
      </ComposerPrimitive.Root>
    </AssistantRuntimeProvider>;
  }
  render(<MainComposer />);
  const input = screen.getByRole('textbox', { name: 'Message agent' });
  fireEvent.change(input, { target: { value: 'Typed introduction' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Start dictation' })); });
  expect(stopTrack).toHaveBeenCalledOnce();
  expect(screen.getByRole('status').textContent).toContain('Starting');
  act(() => { speech.onstart(); });
  act(() => { speech.onresult({ results: [[{ transcript: 'dictated phrase' }]] }); });
  expect(input).toHaveValue('Typed introduction dictated phrase');
  expect(readComposer()).toBe('Typed introduction dictated phrase');
  expect(onNew).not.toHaveBeenCalled();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })); });
  expect(speech.abort).toHaveBeenCalledOnce();
  expect(onNew).toHaveBeenCalledOnce();
  expect(onNew.mock.calls[0]).toEqual([expect.objectContaining({ content: [{ type: 'text', text: 'Typed introduction dictated phrase' }] })]);
  expect(readComposer()).toBe('');
});
