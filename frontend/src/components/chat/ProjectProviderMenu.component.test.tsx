// @vitest-environment jsdom
import '../../test/setup';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import type {
  ProjectChatProviderCapability,
  ProjectChatProviderName,
  ProjectChatProviderQualificationStatus,
} from '../../api/endpoints';
import ProjectProviderMenu, {
  normalizeProjectQualificationRetryAt,
} from './ProjectProviderMenu';
import {
  VIEWPORT_MODAL_Z_INDEX,
  VIEWPORT_TRANSIENT_Z_INDEX,
} from '../ViewportModal';

const openClaw: ProjectChatProviderCapability = {
  provider: 'OPENCLAW',
  displayName: 'OpenClaw',
  runtime: 'openclaw-dedicated-project-agent',
  selectable: true,
  executionScope: 'PROJECT_SANDBOX',
  supportsAttachments: true,
  supportsModelSelection: true,
  supportsAbort: true,
  supportsReset: true,
  requiresOAuth: false,
  reason: 'Verified Project Sandbox adapter.',
};

const codex: ProjectChatProviderCapability = {
  ...openClaw,
  provider: 'CODEX',
  displayName: 'Codex',
  runtime: 'codex-project-adapter',
};

const agentZero: ProjectChatProviderCapability = {
  ...openClaw,
  provider: 'AGENT_ZERO',
  displayName: 'Agent Zero',
  runtime: 'agent-zero-project-sandbox-v1',
  selectable: false,
  executionScope: null,
  requiresOAuth: true,
  reason: 'Agent Zero must pass Project qualification.',
};

const agentZeroQualification: ProjectChatProviderQualificationStatus = {
  provider: 'AGENT_ZERO',
  status: 'UNQUALIFIED',
  selectable: false,
  reason: 'Choose a connected OAuth model and verify the isolated runtime.',
  qualifiedAt: null,
  expiresAt: null,
  evidenceFingerprint: null,
};

function renderMenu(overrides: Partial<ComponentProps<typeof ProjectProviderMenu>> = {}) {
  const props: ComponentProps<typeof ProjectProviderMenu> = {
    providers: [openClaw, codex, agentZero],
    qualifications: { AGENT_ZERO: agentZeroQualification },
    hostRecoveryRole: 'USER',
    qualificationRetryNow: Date.now(),
    selectedProvider: 'OPENCLAW',
    disabled: false,
    qualificationPending: false,
    onSelect: vi.fn(),
    onQualify: vi.fn(),
    agentZeroModel: '',
    agentZeroModels: [
      { value: 'codex_oauth/gpt-5.5', label: 'OpenAI Codex · GPT-5.5' },
    ],
    agentZeroModelsLoading: false,
    agentZeroModelsError: null,
    onAgentZeroModelChange: vi.fn(),
    ...overrides,
  };
  return { ...render(<ProjectProviderMenu {...props} />), props };
}

