// @vitest-environment jsdom
import '../../test/setup';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import NativeProgressNote from './NativeProgressNote';
import { latestNativeProgress, parseNativeProgress } from '../../utils/nativeProgress';
import type { ChatMessage } from '../../contexts/ChatStateProvider';

describe('native progress presentation', () => {
  it('renders the actual measurement and markdown, without running arbitrary tool HTML', () => {
    const progress = parseNativeProgress('<progress aria-label="Files reviewed · 2/7" value="2" max="7"></progress>\n\n**Reviewing** [report](https://example.com/report)\n<script>bad()</script><img src="https://tracker.example/x">');
    const { container } = render(<NativeProgressNote progress={progress} />);
    expect(screen.getByRole('progressbar', { name: 'Files reviewed · 2/7' })).toHaveAttribute('value', '2');
    expect(screen.getByRole('progressbar')).toHaveAttribute('max', '7');
    expect(screen.getByRole('link', { name: 'report' })).toHaveAttribute('rel', 'noopener noreferrer nofollow');
    expect(container.querySelector('script,img,iframe')).toBeNull();
    expect(container.querySelector('strong')?.textContent).toBe('Reviewing');
  });
  it.each(['value="NaN" max="10"', 'value="5" max="0"', 'value="12" max="10"', 'max="10"', 'value="-1" max="10"'])('does not invent a measurement from %s', attrs => {
    expect(parseNativeProgress(`<progress aria-label="Review" ${attrs}></progress>`).measure).toBeNull();
  });
  it('never treats links or images in a progress note as executable content', () => {
    const { container } = render(<NativeProgressNote progress={parseNativeProgress('[bad](javascript:alert) ![image](https://tracker.example/x) <button onclick="bad()">Go</button>')} />);
    expect(container.querySelector('a,img,button,script')).toBeNull();
  });
  it('uses only a completed native replacement and honors a clear', () => {
    const messages = [{ id: 'one', role: 'assistant', content: '', toolCalls: [
      { id: 'one', name: 'openclaw__progress_card', status: 'done', startedAt: 1, arguments: { markdown: 'Checking files' } },
      { id: 'two', name: 'progress_card', status: 'error', startedAt: 2, arguments: { markdown: 'Failed update' } },
    ] }] as ChatMessage[];
    expect(latestNativeProgress(messages)?.note).toBe('Checking files');
    messages[0].toolCalls!.push({ id: 'three', name: 'progress_card', status: 'done', startedAt: 3, arguments: { markdown: '', plan: [] } });
    expect(latestNativeProgress(messages)).toEqual({ note: '', measure: null });
  });
});
