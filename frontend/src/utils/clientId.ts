export function clientRandomId(prefix = ''): string {
  const cryptoObj: any = (globalThis as any)?.crypto;
  if (cryptoObj?.randomUUID) {
    const id = String(cryptoObj.randomUUID()).replace(/-/g, '');
    return prefix ? `${prefix}${id}` : id;
  }

  if (cryptoObj?.getRandomValues) {
    const bytes = new Uint8Array(16);
    cryptoObj.getRandomValues(bytes);
    const hex = Array.from(bytes, (b: number) => b.toString(16).padStart(2, '0')).join('');
    return prefix ? `${prefix}${hex}` : hex;
  }

  const fallback = `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}${Math.random().toString(16).slice(2)}`;
  return prefix ? `${prefix}${fallback}` : fallback;
}

/**
 * Generate an identifier suitable for an exactly-once mutation contract.
 *
 * Unlike the general UI helper above, this deliberately has no timestamp or
 * Math.random fallback. If the browser cannot provide a cryptographically
 * secure generator, callers must fail before dispatching the mutation rather
 * than quietly weakening cross-tab collision resistance.
 */
export function clientCryptographicRandomId(prefix = ''): string {
  const cryptoObj: Crypto | undefined = globalThis.crypto;
  let id = '';

  if (typeof cryptoObj?.randomUUID === 'function') {
    id = cryptoObj.randomUUID().replace(/-/g, '');
  } else if (typeof cryptoObj?.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    cryptoObj.getRandomValues(bytes);
    id = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  if (!/^[a-f0-9]{32}$/i.test(id)) {
    throw new Error('This browser cannot create a secure Project Chat delivery ID.');
  }
  return prefix ? `${prefix}${id}` : id;
}