describe('ProjectProviderMenu', () => {
  it('renders every routed Project provider supplied by the verified capability catalog', async () => {
    const user = userEvent.setup();
    const routedProviders: Array<[ProjectChatProviderName, string]> = [
      ['OPENCLAW', 'OpenClaw'],
      ['CODEX', 'Codex'],
      ['CLAUDE_CODE', 'Claude Code'],
      ['AGENT_ZERO', 'Agent Zero'],
      ['GEMINI', 'Antigravity'],
      ['OLLAMA', 'Ollama'],
    ];
    renderMenu({
      providers: routedProviders.map(([provider, displayName]) => ({
        ...openClaw,
        provider,
        displayName,
        runtime: `${provider.toLowerCase()}-project-adapter`,
      })),
    });

    await user.click(screen.getByRole('button', { name: 'Project chat provider' }));

    const menu = screen.getByRole('menu', { name: 'Project chat providers' });
    const popoverRoot = menu.closest<HTMLElement>('[data-anchored-popover-root="true"]');
    expect(popoverRoot?.parentElement).toBe(document.body);
    expect(popoverRoot).toHaveStyle({ zIndex: String(VIEWPORT_TRANSIENT_Z_INDEX) });
    expect(Number(popoverRoot?.style.zIndex)).toBeLessThan(VIEWPORT_MODAL_Z_INDEX);

    for (const [, displayName] of routedProviders) {
      expect(screen.getByRole('menuitem', { name: `Use ${displayName}` })).toBeVisible();
    }
    expect(screen.getByText('Selected')).toBeVisible();
    expect(screen.queryByText('Active')).not.toBeInTheDocument();
  });

  it('never labels a waiting provider "Preparing" and keeps the last preparation failure visible', async () => {
    const user = userEvent.setup();
    const expiredQualification: ProjectChatProviderQualificationStatus = {
      ...agentZeroQualification,
      provider: 'CODEX',
      status: 'EXPIRED',
      reason: 'Codex qualification evidence expired.',
    };
    renderMenu({
      providers: [openClaw, { ...codex, selectable: false, executionScope: null }, agentZero],
      qualifications: {
        AGENT_ZERO: agentZeroQualification,
        CODEX: expiredQualification,
      },
      qualificationFailures: {
        AGENT_ZERO: {
          message: 'Agent Zero is not signed in on this server. Complete its CLI login on the host, then select the provider again.',
          code: 'PROJECT_PROVIDER_AUTH_REQUIRED',
          retryable: true,
          recovery: null,
          retryAt: null,
        },
      },
    });

    await user.click(screen.getByRole('button', { name: 'Project chat provider' }));

    // "Preparing" is reserved for a running preparation; idle states must be
    // actionable words instead.
    expect(screen.queryByText('Preparing')).not.toBeInTheDocument();
    expect(screen.getByText('Not prepared')).toBeVisible();
    expect(screen.getByText('Expired')).toBeVisible();

    // The remembered failure explains what the operator must actually do.
    await user.click(screen.getByRole('menuitem', { name: 'Review Agent Zero' }));
    expect(screen.getByText(/not signed in on this server/)).toBeVisible();
  });

  it('blocks repeated preparation for host-maintenance failures and exposes only the hardcoded recovery route', async () => {
    const user = userEvent.setup();
    const onQualify = vi.fn();
    const brokenOpenClaw = {
      ...openClaw,
      selectable: false,
      executionScope: null,
      reason: 'OpenClaw is not verified for this project yet.',
    };
    const brokenQualification: ProjectChatProviderQualificationStatus = {
      ...agentZeroQualification,
      provider: 'OPENCLAW',
      reason: 'OpenClaw is not verified for this project yet.',
    };
    const failure = {
      message: 'Portal host maintenance is required before this provider can be prepared.',
      code: 'PROJECT_RUNTIME_POLICY_FAILED',
      retryable: false,
      recovery: 'HOST_MAINTENANCE' as const,
      retryAt: null,
    };
    const ownerView = renderMenu({
      providers: [brokenOpenClaw],
      qualifications: { OPENCLAW: brokenQualification },
      qualificationFailures: { OPENCLAW: failure },
      hostRecoveryRole: 'OWNER',
      onQualify,
    });

    await user.click(screen.getByRole('button', { name: 'Project chat provider' }));
    await user.click(screen.getByRole('menuitem', { name: 'Review OpenClaw' }));

    expect(screen.getByText(failure.message)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Qualify OpenClaw for this project' })).not.toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Open Dashboard for signed update' })).toHaveAttribute(
      'href',
      '/dashboard',
    );
    expect(screen.getByRole('menuitem', {
      name: 'Recheck OpenClaw after host repair',
    })).toBeEnabled();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', {
      name: 'Open Dashboard for signed update',
    })).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', {
      name: 'Recheck OpenClaw after host repair',
    })).toHaveFocus();
    expect(onQualify).not.toHaveBeenCalled();

    ownerView.unmount();
    const subAdminView = renderMenu({
      providers: [brokenOpenClaw],
      qualifications: { OPENCLAW: brokenQualification },
      qualificationFailures: { OPENCLAW: failure },
      hostRecoveryRole: 'SUB_ADMIN',
      onQualify,
    });
    await user.click(screen.getByRole('button', { name: 'Project chat provider' }));
    await user.click(screen.getByRole('menuitem', { name: 'Review OpenClaw' }));
    expect(screen.getByRole('menuitem', {
      name: 'Open Agent Chat to repair host',
    })).toHaveAttribute('href', '/agent-chats');
    expect(screen.getByRole('menuitem', {
      name: 'Recheck OpenClaw after host repair',
    })).toBeEnabled();
    expect(onQualify).not.toHaveBeenCalled();

    subAdminView.unmount();
    renderMenu({
      providers: [brokenOpenClaw],
      qualifications: { OPENCLAW: brokenQualification },
      qualificationFailures: { OPENCLAW: failure },
      hostRecoveryRole: 'USER',
      onQualify,
    });
    await user.click(screen.getByRole('button', { name: 'Project chat provider' }));
    await user.click(screen.getByRole('menuitem', { name: 'Review OpenClaw' }));
    expect(screen.queryByRole('menuitem', { name: 'Open Dashboard for signed update' })).not.toBeInTheDocument();
    expect(screen.getByText(/Contact an Owner or Sub Admin/)).toBeVisible();
    expect(screen.getByRole('menuitem', {
      name: 'Recheck OpenClaw after host repair',
    })).toBeEnabled();
    expect(onQualify).not.toHaveBeenCalled();
  });

  it('holds a rate-limited provider until its validated retry time', async () => {
    const user = userEvent.setup();
    const now = Date.parse('2026-07-27T22:00:00.000Z');
    const retryAt = '2026-07-27T22:15:00.000Z';
    const onQualify = vi.fn();
    renderMenu({
      providers: [{
        ...openClaw,
        selectable: false,
        executionScope: null,
        reason: 'OpenClaw is not verified for this project yet.',
      }],
      qualifications: {
        OPENCLAW: {
          ...agentZeroQualification,
          provider: 'OPENCLAW',
        },
      },
      qualificationFailures: {
        OPENCLAW: {
          message: 'Too many preparation attempts.',
          code: 'PROJECT_QUALIFICATION_RATE_LIMITED',
          retryable: true,
          recovery: null,
          retryAt,
        },
      },
      qualificationRetryNow: now,
      onQualify,
    });

    await user.click(screen.getByRole('button', { name: 'Project chat provider' }));
    await user.click(screen.getByRole('menuitem', { name: 'Review OpenClaw' }));
    expect(screen.getByRole('status')).toHaveTextContent(/Try again after/);
    expect(screen.getByRole('status').querySelector('time')).toHaveAttribute('datetime', retryAt);
    expect(screen.queryByRole('button', {
      name: 'Qualify OpenClaw for this project',
    })).not.toBeInTheDocument();
    expect(onQualify).not.toHaveBeenCalled();
  });

  it('ignores malformed, expired, and unreasonably distant retry timestamps', async () => {
    const user = userEvent.setup();
    const now = Date.parse('2026-07-27T22:00:00.000Z');
    expect(normalizeProjectQualificationRetryAt('not-a-date', now)).toBeNull();
    expect(normalizeProjectQualificationRetryAt('2026-07-27T21:59:59.000Z', now)).toBeNull();
    expect(normalizeProjectQualificationRetryAt('2026-07-28T00:00:01.000Z', now)).toBeNull();

    const onQualify = vi.fn();
    renderMenu({
      providers: [{
        ...openClaw,
        selectable: false,
        executionScope: null,
        reason: 'OpenClaw is not verified for this project yet.',
      }],
      qualifications: {
        OPENCLAW: {
          ...agentZeroQualification,
          provider: 'OPENCLAW',
        },
      },
      qualificationFailures: {
        OPENCLAW: {
          message: 'Too many preparation attempts.',
          code: 'PROJECT_QUALIFICATION_RATE_LIMITED',
          retryable: true,
          recovery: null,
          retryAt: 'not-a-date',
        },
      },
      qualificationRetryNow: now,
      onQualify,
    });

    await user.click(screen.getByRole('button', { name: 'Project chat provider' }));
    await user.click(screen.getByRole('menuitem', { name: 'Prepare OpenClaw' }));
    expect(screen.queryByText(/Try again after/)).not.toBeInTheDocument();
    expect(onQualify).toHaveBeenCalledWith('OPENCLAW');
  });

  it('keeps qualification details behind an intentional provider choice', async () => {
    const user = userEvent.setup();
    renderMenu();

    expect(screen.queryByText(agentZeroQualification.reason)).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Agent Zero qualification model' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Project chat provider' }));
    expect(screen.getByText('Choose an agent harness')).toBeVisible();
    expect(screen.getByRole('menuitem', { name: 'Use Codex' })).toBeVisible();
    expect(screen.getByRole('menuitem', { name: 'Review Agent Zero' })).toBeVisible();
    expect(screen.queryByText(agentZeroQualification.reason)).not.toBeInTheDocument();

    await user.click(screen.getByRole('menuitem', { name: 'Review Agent Zero' }));
    expect(screen.getByText(agentZeroQualification.reason)).toBeVisible();
    expect(screen.getByRole('combobox', { name: 'Agent Zero qualification model' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Qualify Agent Zero for this project' })).toBeDisabled();
  });

  it('switches ready providers without exposing qualification machinery', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderMenu({ onSelect });

    await user.click(screen.getByRole('button', { name: 'Project chat provider' }));
    await user.click(screen.getByRole('menuitem', { name: 'Use Codex' }));

    expect(onSelect).toHaveBeenCalledWith('CODEX');
    expect(screen.queryByRole('menu', { name: 'Project chat providers' })).not.toBeInTheDocument();
  });

  it('opens on the active provider, supports arrow navigation, and returns focus on Escape', async () => {
    const user = userEvent.setup();
    renderMenu();

    const trigger = screen.getByRole('button', { name: 'Project chat provider' });
    await user.click(trigger);

    const openClawItem = screen.getByRole('menuitem', { name: 'Use OpenClaw' });
    const codexItem = screen.getByRole('menuitem', { name: 'Use Codex' });
    expect(openClawItem).toHaveFocus();

    await user.keyboard('{ArrowDown}');
    expect(codexItem).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu', { name: 'Project chat providers' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('qualifies Agent Zero only with an exact connected model', async () => {
    const user = userEvent.setup();
    const onQualify = vi.fn();
    const onAgentZeroModelChange = vi.fn();
    const { rerender, props } = renderMenu({ onQualify, onAgentZeroModelChange });

    await user.click(screen.getByRole('button', { name: 'Project chat provider' }));
    await user.click(screen.getByRole('menuitem', { name: 'Review Agent Zero' }));
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Agent Zero qualification model' }),
      'codex_oauth/gpt-5.5',
    );
    expect(onAgentZeroModelChange).toHaveBeenCalledWith('codex_oauth/gpt-5.5');

    rerender(
      <ProjectProviderMenu
        {...props}
        agentZeroModel="codex_oauth/gpt-5.5"
        onQualify={onQualify}
        onAgentZeroModelChange={onAgentZeroModelChange}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Qualify Agent Zero for this project' }));
    expect(onQualify).toHaveBeenCalledWith('AGENT_ZERO');
  });

  it('shows an unavailable runtime without offering a qualification action', async () => {
    const user = userEvent.setup();
    const onQualify = vi.fn();
    const unavailableAntigravity: ProjectChatProviderCapability = {
      ...openClaw,
      provider: 'GEMINI',
      displayName: 'Antigravity',
      runtime: 'antigravity-project-adapter',
      selectable: false,
      executionScope: null,
      requiresOAuth: true,
      reason: 'Antigravity Project runtime is not installed and attested on this server.',
    };
    const unavailableQualification: ProjectChatProviderQualificationStatus = {
      provider: 'GEMINI',
      status: 'UNAVAILABLE',
      selectable: false,
      reason: unavailableAntigravity.reason,
      qualifiedAt: null,
      expiresAt: null,
      evidenceFingerprint: null,
    };
    renderMenu({
      providers: [openClaw, unavailableAntigravity],
      qualifications: { GEMINI: unavailableQualification },
      onQualify,
    });

    await user.click(screen.getByRole('button', { name: 'Project chat provider' }));
    await user.click(screen.getByRole('menuitem', { name: 'Review Antigravity' }));

    expect(screen.getByText(unavailableQualification.reason)).toBeVisible();
    expect(screen.getByText('Not available in Project Chat')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Qualify Antigravity for this project' })).not.toBeInTheDocument();
    expect(onQualify).not.toHaveBeenCalled();
  });

  it('remains fail-closed while provider switching is disabled', () => {
    const onSelect = vi.fn();
    renderMenu({ disabled: true, onSelect });

    expect(screen.getByRole('button', { name: 'Project chat provider' })).toBeDisabled();
    expect(screen.queryByRole('menu', { name: 'Project chat providers' })).not.toBeInTheDocument();
    expect(onSelect).not.toHaveBeenCalled();
  });
});
