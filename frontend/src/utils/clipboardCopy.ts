/**
 * Copy text to the clipboard, preferring the async API and falling back to a
 * selection copy.
 *
 * The async clipboard API rejects for reasons that have nothing to do with the
 * page being insecure — most commonly `NotAllowedError: Document is not
 * focused`, which happens routinely when focus moves as a button is clicked.
 *
 * Callers used to reach for the selection fallback only when
 * `window.isSecureContext` was false, so on HTTPS a rejection went straight to
 * a failure branch: an error sound and nothing on screen. That is what an
 * operator experiences as an unexplained beep. Try both, and tell the caller
 * which happened so it can say something useful.
 */
export function selectionCopy(value: string): boolean {
  let textarea: HTMLTextAreaElement | null = null;
  try {
    textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    return document.execCommand('copy') === true;
  } catch {
    return false;
  } finally {
    // A throwing execCommand used to strand the textarea in the document,
    // leaving invisible debris behind on every failed copy.
    if (textarea && textarea.parentNode) textarea.parentNode.removeChild(textarea);
  }
}

export async function copyTextToClipboard(value: string): Promise<boolean> {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // Fall through: a rejection here is usually focus, not transport.
    }
  }
  return selectionCopy(value);
}
