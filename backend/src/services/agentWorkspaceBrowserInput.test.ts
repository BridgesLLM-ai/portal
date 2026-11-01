import { browserInputAction, parseBrowserInput, readBrowserFrame } from './agentWorkspaceBrowserInput';
const frame = { url: 'https://example.com/', cssWidth: 1920, cssHeight: 1080 };
const base = { type: 'input', id: 1, url: frame.url };
describe('human browser input boundary', () => {
  it('accepts bounded actions and preserves special text as data', () => {
    expect(parseBrowserInput({ type: 'control', enabled: true })).toEqual({ type: 'control', enabled: true });
    const value = { ...base, action: 'text', text: '日本語 <b>hello</b> ${evil()}' };
    const parsed = parseBrowserInput(value)!;
    expect(browserInputAction(parsed as any, frame)).toEqual({ kind: 'insertText', text: value.text });
    expect(parseBrowserInput({ ...base, action: 'key', key: 'Control+A' })).not.toBeNull();
  });
  it('rejects arbitrary RPC, resize, scripts, target/profile overrides and browser-chrome keys', () => {
    for (const extra of [{ action: 'resize', width: 400 }, { action: 'evaluate', fn: 'evil()' },
      { action: 'text', text: 'ok', targetId: 'other' }, { action: 'text', text: 'ok', profile: 'private' },
      { action: 'key', key: 'Control+L' }, { action: 'key', key: 'Control+T' }, { action: 'key', key: 'F12' }, { action: 'key', key: 'x'.repeat(300) },
      { action: 'text', text: 'x'.repeat(4097) }, { action: 'text', text: '' }, { action: 'click', x: -0.1, y: 0 }, { action: 'click', x: NaN, y: 0 },
      { action: 'click', x: 0.5, y: 0.5, button: 'middle' }, { action: 'scroll', x: 0, y: 0, deltaX: 0, deltaY: 2001 }]) {
      expect(parseBrowserInput({ ...base, ...extra })).toBeNull();
    }
    expect(parseBrowserInput({ type: 'control', enabled: true, profile: 'private' })).toBeNull();
    expect(parseBrowserInput({ ...base, id: -1, action: 'key', key: 'Enter' })).toBeNull();
    expect(parseBrowserInput([base])).toBeNull();
  });
  it('maps local zoom-independent ratios into native CSS pixels, not compressed JPEG dimensions', () => {
    const input = parseBrowserInput({ ...base, action: 'click', x: 0.5, y: 0.25 })!;
    expect(browserInputAction(input as any, frame)).toMatchObject({ kind: 'clickCoords', x: 960, y: 270 });
    expect(browserInputAction({ ...input, x: 1, y: 1 } as any, frame)).toMatchObject({ x: 1919, y: 1079 });
    expect(() => browserInputAction(input as any, { ...frame, url: 'https://other.test/' })).toThrow('Page changed');
  });
  it('bounds wheel code to server-authored numeric constants', () => {
    const input = parseBrowserInput({ ...base, action: 'scroll', x: 0.2, y: 0.3, deltaX: 0, deltaY: 120.8 })!;
    const result = browserInputAction(input as any, frame);
    expect(result.kind).toBe('evaluate'); expect(result.fn).toContain('scrollBy(0, 121)');
    expect(result.fn).toContain('document.elementFromPoint(384, 324)');
  });
  it('requires bounded native dimensions and a complete binary frame', () => {
    const encode = (header: unknown) => { const json = Buffer.from(JSON.stringify(header)); const data = Buffer.alloc(json.length + 7); data.writeUInt32BE(json.length); json.copy(data, 4); return data; };
    expect(readBrowserFrame(encode(frame))).toEqual(frame);
    expect(readBrowserFrame(encode({ ...frame, extra: 'dropped' }))).toEqual(frame);
    for (const header of [{}, { ...frame, cssWidth: 0 }, { ...frame, cssHeight: 100000 }, { ...frame, url: {} }]) expect(readBrowserFrame(encode(header))).toBeNull();
    expect(readBrowserFrame(Buffer.alloc(2))).toBeNull();
  });
});
