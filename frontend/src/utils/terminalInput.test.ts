import { describe, expect, test } from 'vitest';
import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  appendLooseTerminalPaste,
  consumeBracketedPasteChunk,
  createBracketedPasteState,
  decideTerminalPaste,
  flushLooseTerminalPaste,
  sanitizeTerminalPaste,
} from './terminalInput';

describe('terminal bracketed-paste stream parser', () => {
  test('emits a complete multiline paste exactly once', () => {
    const result = consumeBracketedPasteChunk(
      createBracketedPasteState(),
      `${BRACKETED_PASTE_START}echo one\necho two${BRACKETED_PASTE_END}`,
    );
    expect(result.completedPastes).toEqual(['echo one\necho two']);
    expect(result.ordinaryData).toBe('');
    expect(result.state).toEqual(createBracketedPasteState());
  });

  test('reassembles payload and markers split across arbitrary chunks', () => {
    let state = createBracketedPasteState();
    const completed: string[] = [];
    const ordinary: string[] = [];
    for (const chunk of ['\x1b[20', '0~echo ', 'one\necho', ' two\x1b[2', '01~']) {
      const result = consumeBracketedPasteChunk(state, chunk);
      state = result.state;
      completed.push(...result.completedPastes);
      ordinary.push(result.ordinaryData);
    }
    expect(completed).toEqual(['echo one\necho two']);
    expect(ordinary.join('')).toBe('');
    expect(state).toEqual(createBracketedPasteState());
  });

  test('preserves ordinary data around multiple bracketed pastes', () => {
    const result = consumeBracketedPasteChunk(
      createBracketedPasteState(),
      `before${BRACKETED_PASTE_START}one${BRACKETED_PASTE_END}middle${BRACKETED_PASTE_START}two${BRACKETED_PASTE_END}after`,
    );
    expect(result.completedPastes).toEqual(['one', 'two']);
    expect(result.ordinaryData).toBe('beforemiddleafter');
  });

  test('does not misclassify ordinary terminal input as a paste', () => {
    const result = consumeBracketedPasteChunk(createBracketedPasteState(), 'git status');
    expect(result.completedPastes).toEqual([]);
    expect(result.ordinaryData).toBe('git status');
    expect(result.state).toEqual(createBracketedPasteState());
  });

  test('removes control bytes without destroying tabs or command terminators', () => {
    expect(sanitizeTerminalPaste('echo\x00 one\t&&\necho two\x7f')).toBe('echo one\t&&\necho two');
  });

  test('requires one reviewed confirmation for chunked multiline paste content', () => {
    const chunks = ['systemctl status open', 'claw\nsudo systemctl ', 'restart openclaw\n'];
    expect(decideTerminalPaste('', chunks.join(''))).toEqual({
      kind: 'confirm',
      value: 'systemctl status openclaw\nsudo systemctl restart openclaw',
    });
    expect(decideTerminalPaste('cd /srv && ', 'git pull\r')).toEqual({
      kind: 'confirm',
      value: 'cd /srv && git pull',
    });
  });

  test('flushes unmarked chunks once so one paste cannot create duplicate confirmations', () => {
    let buffer = '';
    for (const chunk of ['echo one\n', 'echo two', '\n']) buffer = appendLooseTerminalPaste(buffer, chunk);
    const firstFlush = flushLooseTerminalPaste(buffer, 'cd /srv && ');
    expect(firstFlush.decision).toEqual({
      kind: 'confirm',
      value: 'cd /srv && echo one\necho two',
    });
    expect(firstFlush.remaining).toBe('');

    const secondFlush = flushLooseTerminalPaste(firstFlush.remaining, '');
    expect(secondFlush).toEqual({
      remaining: '',
      raw: '',
      decision: { kind: 'ignore', value: '' },
    });
  });

  test('keeps a single-line paste inert until the operator presses Enter', () => {
    expect(decideTerminalPaste('', 'sudo systemctl restart openclaw')).toEqual({
      kind: 'insert',
      value: 'sudo systemctl restart openclaw',
    });
    expect(decideTerminalPaste('', '\x00\x7f')).toEqual({ kind: 'ignore', value: '' });
  });
});
