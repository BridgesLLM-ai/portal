import vm from 'vm';
import { WIDGET_SANDBOX_HTML, WIDGET_SHELL_CSP } from './chatWidgetSandbox';
describe('opaque double-frame transport boundary (not real browser enforcement)', () => {
  const instance = 'widget-synthetic-channel-1234';
  function shell() {
    const handlers: Record<string, (event: any) => void> = {};
    const postMessage = jest.fn(); const innerPost = jest.fn();
    const inner: any = { contentWindow: { postMessage: innerPost }, addEventListener: jest.fn(), remove: jest.fn() };
    const blob = jest.fn((_parts: string[]) => ({}));
    const host = { postMessage }; const append = jest.fn();
    const context = { parent: host, location: { hash: '#' + instance }, TextEncoder, Date, Blob: blob,
      URL: { createObjectURL: jest.fn(() => 'blob:null/synthetic'), revokeObjectURL: jest.fn() },
      addEventListener: (name: string, callback: any) => { handlers[name] = callback; },
      document: { documentElement: { style: { colorScheme: '' } }, createElement: jest.fn(() => inner), body: { append } } };
    vm.runInNewContext(WIDGET_SANDBOX_HTML.match(/<script>([\s\S]*)<\/script>/)![1], context);
    return { host, inner, innerPost, blob, postMessage, handlers, append, root: context.document.documentElement };
  }
  test('CSP isolates both frames and admits no connect, same-origin, navigation/form/popups or tool bridge', () => {
    expect(WIDGET_SHELL_CSP).toContain('sandbox allow-scripts');
    expect(WIDGET_SHELL_CSP).toContain("frame-src blob:");
    expect(WIDGET_SHELL_CSP).toContain("connect-src 'none'");
    expect(WIDGET_SANDBOX_HTML).not.toMatch(/allow-same-origin|allow-top-navigation|allow-popups|allow-forms/);
  });
  test('wrong source/channel/instance cannot supply code; one exact document has opaque inner and early restrictive CSP', () => {
    const s = shell(); const data = { channel: 'bridgesllm.widget.v1', instance, type: 'document', html: '<script>counter()</script>' };
    s.handlers.message({ source: {}, data }); s.handlers.message({ source: s.host, data: { ...data, instance: 'wrong' } });
    s.handlers.message({ source: s.host, data: { ...data, channel: 'wrong' } }); expect(s.append).not.toHaveBeenCalled();
    s.handlers.message({ source: s.host, data }); expect(s.inner.sandbox).toBe('allow-scripts');
    expect(s.blob.mock.calls[0][0][0]).toContain("frame-src 'none'"); expect(s.blob.mock.calls[0][0][1]).toBe(data.html);
    s.handlers.message({ source: s.host, data }); expect(s.append).toHaveBeenCalledTimes(1);
  });
  test('only the bound host theme updates both frame schemes without replacing the document', () => {
    const s = shell();
    s.handlers.message({ source: s.host, data: { channel: 'bridgesllm.widget.v1', instance, type: 'document', html: '<p>test</p>' } });
    const data = { channel: 'bridgesllm.widget.v1', instance, type: 'theme', mode: 'dark', tokens: { surface: 'transparent' } };
    s.handlers.message({ source: s.inner.contentWindow, origin: 'null', data, ports: [] });
    expect(s.root.style.colorScheme).toBe('');
    s.handlers.message({ source: s.host, data });
    expect(s.root.style.colorScheme).toBe('dark');
    expect(s.innerPost).toHaveBeenLastCalledWith({ type: 'openclaw:widget-theme', mode: 'dark', tokens: { surface: 'transparent' } }, '*');
    s.handlers.message({ source: s.host, data: { ...data, mode: 'light' } });
    expect(s.root.style.colorScheme).toBe('light');
    expect(s.append).toHaveBeenCalledTimes(1);
  });
  test('inner frame cannot escalate prompt/tool/navigation commands; size and errors are bounded and ports closed', () => {
    const s = shell(); s.handlers.message({ source: s.host, data: { channel: 'bridgesllm.widget.v1', instance, type: 'document', html: '<p>test</p>' } });
    const port = { close: jest.fn() }; const initial = s.postMessage.mock.calls.length;
    for (const type of ['openclaw:widget-bridge-request', 'openclaw:widget-prompt', 'openclaw:widget-snapshot', 'document'])
      s.handlers.message({ source: s.inner.contentWindow, origin: 'null', data: { type, method: 'chat.send', html: 'attack' }, ports: [port] });
    expect(s.postMessage.mock.calls.length).toBe(initial); expect(port.close).toHaveBeenCalledTimes(4);
    s.handlers.message({ source: {}, origin: 'null', data: { type: 'openclaw:widget-size', height: 500 }, ports: [] });
    expect(s.postMessage.mock.calls.length).toBe(initial);
    s.handlers.message({ source: s.inner.contentWindow, origin: 'null', data: { type: 'openclaw:widget-size', height: 999999 }, ports: [] });
    expect(s.postMessage.mock.calls[s.postMessage.mock.calls.length - 1]?.[0]).toMatchObject({ height: 720 });
    for (let i = 0; i < 10; i++) s.handlers.message({ source: s.inner.contentWindow, origin: 'null', data: { type: 'openclaw:widget-runtime-error', message: 'untrusted' }, ports: [] });
    expect(s.postMessage.mock.calls.filter(([data]) => data.type === 'error')).toHaveLength(3);
  });
});
