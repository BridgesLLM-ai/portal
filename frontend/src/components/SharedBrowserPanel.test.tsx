// @vitest-environment jsdom
import '../test/setup';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import SharedBrowserPanel from './SharedBrowserPanel';
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../api/client', () => ({ default: api }));
const owner = '00000000-0000-0000-0000-000000000001';
vi.mock('../contexts/AuthContext', () => ({ useAuthStore: (select: any) => select({ user: { id: owner } }) }));
const key = 'agent:alpha:portal-00000000-0000-0000-0000-000000000001-chat';
let lease: any;
beforeEach(() => {
  vi.clearAllMocks();
  lease = { sessionKey: key, agentId: 'alpha', mode: 'human', revision: 3, handoverRequested: true };
  api.get.mockImplementation(async (path: string) => ({ data: path.endsWith('/state') ? { lease } : path.endsWith('/pages') ? { pages: [] }
     : path === '/gateway/sessions' ? { sessions: [
      { sessionId: key, title: 'Owned chat' },
      { sessionId: 'agent:main:portal-' + owner, title: 'Normal owned direct' },
      { sessionId: 'agent:main:portal-00000000-0000-0000-0000-000000000002', title: 'Foreign' },
      { sessionId: 'agent:main:private', title: 'Private host' },
      { sessionId: 'agent:main:portal-' + owner + ':project:x', title: 'Nested Project' },
      { sessionId: 'agent:main:portal-' + owner + '-project', title: 'Scoped Project', metadata: { executionScope: 'PROJECT_SANDBOX' } },
      { sessionId: 'agent:portal:portal-' + owner + '-project', title: 'Legacy Project' },
      { sessionId: 'agent:portal-00000000-project:portal-' + owner + '-project', title: 'Dedicated Project' },
      { sessionId: 'agent:INVALID:portal-' + owner, title: 'Invalid agent' },
      { sessionId: 'agent:main:portal-' + owner + 'suffix', title: 'Actor prefix collision' },
      { sessionId: 'project:example', title: 'Project' },
    ] } : { tasks: [] } }));
});
afterEach(cleanup);
test('human noVNC is inside Portal; return closes it using the displayed revision', async () => {
  api.post.mockImplementation(async () => { lease = { ...lease, revision: 4, mode: 'agent' }; return { data: { lease } }; });
  render(<SharedBrowserPanel />); fireEvent.click(screen.getByRole('button', { name: /Shared interactive browser/ }));
  const frame = await screen.findByTitle('Shared browser desktop');
  expect(frame.getAttribute('src')).toBe('/novnc/vnc.html?path=api%2Fshared-browser%2Fdesktop&autoconnect=1&resize=scale&reconnect=0');
  fireEvent.click(screen.getByRole('button', { name: 'Return to agent' }));
  await waitFor(() => expect(screen.queryByTitle('Shared browser desktop')).toBeNull());
  expect(api.post).toHaveBeenCalledWith('/shared-browser/control', { revision: 3, action: 'return' });
});
test('selection is explicit and excludes distinct App/Project browser sessions', async () => {
  lease = null; api.post.mockResolvedValue({ data: { lease: null } });
  render(<SharedBrowserPanel />); fireEvent.click(screen.getByRole('button', { name: /Shared interactive browser/ }));
  const select = await screen.findByRole('combobox', { name: 'Owned Agent Chat session' });
  await screen.findByRole('option', { name: 'Owned chat' });
  await screen.findByRole('option', { name: 'Normal owned direct' });
  expect(api.get).toHaveBeenCalledWith('/gateway/sessions', { params: { provider: 'OPENCLAW' } });
  expect(api.get).not.toHaveBeenCalledWith('/gateway/tasks');
  for (const name of ['Foreign', 'Private host', 'Project', 'Nested Project', 'Scoped Project', 'Legacy Project', 'Dedicated Project', 'Invalid agent', 'Actor prefix collision']) {
    expect(screen.queryByRole('option', { name })).toBeNull();
  }
  expect(api.post).not.toHaveBeenCalled();
  fireEvent.change(select, { target: { value: key } });
  fireEvent.click(screen.getByRole('button', { name: 'Select browser (human control)' }));
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/shared-browser/select', { sessionKey: key }));
});
test('takeover drain and foreign denial never render human input', async () => {
  lease = { ...lease, mode: 'taking-control' };
  render(<SharedBrowserPanel />); fireEvent.click(screen.getByRole('button', { name: /Shared interactive browser/ }));
  await screen.findByText(/Waiting for active browser action/);
  expect(screen.queryByTitle('Shared browser desktop')).toBeNull();
  cleanup();
  api.get.mockRejectedValue({ response: { data: { error: 'Shared browser unavailable' } } });
  render(<SharedBrowserPanel />); fireEvent.click(screen.getByRole('button', { name: /Shared interactive browser/ }));
  await screen.findByText('Shared browser unavailable');
  expect(screen.queryByTitle('Shared browser desktop')).toBeNull();
});
