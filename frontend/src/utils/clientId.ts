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
