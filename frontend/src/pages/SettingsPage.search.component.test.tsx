// @vitest-environment jsdom
import '../test/setup';
import React, { useState } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CommandPalette from '../components/CommandPalette';
import SettingsPage from './SettingsPage';
import { SETTINGS_TABS, settingsTabIdsForRole } from './settingsAdminContract';

const mocks = vi.hoisted(() => ({
  user: { id: 'owner-1', email: 'owner@example.com', username: 'owner', role: 'OWNER', authorizationVersion: 1 } as Record<string, unknown>,
  publicSettings: { originMode: 'domain', mail: { available: false, reason: 'Mail requires a public domain.' } } as Record<string, unknown>,
  getPortalSettings: vi.fn(),
  updatePortalSettings: vi.fn(),
  clientGet: vi.fn(),
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuthStore: (selector?: (state: any) => unknown) => {
    const state = { user: mocks.user, silentLogout: vi.fn() };
    return selector ? selector(state) : state;
  },
}));
vi.mock('../contexts/ThemeContext', () => ({
  useTheme: () => ({
    theme: 'dark', setTheme: vi.fn(), accentColor: '#6366f1', setAccentColor: vi.fn(),
    effectsMode: 'auto', setEffectsMode: vi.fn(), resolvedEffects: 'full',
  }),
}));
vi.mock('../api/settings', () => ({
  settingsAPI: {
    getPortalSettings: mocks.getPortalSettings,
    updatePortalSettings: mocks.updatePortalSettings,
    updateSearchVisibility: vi.fn(),
    getEmbedOriginPolicy: vi.fn(async () => ({
      version: 1, revision: 'a'.repeat(64), status: 'ready', entries: [], defaultOrigins: [],
      limits: { maxOrigins: 32, maxOriginBytes: 512, maxPolicyBytes: 8192 }, updatedAt: null,
    })),
    updateEmbedOriginPolicy: vi.fn(),
    sendTestEmail: vi.fn(),
  },
}));
vi.mock('../api/client', () => ({
  default: { get: mocks.clientGet, post: vi.fn(async () => ({ data: {} })), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
vi.mock('../api/auth', () => ({
  authAPI: {
    twoFactorStatus: vi.fn(async () => ({ enabled: false, method: null, backupCodesRemaining: 0 })),
    twoFactorSetup: vi.fn(), twoFactorVerifySetup: vi.fn(), twoFactorDisable: vi.fn(),
    twoFactorSendEmailAuthenticated: vi.fn(), twoFactorRegenerateBackupCodes: vi.fn(),
  },
}));
vi.mock('../api/endpoints', () => ({
  gatewayAPI: {
    getCompatibilityHotfixStatus: vi.fn(async () => ({ supported: true, applied: true, issues: [], note: null })),
    applyCompatibilityHotfix: vi.fn(),
    getConfigPath: vi.fn(async () => ({ value: false })),
    patchConfigPath: vi.fn(),
  },
  projectsAPI: { search: vi.fn(async () => ({ query: '', results: [], truncated: false, visited: 0 })) },
  filesAPI: { list: vi.fn(async () => ({ files: [], total: 0 })) },
}));
vi.mock('../api/agentRuntime', () => ({ agentRuntimeAPI: { status: vi.fn(async () => ({ gateway: { connected: true }, adapters: [] })) } }));
vi.mock('../hooks/usePublicSettings', () => ({
  usePublicSettings: () => mocks.publicSettings,
  refreshPublicSettings: vi.fn(async () => null),
}));
vi.mock('../utils/sounds', () => ({
  default: {
    click: vi.fn(), success: vi.fn(), error: vi.fn(), isEnabled: vi.fn(() => true), getVolume: vi.fn(() => 0.5),
    setEnabled: vi.fn(), setVolume: vi.fn(), toggleOff: vi.fn(), toggleOn: vi.fn(),
  },
}));
vi.mock('../components/settings/BackupsTab', () => ({ default: () => <div>Backups panel</div> }));
vi.mock('../components/settings/FeatureReadinessPanel', () => ({ default: () => <div>Readiness panel</div> }));
vi.mock('../components/ai-setup/AiProviderSetup', () => ({ default: () => <div>Public provider setup</div> }));
vi.mock('../components/settings/OllamaTailnetSetup', () => ({ default: () => <div>Public Ollama setup</div> }));
vi.mock('../components/ImagePickerCropper', () => ({ default: () => null }));
vi.mock('framer-motion', async () => {
  const ReactModule = await import('react');
  const components = new Map<string, React.ComponentType<any>>();
  const motion = new Proxy({}, {
    get: (_target, tag: string) => {
      const existing = components.get(tag);
      if (existing) return existing;
      const component = ReactModule.forwardRef<HTMLElement, Record<string, unknown>>((props, ref) => {
        const { children, initial: _initial, animate: _animate, exit: _exit, transition: _transition, ...domProps } = props;
        return ReactModule.createElement(tag, { ...domProps, ref }, children as React.ReactNode);
      });
      components.set(tag, component);
      return component;
    },
  });
  return { motion, AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</> };
});

let openPalette: () => void = () => undefined;

function PaletteHost() {
  const [open, setOpen] = useState(false);
  openPalette = () => setOpen(true);
  return <CommandPalette isOpen={open} onClose={() => setOpen(false)} />;
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}{location.search}</output>;
}

function renderSettings(entry = '/settings') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <PaletteHost />
      <Routes><Route path="/settings" element={<SettingsPage />} /></Routes>
      <LocationProbe />
    </MemoryRouter>,
  );
}

function settingsTab(label: string): HTMLElement {
  const tablist = screen.getByRole('tablist', { name: 'Settings sections' });
  return within(tablist).getAllByRole('tab').find((tab) => tab.querySelector('span')?.textContent === label)!;
}

async function openResult(user: ReturnType<typeof userEvent.setup>, query: string) {
  act(() => openPalette());
  await user.type(await screen.findByRole('combobox', { name: 'Search commands' }), query);
  await user.keyboard('{Enter}');
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('Ctrl+K reaches the Settings tabs the page renders', () => {
  beforeEach(() => {
    mocks.getPortalSettings.mockReset().mockResolvedValue({ 'appearance.portalName': 'Portal', 'appearance.assistantName': 'Assistant' });
    mocks.updatePortalSettings.mockReset().mockResolvedValue({});
    mocks.clientGet.mockReset().mockImplementation(async (url: string) => {
      if (url === '/gateway/harnesses') return { data: { harnesses: [] } };
      if (url === '/users/me/agent-harness-preference') return { data: { defaultHarness: 'OPENCLAW', revision: 0 } };
      if (url === '/admin/coding-tools-status') return { data: { tools: [] } };
      if (url === '/admin/domain-status') return { data: { currentDomain: '', publicIp: '203.0.113.10', httpsActive: false } };
      return { data: {} };
    });
  });

  it.each(['OWNER', 'SUB_ADMIN', 'USER'])('opens every tab rendered for %s by its label', async (role) => {
    mocks.user = { id: `${role.toLowerCase()}-1`, email: 'person@example.com', username: 'person', role, authorizationVersion: 1 };
    const user = userEvent.setup();
    renderSettings();

    const tablist = await screen.findByRole('tablist', { name: 'Settings sections' });
    const labels = within(tablist).getAllByRole('tab').map((tab) => tab.querySelector('span')?.textContent || '');
    expect(labels).toEqual(settingsTabIdsForRole(role).map((tab) => SETTINGS_TABS[tab].label));
    for (const label of labels) {
      await openResult(user, label);
      await waitFor(() => expect(settingsTab(label)).toHaveAttribute('aria-selected', 'true'));
    }
  });

  it('opens a control inside a tab on that tab', async () => {
    mocks.user = { id: 'owner-1', email: 'owner@example.com', username: 'owner', role: 'OWNER', authorizationVersion: 1 };
    const user = userEvent.setup();
    renderSettings('/settings?tab=profile');
    await screen.findByRole('tablist', { name: 'Settings sections' });

    await openResult(user, 'hosted content embeds');
    await waitFor(() => expect(settingsTab('Security')).toHaveAttribute('aria-selected', 'true'));
    expect(screen.getByTestId('location')).toHaveTextContent('/settings?tab=security');
    expect(await screen.findByRole('heading', { name: 'Hosted content embeds' })).toBeInTheDocument();
  });

  it('cannot navigate away while a Settings save owns the page', async () => {
    mocks.user = { id: 'owner-1', email: 'owner@example.com', username: 'owner', role: 'OWNER', authorizationVersion: 1 };
    const user = userEvent.setup();
    const pendingSave = deferred<Record<string, string>>();
    mocks.updatePortalSettings.mockReturnValueOnce(pendingSave.promise);
    renderSettings('/settings?tab=general');

    const portalName = await screen.findByLabelText('Portal name');
    fireEvent.change(portalName, { target: { value: 'Owned Settings' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    expect(screen.getByRole('button', { name: 'Saving…' })).toHaveAttribute('aria-busy', 'true');

    await openResult(user, 'backup path');
    expect(screen.getByTestId('location')).toHaveTextContent('/settings?tab=general');
    expect(settingsTab('General')).toHaveAttribute('aria-selected', 'true');

    await act(async () => {
      pendingSave.resolve({});
      await pendingSave.promise;
    });
    await openResult(user, 'backup path');
    await waitFor(() => expect(settingsTab('Backups')).toHaveAttribute('aria-selected', 'true'));
    expect(screen.getByTestId('location')).toHaveTextContent('/settings?tab=backups');
  });
});
