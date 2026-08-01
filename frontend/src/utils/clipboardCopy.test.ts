// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from 'vitest';
import { copyTextToClipboard, selectionCopy } from './clipboardCopy';

/**
 * A previously observed setup-wizard error sound occurred with no failed
 * server requests, leaving the copy button's failure branch as the only
 * reachable sounds.error(). The async clipboard API rejects
 * for reasons unrelated to transport — most often "document is not focused" —
 * and the old code only reached for the selection fallback when the context
 * was insecure. On HTTPS a rejection therefore produced a beep and nothing else.
 */
function setClipboard(writeText: null | (() => Promise<void>)) {
  Object.defineProperty(navigator, 'clipboard', {
    value: writeText ? { writeText } : undefined,
    configurable: true,
  });
}
function setSecure(secure: boolean) {
  Object.defineProperty(window, 'isSecureContext', { value: secure, configurable: true });
}

afterEach(() => { vi.restoreAllMocks(); });

describe('clipboard copy', () => {
  it('uses the async API when it works', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard(writeText); setSecure(true);
    const exec = vi.fn().mockReturnValue(true);
    (document as any).execCommand = exec;

    await expect(copyTextToClipboard('hello')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello');
    expect(exec).not.toHaveBeenCalled();
  });

  it('falls back to a selection copy when the async API rejects on HTTPS', async () => {
    // This is the exact case that produced the mystery beep.
    setClipboard(() => Promise.reject(new Error('Document is not focused')));
    setSecure(true);
    const exec = vi.fn().mockReturnValue(true);
    (document as any).execCommand = exec;

    await expect(copyTextToClipboard('secret-token')).resolves.toBe(true);
    expect(exec).toHaveBeenCalledWith('copy');
  });

  it('uses the selection copy on an insecure context', async () => {
    setClipboard(null); setSecure(false);
    const exec = vi.fn().mockReturnValue(true);
    (document as any).execCommand = exec;
    await expect(copyTextToClipboard('x')).resolves.toBe(true);
    expect(exec).toHaveBeenCalled();
  });

  it('reports failure only when both paths fail', async () => {
    setClipboard(() => Promise.reject(new Error('nope')));
    setSecure(true);
    (document as any).execCommand = vi.fn().mockReturnValue(false);
    await expect(copyTextToClipboard('x')).resolves.toBe(false);
  });

  it('never throws when the DOM refuses the fallback', () => {
    (document as any).execCommand = () => { throw new Error('blocked'); };
    expect(selectionCopy('x')).toBe(false);
  });

  it('leaves no textarea behind after a successful copy', async () => {
    setClipboard(null); setSecure(false);
    (document as any).execCommand = vi.fn().mockReturnValue(true);
    await copyTextToClipboard('x');
    expect(document.querySelectorAll('textarea').length).toBe(0);
  });
});
