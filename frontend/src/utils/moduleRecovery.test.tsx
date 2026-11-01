// @vitest-environment jsdom
import '../test/setup';
import React, { Suspense } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { lazyWithRecovery } from './moduleRecovery';
import ModuleUpdateNotice from '../components/ModuleUpdateNotice';

// Whether vite's `define` is replaced statically or set on globalThis, the
// bundle's version is the frontend package version.
const BUILT = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')).version as string;
const NEWER = '9999.0.0';

class Boundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <div>real failure</div> : this.props.children; }
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function mount(error: Error, health: unknown) {
  vi.stubGlobal('__PORTAL_BUILD_VERSION__', BUILT);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => health }));
  const Lazy = lazyWithRecovery(async () => { throw error; });
  return render(<>
    <ModuleUpdateNotice />
    <input aria-label="Draft" defaultValue="unsaved work" />
    <Boundary><Suspense fallback={<div>waiting</div>}><Lazy /></Suspense></Boundary>
  </>);
}
const staleChunk = () => new TypeError('Failed to fetch dynamically imported module: /assets/ChatInterface-old.js');

describe('module recovery after a Portal update', () => {
  it('keeps the tab and its drafts and asks before reloading when the server runs a newer release', async () => {
    mount(staleChunk(), { status: 'ok', version: NEWER });
    expect(await screen.findByText('Portal was updated')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
    expect((screen.getByLabelText('Draft') as HTMLInputElement).value).toBe('unsaved work');
    expect(fetch).toHaveBeenCalledWith('/health', expect.objectContaining({ cache: 'no-store', credentials: 'same-origin' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep working' }));
    expect(screen.queryByText('Portal was updated')).toBeNull();
    expect(screen.queryByText('real failure')).toBeNull();
    expect((screen.getByLabelText('Draft') as HTMLInputElement).value).toBe('unsaved work');
  });

  it('trusts the release reported by a degraded server', async () => {
    mount(staleChunk(), { status: 'degraded', version: NEWER });
    expect(await screen.findByText('Portal was updated')).toBeTruthy();
  });

  it('does not call a missing chunk in the current build an update', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mount(new TypeError('Failed to fetch dynamically imported module: /assets/missing.js'), { status: 'ok', version: BUILT });
    expect(await screen.findByText('real failure')).toBeTruthy();
    expect(screen.queryByText('Portal was updated')).toBeNull();
  });

  it('does not hide programming errors', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mount(new ReferenceError('missingVariable is not defined'), { status: 'ok', version: NEWER });
    expect(await screen.findByText('real failure')).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['an unreachable health check', null],
    ['a malformed version', { status: 'ok', version: 'next' }],
    ['an unavailable server', { status: 'unavailable', version: NEWER }],
  ])('does not claim an update for %s', async (_label, health) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mount(staleChunk(), health);
    if (health === null) vi.mocked(fetch).mockRejectedValue(new Error('offline'));
    await waitFor(() => expect(screen.getByText('real failure')).toBeTruthy());
    expect(screen.queryByText('Portal was updated')).toBeNull();
  });
});
