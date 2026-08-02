// @vitest-environment jsdom
import '../../test/setup';
import React from 'react';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ProjectChatPanel, {
  reconcileProjectPresentationSegments,
  resolveVerifiedProjectModelResponse,
  type ProjectChatActivity,
} from './ProjectChatPanel';
import {
  VIEWPORT_MODAL_Z_INDEX,
  VIEWPORT_TRANSIENT_Z_INDEX,
} from '../ViewportModal';
import type {
  ProjectChatProviderCapability,
  ProjectChatProviderCapabilitiesResponse,
} from '../../api/endpoints';
import {
  projectChatPendingSendStorageKey,
  runCoordinatedProjectChatSend,
} from '../../utils/projectChatPendingSend';

const projectMocks = vi.hoisted(() => ({
  projectChatProviders: vi.fn(),
  projectChatModels: vi.fn(),
  migrateLegacyProjectInPlace: vi.fn(),
  qualifyOpenClawProject: vi.fn(),
  qualifyProjectChatProvider: vi.fn(),
  selectProjectChatProvider: vi.fn(),
  chatHistory: vi.fn(),
  agentPoll: vi.fn(),
  agentAbort: vi.fn(),
  agentMessageStatus: vi.fn(),
  chatClearHistory: vi.fn(),
  autoCommit: vi.fn(),
  gatewayModels: vi.fn(),
  gatewaySessionInfo: vi.fn(),
  gatewayPatchSession: vi.fn(),
  gatewayPatchSessionModel: vi.fn(),
  gatewayPendingQuestions: vi.fn(),
  gatewayAnswerQuestion: vi.fn(),
  gatewayDismissQuestion: vi.fn(),
  agentZeroProjectModels: vi.fn(),
  clientPost: vi.fn(),
  clientGet: vi.fn(),
}));
const viewportMocks = vi.hoisted(() => ({ isMobile: false }));
const authMocks = vi.hoisted(() => ({
  user: {
    id: 'user-1',
    authorizationVersion: 1,
    role: 'OWNER',
  },
}));

vi.mock('framer-motion', async () => {
  const ReactModule = await import('react');
  const components = new Map<string, React.ComponentType<any>>();
  const motion = new Proxy({}, {
    get: (_target, tag: string) => {
      const existing = components.get(tag);
      if (existing) return existing;
      const component = ReactModule.forwardRef<HTMLElement, Record<string, unknown>>((props, ref) => {
      const {
        children,
        initial: _initial,
        animate: _animate,
        exit: _exit,
        transition: _transition,
        layout: _layout,
        whileHover: _whileHover,
        whileTap: _whileTap,
        ...domProps
      } = props;
      return ReactModule.createElement(tag, { ...domProps, ref }, children as React.ReactNode);
      });
      components.set(tag, component);
      return component;
    },
  });
  return {
    motion,
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

vi.mock('../../api/client', () => ({
  default: {
    post: projectMocks.clientPost,
    get: projectMocks.clientGet,
  },
}));

vi.mock('../../api/endpoints', () => ({
  projectsAPI: {
    projectChatProviders: projectMocks.projectChatProviders,
    projectChatModels: projectMocks.projectChatModels,
    migrateLegacyProjectInPlace: projectMocks.migrateLegacyProjectInPlace,
    agentZeroProjectModels: projectMocks.agentZeroProjectModels,
    qualifyOpenClawProject: projectMocks.qualifyOpenClawProject,
    qualifyProjectChatProvider: projectMocks.qualifyProjectChatProvider,
    selectProjectChatProvider: projectMocks.selectProjectChatProvider,
    chatHistory: projectMocks.chatHistory,
    agentPoll: projectMocks.agentPoll,
    agentAbort: projectMocks.agentAbort,
    agentMessageStatus: projectMocks.agentMessageStatus,
    chatClearHistory: projectMocks.chatClearHistory,
    autoCommit: projectMocks.autoCommit,
  },
  gatewayAPI: {
    models: projectMocks.gatewayModels,
    sessionInfo: projectMocks.gatewaySessionInfo,
    patchSession: projectMocks.gatewayPatchSession,
    patchSessionModel: projectMocks.gatewayPatchSessionModel,
    pendingQuestions: projectMocks.gatewayPendingQuestions,
    answerQuestion: projectMocks.gatewayAnswerQuestion,
    dismissQuestion: projectMocks.gatewayDismissQuestion,
  },
}));

vi.mock('../../hooks/useIsMobile', () => ({ useIsMobile: () => viewportMocks.isMobile }));
vi.mock('../../contexts/AuthContext', () => {
  const useAuthStore = Object.assign(
    (selector: (store: typeof authMocks) => unknown) => selector(authMocks),
    { getState: () => authMocks },
  );
  return { useAuthStore };
});
vi.mock('./MarkdownRenderer', () => ({ default: ({ content }: { content: string }) => <span>{content}</span> }));
vi.mock('./SlashCommandMenu', () => ({ default: () => <div>Slash commands</div> }));
vi.mock('./ExecApprovalModal', () => ({ ExecApprovalModal: () => <div>Approval required</div> }));

const openClawCapability: ProjectChatProviderCapability = {
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
  reason: 'Portal verified this Project Sandbox adapter.',
};

const codexCapability: ProjectChatProviderCapability = {
  provider: 'CODEX',
  displayName: 'Codex',
  runtime: 'codex-project-adapter',
  selectable: true,
  executionScope: 'PROJECT_SANDBOX',
  supportsAttachments: true,
  supportsModelSelection: true,
  supportsAbort: true,
  supportsReset: true,
  requiresOAuth: true,
  reason: 'Portal verified this Project Sandbox adapter.',
};

function capabilities(
  activeTurn: null | { id: string; provider: 'OPENCLAW'; status: string; requestId: string; leaseExpiresAt: string } = null,
): ProjectChatProviderCapabilitiesResponse {
  return {
    activeProvider: 'OPENCLAW',
    providers: [openClawCapability, codexCapability],
    supportedProviders: [openClawCapability, codexCapability],
    bindings: [],
    executionContext: { scope: 'PROJECT_SANDBOX', projectId: 'project-alpha', policyFingerprint: 'policy-v1' },
    qualifications: {
      OPENCLAW: {
        provider: 'OPENCLAW',
        status: 'QUALIFIED',
        selectable: true,
        reason: 'Current live qualification is valid.',
        qualifiedAt: '2026-07-19T08:00:00.000Z',
        expiresAt: '2026-07-19T20:00:00.000Z',
        evidenceFingerprint: 'a'.repeat(64),
      },
      CODEX: {
        provider: 'CODEX',
        status: 'QUALIFIED',
        selectable: true,
        reason: 'Current live qualification is valid.',
        qualifiedAt: '2026-07-19T08:00:00.000Z',
        expiresAt: '2026-07-19T20:00:00.000Z',
        evidenceFingerprint: 'b'.repeat(64),
      },
      CLAUDE_CODE: {
        provider: 'CLAUDE_CODE',
        status: 'UNQUALIFIED',
        selectable: false,
        reason: 'Not qualified.',
        qualifiedAt: null,
        expiresAt: null,
        evidenceFingerprint: null,
      },
      AGENT_ZERO: {
        provider: 'AGENT_ZERO',
        status: 'UNQUALIFIED',
        selectable: false,
        reason: 'Not qualified.',
        qualifiedAt: null,
        expiresAt: null,
        evidenceFingerprint: null,
      },
      GEMINI: {
        provider: 'GEMINI',
        status: 'UNQUALIFIED',
        selectable: false,
        reason: 'Not qualified.',
        qualifiedAt: null,
        expiresAt: null,
        evidenceFingerprint: null,
      },
      OLLAMA: {
        provider: 'OLLAMA',
        status: 'UNQUALIFIED',
        selectable: false,
        reason: 'Not qualified.',
        qualifiedAt: null,
        expiresAt: null,
        evidenceFingerprint: null,
      },
    },
    coordination: {
      stateVersion: 1,
      selectedProvider: 'OPENCLAW',
      transcriptCursor: 0,
      activeTurn,
    },
  };
}

function unqualifiedOpenClawCapabilities(
  projectId: string,
): ProjectChatProviderCapabilitiesResponse {
  const result = capabilities();
  result.executionContext = {
    scope: 'PROJECT_SANDBOX',
    projectId,
    policyFingerprint: 'policy-v1',
  };
  result.providers = result.providers.map((entry) => (
    entry.provider === 'OPENCLAW'
      ? {
          ...entry,
          selectable: false,
          executionScope: null,
          reason: 'OpenClaw is not verified for this project yet.',
        }
      : entry
  ));
  result.supportedProviders = result.supportedProviders.filter(
    (entry) => entry.provider !== 'OPENCLAW',
  );
  result.qualifications.OPENCLAW = {
    provider: 'OPENCLAW',
    status: 'UNQUALIFIED',
    selectable: false,
    reason: 'OpenClaw is not verified for this project yet.',
    qualifiedAt: null,
    expiresAt: null,
    evidenceFingerprint: null,
  };
  return result;
}

function replaySnapshot(overrides: Record<string, unknown> = {}) {
  return {
    provider: 'OPENCLAW',
    sessionKey: 'project-session-1',
    stateVersion: 1,
    lineCount: 0,
    events: [],
    active: false,
    isProcessing: false,
    complete: false,
    status: 'idle',
    runId: null,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('ProjectChatPanel rendered provider contract', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    Object.values(projectMocks).forEach((mock) => mock.mockReset());
    viewportMocks.isMobile = false;
    authMocks.user.id = 'user-1';
    authMocks.user.role = 'OWNER';
    window.localStorage.clear();
    window.sessionStorage.clear();
    Object.defineProperty(globalThis.navigator, 'locks', {
      configurable: true,
      value: {
        request: async (_name: string, _options: unknown, callback: () => Promise<unknown>) => callback(),
      },
    });
    projectMocks.chatHistory.mockResolvedValue({
      messages: [],
      pagination: { hasMore: false, nextCursor: null, limit: 100 },
    });
    projectMocks.agentPoll.mockResolvedValue(replaySnapshot());
    projectMocks.projectChatModels.mockResolvedValue({
      provider: 'OPENCLAW',
      models: [{ id: 'openai/gpt-5.5', displayName: 'GPT-5.5' }],
    });
    projectMocks.gatewayModels.mockResolvedValue({ provider: 'OPENCLAW', models: [] });
    projectMocks.gatewaySessionInfo.mockResolvedValue({ session: { thinking: 'high', reasoning: 'off' } });
    projectMocks.gatewayPatchSession.mockResolvedValue({});
    projectMocks.gatewayPatchSessionModel.mockResolvedValue({});
    projectMocks.gatewayPendingQuestions.mockResolvedValue({ questions: [] });
    projectMocks.gatewayAnswerQuestion.mockImplementation(async (id: string) => ({
      ok: true,
      id,
      state: 'answered',
    }));
    projectMocks.gatewayDismissQuestion.mockResolvedValue({ ok: true });
    projectMocks.agentZeroProjectModels.mockResolvedValue({
      available: true,
      checkedAt: '2026-07-19T08:00:00.000Z',
      providers: [{
        providerId: 'codex_oauth',
        displayName: 'OpenAI Codex',
        connectionState: 'connected',
        models: [
          { id: 'gpt-5.5', displayName: 'GPT-5.5', description: 'Coding model' },
          { id: 'gpt-5.4', displayName: 'GPT-5.4', description: 'Coding model' },
        ],
      }],
    });
    projectMocks.agentAbort.mockResolvedValue({});
    projectMocks.agentMessageStatus.mockImplementation(async (
      _name: string,
      request: { provider: string; messageId: string },
    ) => ({
      found: true,
      status: 'active',
      provider: request.provider,
      messageId: request.messageId,
      projectId: 'project-alpha',
      stateVersion: 1,
      turnStatus: 'running',
      dispatchStatus: 'unknown',
      recoveryRequired: true,
      turnId: 'turn-pending',
    }));
    projectMocks.chatClearHistory.mockResolvedValue({});
    projectMocks.autoCommit.mockResolvedValue({ committed: false });
    projectMocks.qualifyOpenClawProject.mockResolvedValue({
      provider: 'OPENCLAW',
      qualification: capabilities().qualifications.OPENCLAW,
    });
    projectMocks.qualifyProjectChatProvider.mockImplementation(async (_name: string, provider: keyof ReturnType<typeof capabilities>['qualifications']) => ({
      provider,
      qualification: capabilities().qualifications[provider],
      stateVersion: 2,
    }));
    projectMocks.clientPost.mockImplementation(async (url: string) => {
      if (url.endsWith('/assistant/ensure-session')) {
        return {
          data: {
            provider: 'OPENCLAW',
            stateVersion: 1,
            sessionKey: 'project-session-1',
            agentId: 'project-agent-1',
            runtime: 'openclaw-dedicated-project-agent',
            model: 'openai/gpt-5.5',
            modelValidated: true,
            modelVerified: true,
          },
        };
      }
      throw new Error(`Unexpected POST ${url}`);
    });
    projectMocks.clientGet.mockImplementation(async (url: string, config?: { params?: Record<string, unknown> }) => {
      if (url.endsWith('/assistant/resume-session')) {
        return {
          data: {
            resumed: true,
            turnId: config?.params?.turnId,
            provider: 'OPENCLAW',
            stateVersion: 1,
            sessionKey: 'project-session-1',
            agentId: 'project-agent-1',
            runtime: 'openclaw-dedicated-project-agent',
            model: 'openai/gpt-5.5',
            modelValidated: true,
            modelVerified: true,
          },
        };
      }
      throw new Error(`Unexpected GET ${url}`);
    });
  });

  it('renders and answers the exact broker question for a paused OpenClaw Project turn', async () => {
    projectMocks.projectChatProviders.mockResolvedValue(capabilities({
      id: 'turn-waiting',
      provider: 'OPENCLAW',
      status: 'RUNNING',
      requestId: 'message-waiting',
      leaseExpiresAt: '2030-01-01T00:00:00.000Z',
    }));
    projectMocks.agentPoll.mockResolvedValue(replaySnapshot({
      active: true,
      isProcessing: true,
      status: 'running',
      runId: 'turn-waiting',
    }));
    projectMocks.gatewayPendingQuestions.mockResolvedValue({
      questions: [{
        id: 'askq-project-1',
        sessionKey: 'project-session-1',
        surface: 'project-chat',
        state: 'pending',
        createdAt: Date.now(),
        expiresAt: Date.now() + 300_000,
        questions: [{
          id: 'question-deploy',
          question: 'Deploy this change?',
          multiSelect: false,
          options: [],
        }],
      }],
    });

    const user = userEvent.setup();
    render(<ProjectChatPanel projectName="alpha" onClose={vi.fn()} />);

    expect(await screen.findByRole('region', { name: /waiting on your answer/i })).toBeVisible();
    const composer = await screen.findByPlaceholderText('Answer the waiting question…');
    expect(composer).toBeEnabled();
    await user.type(composer, 'Yes');
    await user.click(screen.getByRole('button', { name: 'Answer the waiting project question' }));

    await waitFor(() => expect(projectMocks.gatewayAnswerQuestion).toHaveBeenCalledWith(
      'askq-project-1',
      { 'question-deploy': 'Yes' },
    ));
    expect(projectMocks.clientPost.mock.calls.some(
      ([url]) => String(url).endsWith('/assistant/send') || String(url).endsWith('/assistant/answer-input'),
    )).toBe(false);
  });

  it('fails closed when the Project composer cannot represent every pending answer', async () => {
    projectMocks.projectChatProviders.mockResolvedValue(capabilities({
      id: 'turn-waiting',
      provider: 'OPENCLAW',
      status: 'RUNNING',
      requestId: 'message-waiting',
      leaseExpiresAt: '2030-01-01T00:00:00.000Z',
    }));
    projectMocks.agentPoll.mockResolvedValue(replaySnapshot({
      active: true,
      isProcessing: true,
      status: 'running',
      runId: 'turn-waiting',
    }));
    projectMocks.gatewayPendingQuestions.mockResolvedValue({
      questions: [{
        id: 'askq-project-many',
        sessionKey: 'project-session-1',
        surface: 'project-chat',
        state: 'pending',
        createdAt: Date.now(),
        expiresAt: Date.now() + 300_000,
        questions: [
          { id: 'question-environment', question: 'Environment?', multiSelect: false, options: [] },
          { id: 'question-region', question: 'Region?', multiSelect: false, options: [] },
        ],
      }],
    });

    const user = userEvent.setup();
    render(<ProjectChatPanel projectName="alpha" onClose={vi.fn()} />);

    const composer = await screen.findByPlaceholderText('Answer the waiting question…');
    await user.type(composer, 'production');
    await user.click(screen.getByRole('button', { name: 'Answer the waiting project question' }));

    expect(await screen.findByText(/needs more than one answer/i)).toBeVisible();
    expect(projectMocks.gatewayAnswerQuestion).not.toHaveBeenCalled();
    expect(composer).toHaveValue('production');
  });

  it('steers an active Project turn with one stable delivery id when no question is pending', async () => {
    projectMocks.projectChatProviders.mockResolvedValue(capabilities({
      id: 'turn-steer',
      provider: 'OPENCLAW',
      status: 'RUNNING',
      requestId: 'message-steer',
      leaseExpiresAt: '2030-01-01T00:00:00.000Z',
    }));
    projectMocks.agentPoll.mockResolvedValue(replaySnapshot({
      active: true,
      isProcessing: true,
      status: 'running',
      runId: 'turn-steer',
    }));
    let steerAttempts = 0;
    projectMocks.clientPost.mockImplementation(async (url: string, body?: Record<string, unknown>) => {
      if (url.endsWith('/assistant/answer-input')) {
        steerAttempts += 1;
        if (steerAttempts === 1) throw new Error('response lost');
        return {
          data: {
            accepted: true,
            provider: 'OPENCLAW',
            turnId: 'turn-steer',
            sessionKey: 'project-session-1',
            requestId: body?.requestId,
          },
        };
      }
      if (url.endsWith('/assistant/ensure-session')) {
        return {
          data: {
            provider: 'OPENCLAW',
            stateVersion: 1,
            sessionKey: 'project-session-1',
            agentId: 'project-agent-1',
            runtime: 'openclaw-dedicated-project-agent',
            model: 'openai/gpt-5.5',
            modelValidated: true,
            modelVerified: true,
          },
        };
      }
      throw new Error(`Unexpected POST ${url}`);
    });

    const user = userEvent.setup();
    render(<ProjectChatPanel projectName="alpha" onClose={vi.fn()} />);

    const composer = await screen.findByPlaceholderText('Guide this active turn…');
    await user.type(composer, 'Check the migration first');
    const send = screen.getByRole('button', { name: 'Guide the active project turn' });
    await user.click(send);
    expect(await screen.findByText('response lost')).toBeVisible();
    await user.click(send);

    await waitFor(() => expect(steerAttempts).toBe(2));
    const steeringBodies = projectMocks.clientPost.mock.calls
      .filter(([url]) => String(url).endsWith('/assistant/answer-input'))
      .map(([, body]) => body as Record<string, unknown>);
    expect(steeringBodies[0].requestId).toBeTruthy();
    expect(steeringBodies[1].requestId).toBe(steeringBodies[0].requestId);
    expect(steeringBodies[1]).toMatchObject({
      turnId: 'turn-steer',
      message: 'Check the migration first',
    });
  });

  it('gives the mobile Project Chat surface body-owned modal interaction', async () => {
    viewportMocks.isMobile = true;
    vi.stubGlobal('innerWidth', 700);
    projectMocks.projectChatProviders.mockResolvedValue(capabilities());
    const onClose = vi.fn();
    const user = userEvent.setup();

    const view = render(<ProjectChatPanel projectName="alpha" onClose={onClose} />);

    expect(await screen.findByRole('dialog', { name: 'Project Chat for alpha' })).toBeVisible();
    expect(document.querySelector('[data-viewport-overlay-root="true"]')).not.toBeNull();
    expect(document.body.style.overflow).toBe('hidden');

    await user.click(await screen.findByRole('button', { name: 'Project chat provider' }));
    expect(await screen.findByRole('menu', { name: 'Project chat providers' })).toBeVisible();
    const overlayRoots = Array.from(document.querySelectorAll<HTMLElement>('[data-viewport-overlay-root="true"]'));
    expect(overlayRoots).toHaveLength(2);
    expect(overlayRoots[0]).toHaveAttribute('inert');
    expect(overlayRoots[1]).not.toHaveAttribute('inert');
    expect(Number(overlayRoots[1].style.zIndex)).toBeGreaterThan(Number(overlayRoots[0].style.zIndex));

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu', { name: 'Project chat providers' })).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);

    view.unmount();
    expect(document.body.style.overflow).toBe('');
  });

  it('does not adopt a model response without server validation', () => {
    expect(() => resolveVerifiedProjectModelResponse(openClawCapability, {
      model: 'anthropic/claude-fable-5',
      modelValidated: false,
    })).toThrow(/validated OpenClaw Project model/i);

    expect(resolveVerifiedProjectModelResponse(openClawCapability, {
      model: 'anthropic/claude-fable-5',
      modelValidated: true,
    })).toBe('anthropic/claude-fable-5');
  });

  it('uses the same server validation contract for native provider models', () => {
    expect(() => resolveVerifiedProjectModelResponse(codexCapability, {
      model: 'openai/gpt-5.5',
      modelValidated: false,
    })).toThrow(/validated Codex Project model/i);
    expect(resolveVerifiedProjectModelResponse(codexCapability, {
      model: 'openai/gpt-5.5',
      modelValidated: true,
    })).toBe('openai/gpt-5.5');
  });

  it('keeps model and session menus outside the clipped Project Chat rail', async () => {
    projectMocks.projectChatProviders.mockResolvedValue(capabilities());
    projectMocks.projectChatModels.mockResolvedValue({
      provider: 'OPENCLAW',
      models: [{ id: 'openai/gpt-5.5', displayName: 'GPT-5.5' }],
    });
    const user = userEvent.setup();
    const view = render(<ProjectChatPanel projectName="alpha" onClose={vi.fn()} />);

    const modelTrigger = await screen.findByRole(
      'button',
      { name: 'Select project chat model' },
      { timeout: 2500 },
    );
    await waitFor(() => expect(modelTrigger).toBeEnabled());
    await user.click(modelTrigger);

    const modelDialog = screen.getByRole('dialog', { name: 'Select model' });
    const modelPopoverRoot = modelDialog.closest<HTMLElement>(
      '[data-anchored-popover-root="true"]',
    );
    expect(view.container).not.toContainElement(modelDialog);
    expect(document.body).toContainElement(modelDialog);
    expect(modelPopoverRoot).toHaveStyle({ zIndex: String(VIEWPORT_TRANSIENT_Z_INDEX) });
    expect(Number(modelPopoverRoot?.style.zIndex)).toBeLessThan(VIEWPORT_MODAL_Z_INDEX);

    await user.click(screen.getByRole('button', { name: 'Close model selector' }));
    await user.click(screen.getByRole('button', { name: 'Session controls' }));

    const sessionDialog = screen.getByRole('dialog', { name: 'Session controls' });
    const sessionPopoverRoot = sessionDialog.closest<HTMLElement>(
      '[data-anchored-popover-root="true"]',
    );
    expect(view.container).not.toContainElement(sessionDialog);
    expect(document.body).toContainElement(sessionDialog);
    expect(sessionPopoverRoot).toHaveStyle({ zIndex: String(VIEWPORT_TRANSIENT_Z_INDEX) });
    expect(Number(sessionPopoverRoot?.style.zIndex)).toBeLessThan(VIEWPORT_MODAL_Z_INDEX);
  });

  it('single-flights Project session controls, uses response truth, and rolls back failed fast toggles', async () => {
    projectMocks.projectChatProviders.mockResolvedValue(capabilities());
    projectMocks.projectChatModels.mockResolvedValue({
      provider: 'OPENCLAW',
      models: [{ id: 'openai/gpt-5.5', displayName: 'GPT-5.5' }],
    });
    projectMocks.gatewaySessionInfo.mockResolvedValue({
      session: { thinkingLevel: 'high', reasoningLevel: 'off', fastMode: false },
    });
    const firstPatch = deferred<any>();
    projectMocks.gatewayPatchSession.mockReturnValueOnce(firstPatch.promise);
    const onClose = vi.fn();
    const onActivityChange = vi.fn<(
      activity: Readonly<ProjectChatActivity>,
      active: boolean,
    ) => boolean>(() => true);
    const user = userEvent.setup();
    render(
      <ProjectChatPanel
        projectName="alpha"
        onClose={onClose}
        onActivityChange={onActivityChange}
      />,
    );

    await waitFor(() => expect(screen.getByRole('button', { name: 'Session controls' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Session controls' }));
    const dialog = screen.getByRole('dialog', { name: 'Session controls' });
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Toggle Codex fast mode' })).toBeEnabled());
    const fastToggle = within(dialog).getByRole('button', { name: 'Toggle Codex fast mode' });
    const closeProjectChat = screen.getByRole('button', { name: 'Close project chat' });

    act(() => {
      fastToggle.click();
      fastToggle.click();
      closeProjectChat.click();
    });
    expect(projectMocks.gatewayPatchSession).toHaveBeenCalledTimes(1);
    expect(projectMocks.gatewayPatchSession).toHaveBeenCalledWith(
      'project-session-1',
      { fastMode: true },
      'OPENCLAW',
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(onActivityChange).toHaveBeenCalledTimes(1);
    const activity = onActivityChange.mock.calls[0][0];
    expect(activity).toEqual(expect.objectContaining({
      kind: 'session-control',
      projectName: 'alpha',
      provider: 'OPENCLAW',
      sessionKey: 'project-session-1',
      control: 'fastMode',
    }));
    expect(onActivityChange.mock.calls[0][1]).toBe(true);
    expect(within(dialog).getByRole('status')).toHaveTextContent('Saving fast mode…');
    expect(within(dialog).getByLabelText('Thinking level')).toBeDisabled();
    expect(within(dialog).getByLabelText('Reasoning visibility')).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Close session controls' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Close project chat' })).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(dialog).toBeVisible();

    await act(async () => {
      firstPatch.resolve({ session: { fastMode: true } });
      await firstPatch.promise;
    });
    await waitFor(() => expect(fastToggle).toHaveAttribute('aria-pressed', 'true'));
    expect(onActivityChange).toHaveBeenCalledWith(activity, false);

    projectMocks.gatewayPatchSession.mockRejectedValueOnce({ response: { data: { error: 'Gateway rejected fast mode' } } });
    projectMocks.gatewaySessionInfo.mockResolvedValueOnce({
      session: { thinkingLevel: 'high', reasoningLevel: 'off', fastMode: true },
    });
    await user.click(fastToggle);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Gateway rejected fast mode');
    expect(fastToggle).toHaveAttribute('aria-pressed', 'true');
    expect(onActivityChange.mock.calls.at(-1)?.[1]).toBe(false);
    const closeSessionControls = within(dialog).getByRole('button', { name: 'Close session controls' });
    await waitFor(() => expect(closeSessionControls).toBeEnabled());
    await user.click(closeSessionControls);
    await user.click(screen.getByRole('button', { name: 'Close project chat' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps provider actions fail-closed while leaving the composer available to queue a first message', async () => {
    projectMocks.projectChatProviders.mockRejectedValue(new Error('runtime attestation failed'));
    render(<ProjectChatPanel projectName="alpha" onClose={vi.fn()} />);

    expect(await screen.findByText('No Project Chat provider is verified')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Prepare OpenClaw for this project' })).toBeVisible();
    // sending stays fail-closed, but choosing a different provider is
    // the recovery action and has to remain reachable. Every selection is
    // re-qualified server-side, so this picker is not the isolation boundary.
    expect(screen.getByRole('button', { name: 'Project chat provider' })).toBeEnabled();
    expect(screen.getByRole('textbox', { name: 'Message project agent' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Send message to project agent' })).toBeDisabled();
    expect(projectMocks.clientPost).not.toHaveBeenCalled();
  });

  it('offers a verified Project Chat copy while keeping ZIP as an optional backup', async () => {
    const onClose = vi.fn();
    projectMocks.projectChatProviders.mockResolvedValue({
      migration: {
        required: true,
        projectId: 'older-project-id',
        title: 'Prepare this project for Project Chat',
        message: 'Portal will preserve this project, its links, and its files. Older agent history must be reconciled before Project Chat can be prepared; if that evidence is still present, nothing is changed.',
      },
    } as ProjectChatProviderCapabilitiesResponse);
    projectMocks.migrateLegacyProjectInPlace.mockReturnValue(new Promise(() => {}));

    render(<ProjectChatPanel projectName="older-project" onClose={onClose} />);

    const panel = await screen.findByRole('region', { name: 'Project Chat for older-project' });
    expect(within(panel).getByRole('heading', { name: 'Prepare this project for Project Chat' })).toBeVisible();
    expect(within(panel).getByText(/preserve this project, its links, and its files/i)).toBeVisible();
    const migrate = within(panel).getByRole('button', { name: 'Check and prepare project' });
    expect(migrate).toHaveAttribute('data-contrast-check', 'legacy-migration-primary');
    expect(migrate).toHaveClass('bg-amber-300', 'text-slate-950');
    expect(within(panel).getByRole('link', { name: 'Download a backup (optional)' })).toHaveAttribute(
      'href',
      '/api/projects/older-project/download?mode=full',
    );
    expect(within(panel).getByText(/creates a manifest-verified Project Chat copy with a new name/i)).toBeVisible();
    expect(within(panel).getByText(/legacy source, its share links, hosted apps, deployment, and older agent state stay untouched/i)).toBeVisible();
    expect(screen.queryByText('No Project Chat provider is verified')).not.toBeInTheDocument();
    expect(projectMocks.chatHistory).not.toHaveBeenCalled();
    expect(projectMocks.agentPoll).not.toHaveBeenCalled();
    expect(projectMocks.clientPost).not.toHaveBeenCalled();
    expect(projectMocks.clientGet).not.toHaveBeenCalled();

    await userEvent.click(migrate);
    expect(projectMocks.migrateLegacyProjectInPlace).toHaveBeenCalledWith('older-project');
    expect(within(panel).getByRole('button', { name: /checking project safety/i })).toBeDisabled();

    await userEvent.click(within(panel).getByRole('button', { name: 'Close project chat' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('opens the verified CURRENT copy without promoting the legacy source identity', async () => {
    const onProjectPrepared = vi.fn().mockResolvedValue(undefined);
    projectMocks.projectChatProviders.mockResolvedValue({
      migration: {
        required: true,
        projectId: 'older-project-id',
        title: 'Prepare this project for Project Chat',
        message: 'Portal can make a safe copy.',
      },
    } as ProjectChatProviderCapabilitiesResponse);
    projectMocks.migrateLegacyProjectInPlace.mockResolvedValue({
      migrated: true,
      projectId: 'current-copy-id',
      projectName: 'older-project_Portal4_olderpro',
      sourceProjectId: 'older-project-id',
      sourceProjectName: 'older-project',
      generation: 1,
      alreadyCurrent: false,
      integrity: {
        fileCount: 4,
        totalBytes: 100,
        manifestSha256: 'manifest-sha',
      },
    });

    render(
      <ProjectChatPanel
        projectName="older-project"
        onClose={vi.fn()}
        onProjectPrepared={onProjectPrepared}
      />,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Check and prepare project' }));

    await waitFor(() => expect(onProjectPrepared).toHaveBeenCalledWith(
      'older-project_Portal4_olderpro',
    ));
  });

  it('keeps the migration card and gives a plain recovery sentence after a gateway interruption', async () => {
    projectMocks.projectChatProviders.mockResolvedValue({
      migration: {
        required: true,
        projectId: 'older-project-id',
        title: 'Prepare this project for Project Chat',
        message: 'Portal will preserve this project. If older agent evidence is still present, nothing is changed.',
      },
    } as ProjectChatProviderCapabilitiesResponse);
    projectMocks.migrateLegacyProjectInPlace.mockRejectedValue(
      new Error('Request failed with status code 502'),
    );
    render(<ProjectChatPanel projectName="older-project" onClose={vi.fn()} />);

    const prepare = await screen.findByRole('button', { name: 'Check and prepare project' });
    await userEvent.click(prepare);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Portal could not finish preparing this project. Its original files remain unchanged.',
    );
    expect(screen.queryByText(/status code 502/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check and prepare project' })).toBeEnabled();
  });

  it('announces replay and rate-limit notices through a polite live region', async () => {
    projectMocks.projectChatProviders.mockReturnValue(new Promise(() => {}));
    render(<ProjectChatPanel projectName="alpha" onClose={vi.fn()} />);

    const status = await screen.findByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveAttribute('aria-atomic', 'true');
    expect(status).toHaveTextContent('Preparing sandbox → Connecting agent');
  });

  it('lets the server reconcile an automatic OpenClaw handshake instead of sending browser model state', async () => {
    localStorage.setItem('agent-model-alpha-OPENCLAW', 'anthropic/claude-fable-5');
    projectMocks.projectChatProviders.mockResolvedValue({
      ...capabilities(),
      qualifiedModels: { OPENCLAW: 'openai/gpt-5.6-sol' },
    });

    render(<ProjectChatPanel projectName="alpha" onClose={vi.fn()} />);

    await waitFor(() => expect(projectMocks.clientPost).toHaveBeenCalledWith(
      '/projects/alpha/assistant/ensure-session',
      {
        provider: 'OPENCLAW',
        stateVersion: 1,
      },
    ));
  });

  it('ignores a stale browser model and sends only the exact Project agent xAI model', async () => {
    localStorage.setItem('agent-model-alpha-OPENCLAW', 'openai/gpt-5.6-sol');
    projectMocks.projectChatProviders.mockResolvedValue(capabilities());
    projectMocks.projectChatModels.mockResolvedValue({
      provider: 'OPENCLAW',
      models: [{
        id: 'xai/grok-4.20-beta-latest-reasoning',
        displayName: 'grok-4.20-beta-latest-reasoning',
      }],
    });
    projectMocks.clientPost.mockImplementation(async (url: string) => {
      if (url.endsWith('/assistant/ensure-session')) {
        return {
          data: {
            provider: 'OPENCLAW',
            stateVersion: 1,
            sessionKey: 'project-session-1',
            agentId: 'project-agent-1',
            runtime: 'openclaw-dedicated-project-agent',
            model: 'xai/grok-4.20-beta-latest-reasoning',
            modelValidated: true,
            modelVerified: true,
          },
        };
      }
      if (url.endsWith('/assistant/send')) {
        return {
          data: {
            provider: 'OPENCLAW',
            stateVersion: 2,
            sessionKey: 'project-session-1',
            turnId: 'turn-xai-1',
            runId: 'turn-xai-1',
            executionContext: { scope: 'PROJECT_SANDBOX', projectId: 'project-alpha' },
            model: 'xai/grok-4.20-beta-latest-reasoning',
            modelValidated: true,
            modelVerified: true,
          },
        };
      }
      throw new Error(`Unexpected POST ${url}`);
    });

    const user = userEvent.setup();
    render(<ProjectChatPanel projectName="alpha" onClose={vi.fn()} />);

    await waitFor(() => expect(projectMocks.projectChatModels).toHaveBeenCalledWith('alpha'), {
      timeout: 2500,
    });
    const modelTrigger = await screen.findByRole(
      'button',
      { name: 'Select project chat model' },
      { timeout: 2500 },
    );
    expect(modelTrigger).toHaveAttribute('title', 'xai/grok-4.20-beta-latest-reasoning');
    expect(projectMocks.gatewayModels).not.toHaveBeenCalled();
    await user.click(modelTrigger);
    expect(screen.queryByRole('button', { name: 'Default' })).not.toBeInTheDocument();
    expect(screen.queryByText('Custom model…')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close model selector' }));

    const ensureCall = projectMocks.clientPost.mock.calls.find(
      ([url]) => String(url).endsWith('/assistant/ensure-session'),
    );
    expect(ensureCall?.[1]).toEqual({
      provider: 'OPENCLAW',
      stateVersion: 1,
    });

    const composer = screen.getByRole('textbox', { name: 'Message project agent' });
    await user.type(composer, 'Use the working model.');
    const send = screen.getByRole('button', { name: 'Send message to project agent' });
    await waitFor(() => expect(send).toBeEnabled());
    await user.click(send);
    await waitFor(() => expect(projectMocks.clientPost).toHaveBeenCalledWith(
      '/projects/alpha/assistant/send',
      expect.objectContaining({
        provider: 'OPENCLAW',
        model: 'xai/grok-4.20-beta-latest-reasoning',
      }),
    ));
  });

  it('loads the exact Project catalog after a delayed capability bootstrap', async () => {
    const user = userEvent.setup();
    const providerBootstrap = deferred<ProjectChatProviderCapabilitiesResponse>();
    projectMocks.projectChatProviders.mockReturnValueOnce(providerBootstrap.promise);
    projectMocks.projectChatModels.mockResolvedValue({
      provider: 'OPENCLAW',
      models: [{
        id: 'xai/grok-4.20-beta-latest-reasoning',
        displayName: 'grok-4.20-beta-latest-reasoning',
      }],
    });
    projectMocks.clientPost.mockImplementation(async (url: string) => {
      if (url.endsWith('/assistant/ensure-session')) {
        return {
          data: {
            provider: 'OPENCLAW',
            stateVersion: 1,
            sessionKey: 'project-session-1',
            agentId: 'project-agent-1',
            runtime: 'openclaw-dedicated-project-agent',
            model: 'xai/grok-4.20-beta-latest-reasoning',
            modelValidated: true,
            modelVerified: true,
          },
        };
      }
      throw new Error(`Unexpected POST ${url}`);
    });

    render(<ProjectChatPanel projectName="alpha" onClose={vi.fn()} />);

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 10));
    });
    expect(projectMocks.projectChatModels).not.toHaveBeenCalled();

    await act(async () => {
      providerBootstrap.resolve(capabilities());
      await providerBootstrap.promise;
    });

    await waitFor(() => expect(projectMocks.projectChatModels).toHaveBeenCalledWith('alpha'));
    await waitFor(() => expect(
      screen.getByRole('button', { name: 'Select project chat model' }),
    ).toHaveAttribute('title', 'xai/grok-4.20-beta-latest-reasoning'));
    const composer = screen.getByRole('textbox', { name: 'Message project agent' });
    await waitFor(() => expect(composer).toBeEnabled());
    await user.type(composer, 'Ready after capability bootstrap.');
    await waitFor(() => expect(
      screen.getByRole('button', { name: 'Send message to project agent' }),
    ).toBeEnabled());
  });

  it('blocks Project sends when the exact agent has no authenticated embedded model', async () => {
    localStorage.setItem('agent-model-alpha-OPENCLAW', 'openai/gpt-5.6-sol');
    projectMocks.projectChatProviders.mockResolvedValue(capabilities());
    projectMocks.projectChatModels.mockResolvedValue({
      provider: 'OPENCLAW',
      models: [],
    });
    projectMocks.clientPost.mockImplementation(async (url: string) => {
      if (url.endsWith('/assistant/ensure-session')) {
        return {
          data: {
            provider: 'OPENCLAW',
            stateVersion: 1,
            sessionKey: 'project-session-1',
            agentId: 'project-agent-1',
            runtime: 'openclaw-dedicated-project-agent',
            model: 'openai/gpt-5.6-sol',
            modelValidated: true,
            modelVerified: true,
          },
        };
      }
      throw new Error(`Unexpected POST ${url}`);
    });

    render(<ProjectChatPanel projectName="alpha" onClose={vi.fn()} />);

    expect(await screen.findByText(
      /No authenticated embedded model is available for this OpenClaw Project agent/i,
      {},
      { timeout: 2500 },
    )).toBeVisible();
    expect(screen.queryByText('OpenClaw Project agent verified and ready')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send message to project agent' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Message project agent' })).toBeDisabled();
    expect(projectMocks.gatewayModels).not.toHaveBeenCalled();
    expect(localStorage.getItem('agent-model-alpha-OPENCLAW')).toBe('openai/gpt-5.6-sol');
  });

  it('prepares OpenClaw automatically while keeping the composer available to queue', async () => {
    const qualification = deferred<{
      provider: 'OPENCLAW';
      qualification: ReturnType<typeof capabilities>['qualifications']['OPENCLAW'];
      stateVersion: number;
    }>();
    const onClose = vi.fn();
    const onActivityChange = vi.fn((_activity: unknown, _active: boolean) => true);
    projectMocks.projectChatModels.mockResolvedValue({
        provider: 'OPENCLAW',
        models: [{
          id: 'xai/grok-4.20-beta-latest-reasoning',
          displayName: 'grok-4.20-beta-latest-reasoning',
        }],
      });
    const unqualified = capabilities();
    const rawProbe = 'docker exec portal-project pwd -P=/root/.openclaw; nonce=secret';
    unqualified.providers = unqualified.providers.map((entry) => (
      entry.provider === 'OPENCLAW'
        ? {
            ...entry,
            selectable: false,
            executionScope: null,
            reason: rawProbe,
          }
        : entry
    ));
    unqualified.supportedProviders = unqualified.supportedProviders.filter((entry) => entry.provider !== 'OPENCLAW');
    unqualified.qualifications.OPENCLAW = {
      provider: 'OPENCLAW',
      status: 'UNQUALIFIED',
      selectable: false,
      reason: rawProbe,
      qualifiedAt: null,
      expiresAt: null,
      evidenceFingerprint: null,
    };
    const qualified = capabilities();
    qualified.coordination.stateVersion = 2;
    qualified.qualifiedModels = {
      OPENCLAW: 'xai/grok-4.20-beta-latest-reasoning',
    };
    projectMocks.projectChatProviders
      .mockResolvedValueOnce(unqualified)
      .mockResolvedValue(qualified);
    projectMocks.qualifyProjectChatProvider.mockReturnValueOnce(qualification.promise);
    projectMocks.agentPoll.mockResolvedValue(replaySnapshot({ stateVersion: 2 }));
    projectMocks.clientPost.mockImplementation(async (url: string) => {
      if (url.endsWith('/assistant/ensure-session')) {
        return {
          data: {
            provider: 'OPENCLAW',
            stateVersion: 2,
            sessionKey: 'project-session-1',
            agentId: 'project-agent-1',
            runtime: 'openclaw-dedicated-project-agent',
            model: 'xai/grok-4.20-beta-latest-reasoning',
            modelValidated: true,
            modelVerified: true,
          },
        };
      }
      throw new Error(`Unexpected POST ${url}`);
    });

    render(
      <ProjectChatPanel
        projectName="alpha"
        onClose={onClose}
        onActivityChange={onActivityChange}
      />,
    );
    const providerMenu = await screen.findByRole('button', { name: 'Project chat provider' });
    expect(screen.getByRole('textbox', { name: 'Message project agent' })).toBeEnabled();
    expect(providerMenu).toHaveAttribute('title', 'OpenClaw is not verified for this project yet.');
    expect(document.body).not.toHaveTextContent('docker exec');
    expect(document.body).not.toHaveTextContent('/root/.openclaw');
    expect(document.body).not.toHaveTextContent('nonce=secret');

    const close = screen.getByRole('button', { name: 'Close project chat' });
    await waitFor(() => expect(projectMocks.qualifyProjectChatProvider).toHaveBeenCalledTimes(1));
    close.click();
    expect(projectMocks.qualifyProjectChatProvider).toHaveBeenCalledTimes(1);
    expect(projectMocks.qualifyProjectChatProvider).toHaveBeenCalledWith('alpha', 'OPENCLAW');
    expect(onClose).not.toHaveBeenCalled();
    expect(onActivityChange).toHaveBeenCalledTimes(1);
    expect(onActivityChange.mock.calls[0][0]).toMatchObject({
      kind: 'provider-qualification',
      projectName: 'alpha',
      provider: 'OPENCLAW',
    });
    expect(onActivityChange.mock.calls[0][1]).toBe(true);
    // The progress panel owns an active preparation: the "not verified"
    // failure banner (and its Prepare button) must not render beside it.
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Prepare OpenClaw for this project' })).not.toBeInTheDocument();
    });
    expect(screen.queryByText('No Project Chat provider is verified')).not.toBeInTheDocument();
    const progress = screen.getByRole('status', { name: 'OpenClaw preparation progress' });
    expect(progress).toHaveTextContent('Request accepted');
    expect(progress).toHaveTextContent('Preparing sandbox');
    expect(progress).toHaveTextContent('Connecting agent');
    expect(progress.textContent).not.toMatch(/\d+%/);
    expect(screen.getByRole('button', { name: 'Close project chat' })).toBeDisabled();
    expect(projectMocks.projectChatModels).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'Message project agent' })).toBeEnabled();

    await act(async () => {
      qualification.resolve({
        provider: 'OPENCLAW',
        qualification: capabilities().qualifications.OPENCLAW,
        stateVersion: 2,
      });
      await qualification.promise;
    });

    await waitFor(() => expect(projectMocks.projectChatProviders).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(projectMocks.projectChatModels).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(
      screen.getByRole('button', { name: 'Select project chat model' }),
    ).toHaveAttribute('title', 'xai/grok-4.20-beta-latest-reasoning'));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message project agent' })).toBeEnabled());
    expect(screen.queryByRole('status', { name: 'OpenClaw preparation progress' })).not.toBeInTheDocument();
    expect(onActivityChange).toHaveBeenCalledTimes(2);
    expect(onActivityChange.mock.calls[1][0]).toBe(onActivityChange.mock.calls[0][0]);
    expect(onActivityChange.mock.calls[1][1]).toBe(false);
  });

  it('suppresses a failed automatic qualification across remounts while allowing a manual retry', async () => {
    const unqualified = capabilities();
    unqualified.providers = unqualified.providers.map((entry) => (
      entry.provider === 'OPENCLAW'
        ? {
            ...entry,
            selectable: false,
            executionScope: null,
            reason: 'OpenClaw is not verified for this project yet.',
          }
        : entry
    ));
    unqualified.supportedProviders = unqualified.supportedProviders.filter(
      (entry) => entry.provider !== 'OPENCLAW',
    );
    unqualified.qualifications.OPENCLAW = {
      provider: 'OPENCLAW',
      status: 'UNQUALIFIED',
      selectable: false,
      reason: 'OpenClaw is not verified for this project yet.',
      qualifiedAt: null,
      expiresAt: null,
      evidenceFingerprint: null,
    };
    const providerFailure = {
      response: {
        data: {
          code: 'PROJECT_PROVIDER_AUTH_REQUIRED',
          error: 'untrusted-provider-error',
        },
      },
    };
    projectMocks.projectChatProviders.mockResolvedValue(unqualified);
    projectMocks.qualifyProjectChatProvider
      .mockRejectedValueOnce(providerFailure)
      .mockResolvedValue({
        provider: 'OPENCLAW',
        qualification: capabilities().qualifications.OPENCLAW,
        stateVersion: 2,
      });

    const first = render(<ProjectChatPanel projectName="alpha" onClose={vi.fn()} />);
    await waitFor(() => expect(projectMocks.qualifyProjectChatProvider).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(
      'OpenClaw must be reconnected in AI Settings',
    ));
    first.unmount();

    const second = render(<ProjectChatPanel projectName="alpha" onClose={vi.fn()} />);
    const prepare = await screen.findByRole('button', {
      name: 'Prepare OpenClaw for this project',
    });
    expect(projectMocks.qualifyProjectChatProvider).toHaveBeenCalledTimes(1);

    projectMocks.projectChatProviders.mockResolvedValue(capabilities());
    await userEvent.click(prepare);
    await waitFor(() => expect(projectMocks.qualifyProjectChatProvider).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(projectMocks.projectChatProviders).toHaveBeenCalledTimes(3));
    second.unmount();

    projectMocks.projectChatProviders.mockResolvedValue(unqualified);
    render(<ProjectChatPanel projectName="alpha" onClose={vi.fn()} />);
    await waitFor(() => expect(projectMocks.qualifyProjectChatProvider).toHaveBeenCalledTimes(3));
  });

  it('retries an automatic qualification that was interrupted before it could fail', async () => {
    // A first qualification on a new project takes 27-90s server-side. The
    // panel used to claim the 15-minute suppression up front, so reloading or
    // switching away mid-flight left a block behind for an attempt that never
    // returned a verdict: the project came back permanently unqualified, with
    // no automatic retry and no failure to explain it. Only a real failure may
    // suppress.
    const unqualified = capabilities();
    unqualified.providers = unqualified.providers.map((entry) => (
      entry.provider === 'OPENCLAW'
        ? {
            ...entry,
            selectable: false,
            executionScope: null,
            reason: 'OpenClaw is not verified for this project yet.',
          }
        : entry
    ));
    unqualified.supportedProviders = unqualified.supportedProviders.filter(
      (entry) => entry.provider !== 'OPENCLAW',
    );
    unqualified.qualifications.OPENCLAW = {
      provider: 'OPENCLAW',
      status: 'UNQUALIFIED',
      selectable: false,
      reason: 'OpenClaw is not verified for this project yet.',
      qualifiedAt: null,
      expiresAt: null,
      evidenceFingerprint: null,
    };
    const neverSettles = deferred<never>();
    projectMocks.projectChatProviders.mockResolvedValue(unqualified);
    projectMocks.qualifyProjectChatProvider
      .mockReturnValueOnce(neverSettles.promise)
      .mockResolvedValue({
        provider: 'OPENCLAW',
        qualification: capabilities().qualifications.OPENCLAW,
        stateVersion: 2,
      });

    const first = render(<ProjectChatPanel projectName="alpha" onClose={vi.fn()} />);
    await waitFor(() => expect(projectMocks.qualifyProjectChatProvider).toHaveBeenCalledTimes(1));
    // The reload lands while the request is still outstanding.
    first.unmount();

    render(<ProjectChatPanel projectName="alpha" onClose={vi.fn()} />);
    await waitFor(() => expect(projectMocks.qualifyProjectChatProvider).toHaveBeenCalledTimes(2));
  });

  it('stops after one automatic attempt when the host contradicts its own qualification', async () => {
    // A host that answers "qualified" while its capability readback still
    // reports the provider unqualified clears the suppression on every pass.
    // Without a per-mount cap that disagreement spins this panel against the
    // qualification endpoint for as long as the project stays open.
    const projectId = 'project-contradictory-host';
    const unqualified = capabilities();
    unqualified.executionContext = {
      scope: 'PROJECT_SANDBOX',
      projectId,
      policyFingerprint: 'policy-v1',
    };
    unqualified.providers = unqualified.providers.map((entry) => (
      entry.provider === 'OPENCLAW'
        ? {
            ...entry,
            selectable: false,
            executionScope: null,
            reason: 'OpenClaw is not verified for this project yet.',
          }
        : entry
    ));
    unqualified.supportedProviders = unqualified.supportedProviders.filter(
      (entry) => entry.provider !== 'OPENCLAW',
    );
    unqualified.qualifications.OPENCLAW = {
      provider: 'OPENCLAW',
      status: 'UNQUALIFIED',
      selectable: false,
      reason: 'OpenClaw is not verified for this project yet.',
      qualifiedAt: null,
      expiresAt: null,
      evidenceFingerprint: null,
    };
    projectMocks.projectChatProviders.mockResolvedValue(unqualified);
    projectMocks.qualifyProjectChatProvider.mockResolvedValue({
      provider: 'OPENCLAW',
      qualification: capabilities().qualifications.OPENCLAW,
      stateVersion: 2,
    });

    render(<ProjectChatPanel projectName="contradictory-host" onClose={vi.fn()} />);
    await waitFor(() => expect(projectMocks.qualifyProjectChatProvider).toHaveBeenCalledTimes(1));
    const refreshesAfterFirstAttempt = projectMocks.projectChatProviders.mock.calls.length;

    // Let every queued capability refresh settle. Each one re-presents the
    // provider as unqualified, which is exactly what used to re-arm the effect.
    for (let pass = 0; pass < 10; pass += 1) {
      await act(async () => { await Promise.resolve(); });
    }

    expect(projectMocks.qualifyProjectChatProvider).toHaveBeenCalledTimes(1);
    expect(projectMocks.projectChatProviders.mock.calls.length)
      .toBeLessThanOrEqual(refreshesAfterFirstAttempt + 1);
    expect(await screen.findByRole('button', {
      name: 'Prepare OpenClaw for this project',
    })).toBeEnabled();
  });

  it.each(['read', 'write'] as const)(
    'keeps the in-memory qualification guard when sessionStorage %s fails',
    async (failureMode) => {
      const projectId = `project-storage-${failureMode}`;
      const projectName = `storage-${failureMode}`;
      const unqualified = capabilities();
      unqualified.executionContext = {
        scope: 'PROJECT_SANDBOX',
        projectId,
        policyFingerprint: 'policy-v1',
      };
      unqualified.providers = unqualified.providers.map((entry) => (
        entry.provider === 'OPENCLAW'
          ? {
              ...entry,
              selectable: false,
              executionScope: null,
              reason: 'OpenClaw is not verified for this project yet.',
            }
          : entry
      ));
      unqualified.supportedProviders = unqualified.supportedProviders.filter(
        (entry) => entry.provider !== 'OPENCLAW',
      );
      unqualified.qualifications.OPENCLAW = {
        provider: 'OPENCLAW',
        status: 'UNQUALIFIED',
        selectable: false,
        reason: 'OpenClaw is not verified for this project yet.',
        qualifiedAt: null,
        expiresAt: null,
        evidenceFingerprint: null,
      };
      projectMocks.projectChatProviders.mockResolvedValue(unqualified);
      projectMocks.qualifyProjectChatProvider.mockRejectedValue({
        response: {
          data: {
            code: 'PROJECT_PROVIDER_AUTH_REQUIRED',
            error: 'OpenClaw sign-in is required on this server.',
          },
        },
      });

      const originalSessionStorage = Object.getOwnPropertyDescriptor(window, 'sessionStorage');
      const blockedStorage: Storage = {
        get length() { return 0; },
        clear: vi.fn(),
        getItem: vi.fn(() => {
          if (failureMode === 'read') throw new DOMException('Blocked', 'SecurityError');
          return null;
        }),
        key: vi.fn(() => null),
        removeItem: vi.fn(),
        setItem: vi.fn(() => {
          if (failureMode === 'write') throw new DOMException('Quota exceeded', 'QuotaExceededError');
        }),
      };
      Object.defineProperty(window, 'sessionStorage', {
        configurable: true,
        value: blockedStorage,
      });

      try {
        const first = render(
          <ProjectChatPanel projectName={projectName} onClose={vi.fn()} />,
        );
        await waitFor(() => expect(projectMocks.qualifyProjectChatProvider).toHaveBeenCalledTimes(1));
        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(
          'OpenClaw must be reconnected in AI Settings',
        ));
        first.unmount();

        const second = render(
          <ProjectChatPanel projectName={projectName} onClose={vi.fn()} />,
        );
        await screen.findByRole('button', {
          name: 'Prepare OpenClaw for this project',
        });
        await waitFor(() => expect(projectMocks.projectChatProviders).toHaveBeenCalledTimes(2));
        expect(projectMocks.qualifyProjectChatProvider).toHaveBeenCalledTimes(1);
        second.unmount();
      } finally {
        if (originalSessionStorage) {
          Object.defineProperty(window, 'sessionStorage', originalSessionStorage);
        }
      }
    },
  );

  it('persists host-maintenance recovery across remounts with role-correct actions', async () => {
    const unqualified = capabilities();
    unqualified.executionContext = {
      scope: 'PROJECT_SANDBOX',
      projectId: 'project-host-maintenance',
      policyFingerprint: 'policy-v1',
    };
    unqualified.providers = unqualified.providers.map((entry) => (
      entry.provider === 'OPENCLAW'
        ? {
            ...entry,
            selectable: false,
            executionScope: null,
            reason: 'OpenClaw is not verified for this project yet.',
          }
        : entry
    ));
    unqualified.supportedProviders = unqualified.supportedProviders.filter(
      (entry) => entry.provider !== 'OPENCLAW',
    );
    unqualified.qualifications.OPENCLAW = {
      provider: 'OPENCLAW',
      status: 'UNQUALIFIED',
      selectable: false,
      reason: 'OpenClaw is not verified for this project yet.',
      qualifiedAt: null,
      expiresAt: null,
      evidenceFingerprint: null,
    };
    projectMocks.projectChatProviders.mockResolvedValue(unqualified);
    projectMocks.qualifyProjectChatProvider.mockRejectedValue({
      response: {
        data: {
          code: 'PROJECT_RUNTIME_POLICY_FAILED',
          error: 'docker inspect secret-host-runtime --format={{json .Config}}',
          retryable: false,
          recovery: 'HOST_MAINTENANCE',
          recoveryUrl: 'https://attacker.invalid/repair',
        },
      },
    });

    const ownerView = render(
      <ProjectChatPanel projectName="host-maintenance" onClose={vi.fn()} />,
    );

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(
      'The provider’s confined project runtime did not pass its server security checks.',
    ));
    expect(screen.queryByRole('button', {
      name: 'Prepare OpenClaw for this project',
    })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', {
      name: 'Recheck OpenClaw after host repair',
    })).toBeEnabled();
    expect(screen.getByRole('link', { name: 'Open Dashboard for signed update' })).toHaveAttribute(
      'href',
      '/dashboard',
    );
    expect(document.body).not.toHaveTextContent('attacker.invalid');
    expect(document.body).not.toHaveTextContent('secret-host-runtime');
    expect(
      Array.from({ length: window.sessionStorage.length }, (_, index) => {
        const key = window.sessionStorage.key(index);
        return key ? window.sessionStorage.getItem(key) : '';
      }).join('\n'),
    ).not.toContain('secret-host-runtime');
    expect(projectMocks.qualifyProjectChatProvider).toHaveBeenCalledTimes(1);

    ownerView.unmount();
    authMocks.user.role = 'SUB_ADMIN';
    const subAdminView = render(
      <ProjectChatPanel projectName="host-maintenance" onClose={vi.fn()} />,
    );
    expect(await screen.findByRole('link', {
      name: 'Open Agent Chat to repair host',
    })).toHaveAttribute('href', '/agent-chats');
    expect(screen.queryByRole('button', {
      name: 'Prepare OpenClaw for this project',
    })).not.toBeInTheDocument();
    expect(screen.getByRole('button', {
      name: 'Recheck OpenClaw after host repair',
    })).toBeEnabled();
    expect(projectMocks.qualifyProjectChatProvider).toHaveBeenCalledTimes(1);

    subAdminView.unmount();
    authMocks.user.role = 'USER';
    render(<ProjectChatPanel projectName="host-maintenance" onClose={vi.fn()} />);
    expect(await screen.findByText('Contact an Owner or Sub Admin')).toBeVisible();
    expect(screen.queryByRole('link', {
      name: 'Open Dashboard for signed update',
    })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', {
      name: 'Open Agent Chat to repair host',
    })).not.toBeInTheDocument();
    expect(screen.getByRole('button', {
      name: 'Recheck OpenClaw after host repair',
    })).toBeEnabled();
    expect(projectMocks.qualifyProjectChatProvider).toHaveBeenCalledTimes(1);
  });

  it('allows one explicit recheck after host repair and clears the persisted disposition on success', async () => {
    const user = userEvent.setup();
    const unqualified = unqualifiedOpenClawCapabilities('project-explicit-host-recheck');
    projectMocks.projectChatProviders
      .mockResolvedValueOnce(unqualified)
      .mockResolvedValue(capabilities());
    projectMocks.qualifyProjectChatProvider
      .mockRejectedValueOnce({
        response: {
          data: {
            code: 'PROJECT_RUNTIME_POLICY_FAILED',
            retryable: false,
            recovery: 'HOST_MAINTENANCE',
          },
        },
      })
      .mockResolvedValueOnce({
        provider: 'OPENCLAW',
        qualification: capabilities().qualifications.OPENCLAW,
        stateVersion: 2,
      });

    const firstView = render(
      <ProjectChatPanel projectName="explicit-host-recheck" onClose={vi.fn()} />,
    );
    const recheck = await screen.findByRole('button', {
      name: 'Recheck OpenClaw after host repair',
    });
    await user.click(recheck);
    await waitFor(() => expect(projectMocks.qualifyProjectChatProvider).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(projectMocks.projectChatProviders).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('button', {
      name: 'Recheck OpenClaw after host repair',
    })).not.toBeInTheDocument();
    firstView.unmount();

    render(<ProjectChatPanel projectName="explicit-host-recheck" onClose={vi.fn()} />);
    await waitFor(() => expect(projectMocks.projectChatProviders).toHaveBeenCalledTimes(3));
    expect(projectMocks.qualifyProjectChatProvider).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/host must be updated or repaired/)).not.toBeInTheDocument();
  });

  it('expires a persisted host disposition and performs only one normal automatic recheck', async () => {
    const now = Date.parse('2026-07-27T22:00:00.000Z');
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(now);
    const projectId = 'project-expiring-host-disposition';
    const projectName = 'expiring-host-disposition';
    const suppressionKey = JSON.stringify(['user-1', projectId, 'OPENCLAW']);
    window.sessionStorage.setItem(
      'portal:project-chat:auto-qualification-suppression:v1',
      JSON.stringify([{
        key: suppressionKey,
        expiresAt: now + 60_000,
        disposition: 'HOST_MAINTENANCE',
        retryAt: null,
      }]),
    );
    projectMocks.projectChatProviders
      .mockResolvedValueOnce(unqualifiedOpenClawCapabilities(projectId))
      .mockResolvedValue(capabilities());
    projectMocks.qualifyProjectChatProvider.mockResolvedValueOnce({
      provider: 'OPENCLAW',
      qualification: capabilities().qualifications.OPENCLAW,
      stateVersion: 2,
    });

    render(<ProjectChatPanel projectName={projectName} onClose={vi.fn()} />);
    await vi.waitFor(() => {
      expect(screen.getByRole('button', {
        name: 'Recheck OpenClaw after host repair',
      })).toBeEnabled();
    });
    expect(projectMocks.qualifyProjectChatProvider).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_100);
    });
    await vi.waitFor(() => {
      expect(projectMocks.qualifyProjectChatProvider).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByRole('button', {
      name: 'Recheck OpenClaw after host repair',
    })).not.toBeInTheDocument();
    expect(window.sessionStorage.getItem(
      'portal:project-chat:auto-qualification-suppression:v1',
    )).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(projectMocks.qualifyProjectChatProvider).toHaveBeenCalledTimes(1);
  });

  it('disables qualification actions until a validated 429 retry time', async () => {
    const retryAt = new Date(Date.now() + 15 * 60_000).toISOString();
    const unqualified = capabilities();
    unqualified.executionContext = {
      scope: 'PROJECT_SANDBOX',
      projectId: 'project-rate-limited',
      policyFingerprint: 'policy-v1',
    };
    unqualified.providers = unqualified.providers.map((entry) => (
      entry.provider === 'OPENCLAW'
        ? {
            ...entry,
            selectable: false,
            executionScope: null,
            reason: 'OpenClaw is not verified for this project yet.',
          }
        : entry
    ));
    unqualified.supportedProviders = unqualified.supportedProviders.filter(
      (entry) => entry.provider !== 'OPENCLAW',
    );
    unqualified.qualifications.OPENCLAW = {
      provider: 'OPENCLAW',
      status: 'UNQUALIFIED',
      selectable: false,
      reason: 'OpenClaw is not verified for this project yet.',
      qualifiedAt: null,
      expiresAt: null,
      evidenceFingerprint: null,
    };
    projectMocks.projectChatProviders.mockResolvedValue(unqualified);
    projectMocks.qualifyProjectChatProvider.mockRejectedValue({
      response: {
        data: {
          code: 'PROJECT_QUALIFICATION_RATE_LIMITED',
          error: 'Too many preparation attempts. Wait for the current window to reset.',
          retryable: true,
          retryAt,
        },
      },
    });

    const firstView = render(
      <ProjectChatPanel projectName="rate-limited" onClose={vi.fn()} />,
    );

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(
      'Too many Project provider preparation attempts.',
    ));
    const retryTime = screen.getByText(/Try again after/).querySelector('time');
    expect(retryTime).toHaveAttribute('datetime', retryAt);
    expect(screen.queryByRole('button', {
      name: 'Prepare OpenClaw for this project',
    })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(projectMocks.qualifyProjectChatProvider).toHaveBeenCalledTimes(1);
    firstView.unmount();

    render(<ProjectChatPanel projectName="rate-limited" onClose={vi.fn()} />);
    const restoredRetryTime = (await screen.findByText(/Try again after/)).querySelector('time');
    expect(restoredRetryTime).toHaveAttribute('datetime', retryAt);
    expect(screen.queryByRole('button', {
      name: 'Prepare OpenClaw for this project',
    })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(projectMocks.qualifyProjectChatProvider).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['malformed', 'not-a-date'],
    ['missing', undefined],
  ] as const)('uses a finite 15-minute fallback for a %s 429 retry time', async (
    retryTimeCase,
    retryAt,
  ) => {
    const projectName = `${retryTimeCase}-retry-time`;
    const unqualified = capabilities();
    unqualified.executionContext = {
      scope: 'PROJECT_SANDBOX',
      projectId: `project-${projectName}`,
      policyFingerprint: 'policy-v1',
    };
    unqualified.providers = unqualified.providers.map((entry) => (
      entry.provider === 'OPENCLAW'
        ? {
            ...entry,
            selectable: false,
            executionScope: null,
            reason: 'OpenClaw is not verified for this project yet.',
          }
        : entry
    ));
    unqualified.supportedProviders = unqualified.supportedProviders.filter(
      (entry) => entry.provider !== 'OPENCLAW',
    );
    unqualified.qualifications.OPENCLAW = {
      provider: 'OPENCLAW',
      status: 'UNQUALIFIED',
      selectable: false,
      reason: 'OpenClaw is not verified for this project yet.',
      qualifiedAt: null,
      expiresAt: null,
      evidenceFingerprint: null,
    };
    projectMocks.projectChatProviders.mockResolvedValue(unqualified);
    projectMocks.qualifyProjectChatProvider.mockRejectedValue({
      response: {
        data: {
          code: 'PROJECT_QUALIFICATION_RATE_LIMITED',
          error: 'Too many preparation attempts.',
          retryable: true,
          ...(retryAt ? { retryAt } : {}),
        },
      },
    });

    const beforeAttempt = Date.now();
    const firstView = render(
      <ProjectChatPanel projectName={projectName} onClose={vi.fn()} />,
    );

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(
      'Too many Project provider preparation attempts.',
    ));
    expect(screen.queryByRole('button', {
      name: 'Prepare OpenClaw for this project',
    })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    const fallbackRetryTime = screen.getByText(/Try again after/).querySelector('time');
    const fallbackTimestamp = Date.parse(
      fallbackRetryTime?.getAttribute('datetime') || '',
    );
    expect(fallbackTimestamp).toBeGreaterThanOrEqual(beforeAttempt + 14 * 60_000);
    expect(fallbackTimestamp).toBeLessThanOrEqual(Date.now() + 16 * 60_000);
    firstView.unmount();

    render(
      <ProjectChatPanel projectName={projectName} onClose={vi.fn()} />,
    );
    expect(await screen.findByText(/Try again after/)).toBeVisible();
    expect(projectMocks.qualifyProjectChatProvider).toHaveBeenCalledTimes(1);
  });

  it.each([
    [true, true],
    [false, false],
  ] as const)(
    'preserves retryable=%s for locally presented identity-admission failures',
    async (retryable, expectPrepareAction) => {
      const projectName = retryable
        ? 'identity-temporarily-unavailable'
        : 'identity-policy-unavailable';
      const unqualified = unqualifiedOpenClawCapabilities(`project-${projectName}`);
      projectMocks.projectChatProviders.mockResolvedValue(unqualified);
      projectMocks.qualifyProjectChatProvider.mockRejectedValue({
        response: {
          data: {
            code: 'PROJECT_QUALIFICATION_IDENTITY_UNAVAILABLE',
            error: 'immutable-path=/secret/project; databaseUrl=postgres://secret',
            retryable,
          },
        },
      });

      const firstView = render(
        <ProjectChatPanel projectName={projectName} onClose={vi.fn()} />,
      );
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(
        'Portal could not safely verify this project’s immutable identity',
      ));
      expect(document.body).not.toHaveTextContent('/secret/project');
      expect(document.body).not.toHaveTextContent('postgres://secret');
      if (expectPrepareAction) {
        expect(screen.getByRole('button', {
          name: 'Prepare OpenClaw for this project',
        })).toBeEnabled();
      } else {
        expect(screen.queryByRole('button', {
          name: 'Prepare OpenClaw for this project',
        })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
      }
      expect(projectMocks.qualifyProjectChatProvider).toHaveBeenCalledTimes(1);

      firstView.unmount();
      render(<ProjectChatPanel projectName={projectName} onClose={vi.fn()} />);
      await waitFor(() => expect(projectMocks.projectChatProviders).toHaveBeenCalledTimes(2));
      expect(projectMocks.qualifyProjectChatProvider).toHaveBeenCalledTimes(1);
      if (!retryable) {
        expect(await screen.findByText(
          /could not safely verify this project’s immutable identity/,
        )).toBeVisible();
        expect(screen.queryByRole('button', {
          name: 'Prepare OpenClaw for this project',
        })).not.toBeInTheDocument();
      }
    },
  );

  it('honors an explicit non-retryable contract for an unknown code without rendering its payload', async () => {
    const projectName = 'unknown-nonretryable';
    projectMocks.projectChatProviders.mockResolvedValue(
      unqualifiedOpenClawCapabilities(`project-${projectName}`),
    );
    projectMocks.qualifyProjectChatProvider.mockRejectedValue({
      response: {
        data: {
          code: 'UNRECOGNIZED_INTERNAL_FAILURE',
          error: 'bearer super-secret-internal-token',
          retryable: false,
        },
      },
    });

    const firstView = render(
      <ProjectChatPanel projectName={projectName} onClose={vi.fn()} />,
    );
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(
      'Portal could not prepare OpenClaw for this project.',
    ));
    expect(document.body).not.toHaveTextContent('super-secret-internal-token');
    expect(screen.queryByRole('button', {
      name: 'Prepare OpenClaw for this project',
    })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    firstView.unmount();

    render(<ProjectChatPanel projectName={projectName} onClose={vi.fn()} />);
    await waitFor(() => expect(projectMocks.projectChatProviders).toHaveBeenCalledTimes(2));
    expect(projectMocks.qualifyProjectChatProvider).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/Owner or Sub Admin must review/)).toBeVisible();
  });

  it('maps a recognized qualification code to bounded local copy', async () => {
    const qualification = deferred<never>();
    const unqualified = capabilities();
    unqualified.providers = unqualified.providers.map((entry) => (
      entry.provider === 'OPENCLAW'
        ? { ...entry, selectable: false, executionScope: null, reason: 'Internal runtime detail' }
        : entry
    ));
    unqualified.supportedProviders = unqualified.supportedProviders.filter(
      (entry) => entry.provider !== 'OPENCLAW',
    );
    unqualified.qualifications.OPENCLAW = {
      provider: 'OPENCLAW',
      status: 'UNQUALIFIED',
      selectable: false,
      reason: 'Internal runtime detail',
      qualifiedAt: null,
      expiresAt: null,
      evidenceFingerprint: null,
    };
    projectMocks.projectChatProviders.mockResolvedValue(unqualified);
    projectMocks.qualifyProjectChatProvider.mockReturnValueOnce(qualification.promise);
    const qualificationFailure = {
      response: {
        data: {
          code: 'PROJECT_PROVIDER_AUTH_REQUIRED',
          error: 'refresh_token=must-not-render-from-error',
          detail: 'refresh_token=must-not-render',
        },
      },
    };

    render(<ProjectChatPanel projectName="alpha" onClose={vi.fn()} />);

    await waitFor(() => expect(projectMocks.qualifyProjectChatProvider).toHaveBeenCalledWith(
      'alpha',
      'OPENCLAW',
    ));
    expect(document.body).not.toHaveTextContent('Internal runtime detail');
    await act(async () => {
      qualification.reject(qualificationFailure);
      await qualification.promise.catch(() => undefined);
    });

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(
      'OpenClaw must be reconnected in AI Settings',
    ));
    expect(document.body).not.toHaveTextContent('refresh_token');
    expect(document.body).not.toHaveTextContent('must-not-render');
    expect(document.body).not.toHaveTextContent('must-not-render-from-error');
    expect(document.body).not.toHaveTextContent('Internal runtime detail');
  });

  it('requires an explicit connected OAuth model before Agent Zero qualification', async () => {
    projectMocks.projectChatProviders.mockResolvedValue(capabilities());
    projectMocks.qualifyProjectChatProvider.mockResolvedValueOnce({
      provider: 'AGENT_ZERO',
      qualification: {
        ...capabilities().qualifications.AGENT_ZERO,
        status: 'QUALIFIED',
        selectable: true,
        reason: 'Current live qualification is valid.',
        qualifiedAt: '2026-07-19T08:00:00.000Z',
        expiresAt: '2026-07-19T20:00:00.000Z',
        evidenceFingerprint: 'c'.repeat(64),
      },
      stateVersion: 2,
    });

    const user = userEvent.setup();
    render(<ProjectChatPanel projectName="alpha" onClose={vi.fn()} />);

    const providerMenu = await screen.findByRole('button', { name: 'Project chat provider' });
    await user.click(providerMenu);
    await user.click(screen.getByRole('menuitem', { name: 'Review Agent Zero' }));
    const modelPicker = await screen.findByRole('combobox', { name: 'Agent Zero qualification model' });
    const qualify = screen.getByRole('button', { name: 'Qualify Agent Zero for this project' });
    expect(modelPicker).toHaveValue('');
    expect(qualify).toBeDisabled();

    await user.selectOptions(modelPicker, 'codex_oauth/gpt-5.5');
    await waitFor(() => expect(qualify).toBeEnabled());
    await user.click(qualify);

    await waitFor(() => expect(projectMocks.qualifyProjectChatProvider).toHaveBeenCalledWith(
      'alpha',
      'AGENT_ZERO',
      'codex_oauth/gpt-5.5',
    ));
  });

  it('bounds a resumed long turn, blocks provider switching, and exposes replay recovery', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const history = Array.from({ length: 61 }, (_, index) => ({
      id: `message-${index + 1}`,
      role: 'user',
      content: `historical message ${index + 1}`,
      timestamp: new Date(Date.UTC(2026, 6, 19, 8, 0, index)).toISOString(),
      provider: 'OPENCLAW',
      runtime: 'openclaw-dedicated-project-agent',
    }));
    const activeTurn = {
      id: 'turn-1',
      provider: 'OPENCLAW' as const,
      status: 'running',
      requestId: 'request-1',
      leaseExpiresAt: '2026-07-19T09:00:00.000Z',
    };
    projectMocks.projectChatProviders.mockResolvedValue(capabilities(activeTurn));
    projectMocks.chatHistory.mockResolvedValue({ messages: history });
    projectMocks.agentPoll
      .mockResolvedValueOnce(replaySnapshot({ active: true, isProcessing: true, runId: 'turn-1' }))
      .mockRejectedValueOnce(new Error('temporary replay outage'));

    const user = userEvent.setup();
    render(<ProjectChatPanel projectName="alpha" onClose={vi.fn()} />);

    expect(await screen.findByText('Portal replay connection interrupted — retrying…')).toBeVisible();
    expect(warn).toHaveBeenCalledWith(
      '[ProjectChat] Project replay poll failed:',
      expect.objectContaining({ message: 'temporary replay outage' }),
    );
    const providerSelect = screen.getByRole('button', { name: 'Project chat provider' });
    expect(providerSelect).toBeDisabled();
    // Provider switching stays blocked for the whole turn, but the composer
    // stays open so the running turn can be steered on its exact run.
    const composer = screen.getByRole('textbox', { name: 'Message project agent' });
    expect(composer).toBeEnabled();
    expect(composer).toHaveAttribute('placeholder', 'Guide this active turn…');
    expect(screen.getByRole('button', { name: 'Stop project agent response' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Retry now' })).toBeVisible();
    expect(projectMocks.clientGet).toHaveBeenCalledWith(
      '/projects/alpha/assistant/resume-session',
      { params: { provider: 'OPENCLAW', turnId: 'turn-1' } },
    );
    expect(projectMocks.clientPost.mock.calls.filter(([url]) => String(url).endsWith('/assistant/ensure-session'))).toHaveLength(0);

    expect(screen.queryByText('historical message 1')).not.toBeInTheDocument();
    expect(screen.getByText('historical message 61')).toBeVisible();
    const reveal = screen.getByRole('button', { name: /Show earlier messages · \d+ loaded/i });
    await user.click(reveal);
    expect(screen.getByText('historical message 1')).toBeVisible();
  });

  it('loads the next Project Chat history page on demand and exposes the older rows', async () => {
    const newest = Array.from({ length: 60 }, (_, index) => ({
      id: `new-${index + 1}`,
      role: 'user',
      content: `new page message ${index + 1}`,
      timestamp: new Date(Date.UTC(2026, 6, 20, 1, 0, index)).toISOString(),
      provider: 'OPENCLAW',
      runtime: 'openclaw-dedicated-project-agent',
    }));
    const staged = await runCoordinatedProjectChatSend({
      scope: { actorUserId: 'user-1', projectId: 'project-alpha', provider: 'OPENCLAW' },
      draftText: 'old pending user message',
      payloadText: 'old pending user message',
      model: 'openai/gpt-5.5',
      dispatch: async () => { throw new Error('response lost'); },
      classifyError: () => 'ambiguous',
    }).catch(() => null);
    const pendingId = localStorage.getItem(
      projectChatPendingSendStorageKey('user-1', 'project-alpha', 'OPENCLAW'),
    ) ? JSON.parse(localStorage.getItem(
      projectChatPendingSendStorageKey('user-1', 'project-alpha', 'OPENCLAW'),
    ) || '{}').messageId : staged?.staged.messageId;
    const older = [{
      id: 'old-1',
      role: 'assistant',
      content: 'old page message 1',
      timestamp: new Date(Date.UTC(2026, 6, 19, 23, 59, 0)).toISOString(),
      provider: 'OPENCLAW',
      runtime: 'openclaw-dedicated-project-agent',
    }, {
      id: 'old-pending',
      role: 'user',
      content: 'old pending user message',
      messageId: pendingId,
      timestamp: new Date(Date.UTC(2026, 6, 19, 23, 58, 0)).toISOString(),
      provider: 'OPENCLAW',
      runtime: 'openclaw-dedicated-project-agent',
    }];
    projectMocks.projectChatProviders.mockResolvedValue(capabilities());
    projectMocks.chatHistory.mockImplementation(async (
      _name: string,
      _provider: string,
      page?: { before?: string },
    ) => page?.before
      ? {
          messages: older,
          pagination: { hasMore: false, nextCursor: null, limit: 100 },
        }
      : {
          messages: newest,
          pagination: { hasMore: true, nextCursor: 'new-1', limit: 100 },
        });

    const user = userEvent.setup();
    render(<ProjectChatPanel projectName="alpha" onClose={vi.fn()} />);

    expect(await screen.findByText('new page message 60')).toBeVisible();
    const loadEarlier = screen.getByRole('button', { name: 'Load earlier messages' });
    await user.click(loadEarlier);

    expect(await screen.findByText('old page message 1')).toBeVisible();
    expect(projectMocks.chatHistory).toHaveBeenCalledWith(
      'alpha',
      'OPENCLAW',
      { limit: 100, before: 'new-1' },
    );
    expect(screen.queryByRole('button', { name: 'Load earlier messages' })).not.toBeInTheDocument();
    await waitFor(() => expect(localStorage.getItem(
      projectChatPendingSendStorageKey('user-1', 'project-alpha', 'OPENCLAW'),
    )).toBeNull());
  });

  it('waits for another tab runtime admission instead of starting a competing admission', async () => {
    const transitioning = capabilities();
    transitioning.coordination.runtimeTransitionActive = true;
    projectMocks.projectChatProviders
      .mockResolvedValueOnce(transitioning)
      .mockResolvedValueOnce(capabilities());

    render(<ProjectChatPanel projectName="alpha" onClose={vi.fn()} />);

    expect(await screen.findByText(/Another tab is preparing the project runtime/i)).toBeVisible();
    const composer = screen.getByRole('textbox', { name: 'Message project agent' });
    expect(composer).toBeEnabled();
    expect(projectMocks.clientPost.mock.calls.filter(
      ([url]) => String(url).endsWith('/assistant/ensure-session'),
    )).toHaveLength(0);
    await waitFor(() => expect(projectMocks.projectChatProviders).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(composer).toBeEnabled());
    expect(projectMocks.clientPost.mock.calls.filter(
      ([url]) => String(url).endsWith('/assistant/ensure-session'),
    )).toHaveLength(1);
  });

  it('owns a provider transition through failure and blocks duplicate submission or panel dismissal', async () => {
    projectMocks.projectChatProviders.mockResolvedValue(capabilities());
    const providerSwitch = deferred<{
      provider: 'OPENCLAW';
      stateVersion: number;
      model: string;
    }>();
    projectMocks.selectProjectChatProvider.mockReturnValueOnce(providerSwitch.promise);
    const onClose = vi.fn();
    const onActivityChange = vi.fn<(
      activity: Readonly<ProjectChatActivity>,
      active: boolean,
    ) => boolean>(() => true);

    const user = userEvent.setup();
    render(
      <ProjectChatPanel
        projectName="alpha"
        onClose={onClose}
        onActivityChange={onActivityChange}
      />,
    );

    await waitFor(() => expect(screen.getByRole('button', { name: 'Project chat provider' })).toBeEnabled());
    const providerSelect = screen.getByRole('button', { name: 'Project chat provider' });
    await user.click(providerSelect);
    await user.click(screen.getByRole('menuitem', { name: 'Use Codex' }));

    // First-time switches to an unbound provider pause on an explicit
    // confirmation that a fresh agent will start.
    expect(await screen.findByText(/starts a fresh Codex agent/i)).toBeVisible();
    const confirmSwitch = screen.getByRole('button', { name: 'Switch provider' });
    const closeProjectChat = screen.getByRole('button', { name: 'Close project chat' });
    act(() => {
      confirmSwitch.click();
      confirmSwitch.click();
      closeProjectChat.click();
    });

    expect(projectMocks.selectProjectChatProvider).toHaveBeenCalledTimes(1);
    expect(projectMocks.selectProjectChatProvider).toHaveBeenCalledWith('alpha', 'CODEX', 1, '');
    expect(onClose).not.toHaveBeenCalled();
    expect(onActivityChange).toHaveBeenCalledTimes(1);
    const activity = onActivityChange.mock.calls[0][0];
    expect(activity).toEqual(expect.objectContaining({
      kind: 'provider-transition',
      projectName: 'alpha',
      provider: 'CODEX',
      previousProvider: 'OPENCLAW',
      sessionKey: 'project-session-1',
      previousModel: 'openai/gpt-5.5',
      requestedModel: '',
      stateVersion: 1,
    }));
    expect(onActivityChange.mock.calls[0][1]).toBe(true);
    expect(screen.getByRole('button', { name: 'Close project chat' })).toBeDisabled();

    await act(async () => {
      providerSwitch.resolve({
        provider: 'OPENCLAW',
        stateVersion: 2,
        model: 'openai/gpt-5.5',
      });
      await providerSwitch.promise;
    });

    expect(await screen.findByText('No Project Chat provider is verified')).toBeVisible();
    // once the transition has settled, the picker must come back so a
    // different provider can be chosen. Leaving it disabled here was the wedge
    // that only a full page reload could clear.
    expect(providerSelect).toBeEnabled();
    expect(screen.getByRole('textbox', { name: 'Message project agent' })).toBeEnabled();
    await waitFor(() => expect(onActivityChange).toHaveBeenCalledWith(activity, false));
    await user.click(screen.getByRole('button', { name: 'Close project chat' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('owns a model switch through canonical readback and rejects same-frame close or duplicate changes', async () => {
    projectMocks.projectChatProviders.mockResolvedValue(capabilities());
    projectMocks.projectChatModels.mockResolvedValue({
      provider: 'OPENCLAW',
      models: [
        { id: 'openai/gpt-5.5', displayName: 'GPT-5.5' },
        { id: 'openai/gpt-5.4', displayName: 'GPT-5.4' },
      ],
    });
    const modelSwitch = deferred<any>();
    projectMocks.clientPost.mockImplementation(async (url: string, body?: Record<string, unknown>) => {
      if (!url.endsWith('/assistant/ensure-session')) throw new Error(`Unexpected POST ${url}`);
      if (body?.model === 'openai/gpt-5.4') return modelSwitch.promise;
      return {
        data: {
          provider: 'OPENCLAW',
          stateVersion: 1,
          sessionKey: 'project-session-1',
          agentId: 'project-agent-1',
          runtime: 'openclaw-dedicated-project-agent',
          model: 'openai/gpt-5.5',
          modelValidated: true,
          modelVerified: true,
        },
      };
    });
    const onClose = vi.fn();
    const onActivityChange = vi.fn<(
      activity: Readonly<ProjectChatActivity>,
      active: boolean,
    ) => boolean>(() => true);
    const user = userEvent.setup();
    render(
      <ProjectChatPanel
        projectName="alpha"
        onClose={onClose}
        onActivityChange={onActivityChange}
      />,
    );

    const modelTrigger = await screen.findByRole(
      'button',
      { name: 'Select project chat model' },
      { timeout: 2500 },
    );
    await waitFor(() => expect(modelTrigger).toBeEnabled());
    await user.click(modelTrigger);
    const nextModel = screen.getByRole('button', { name: 'Select model openai/gpt-5.4' });
    const closeProjectChat = screen.getByRole('button', { name: 'Close project chat' });
    act(() => {
      nextModel.click();
      nextModel.click();
      closeProjectChat.click();
    });

    expect(projectMocks.clientPost.mock.calls.filter(([, body]) => body?.model === 'openai/gpt-5.4')).toHaveLength(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(onActivityChange).toHaveBeenCalledTimes(1);
    const activity = onActivityChange.mock.calls[0][0];
    expect(activity).toEqual(expect.objectContaining({
      kind: 'model-switch',
      projectName: 'alpha',
      provider: 'OPENCLAW',
      sessionKey: 'project-session-1',
      previousModel: 'openai/gpt-5.5',
      requestedModel: 'openai/gpt-5.4',
      stateVersion: 1,
    }));
    expect(onActivityChange.mock.calls[0][1]).toBe(true);
    expect(screen.getByRole('button', { name: 'Close project chat' })).toBeDisabled();

    await act(async () => {
      modelSwitch.resolve({
        data: {
          provider: 'OPENCLAW',
          stateVersion: 2,
          sessionKey: 'project-session-1',
          agentId: 'project-agent-1',
          runtime: 'openclaw-dedicated-project-agent',
          model: 'openai/gpt-5.4',
          modelValidated: true,
          modelVerified: true,
        },
      });
      await modelSwitch.promise;
    });

    await waitFor(() => expect(onActivityChange).toHaveBeenCalledWith(activity, false));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close project chat' })).toBeEnabled());
    expect(screen.getByRole('button', { name: 'Select project chat model' })).toHaveTextContent('GPT 5.4');
    await user.click(screen.getByRole('button', { name: 'Close project chat' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps the verified session connected across consecutive tool-using turns', async () => {
    projectMocks.projectChatProviders.mockResolvedValue(capabilities());
    let sendCount = 0;
    let currentStateVersion = 1;
    projectMocks.chatHistory.mockImplementation(async () => ({
      messages: sendCount === 0
        ? []
        : [{
            id: `assistant-turn-${sendCount}`,
            role: 'assistant',
            content: `Finished turn ${sendCount}`,
            timestamp: new Date(1_000 + sendCount).toISOString(),
            provider: 'OPENCLAW',
            runtime: 'openclaw-dedicated-project-agent',
            model: 'openai/gpt-5.5',
            modelValidated: true,
            modelVerified: true,
            turnId: `turn-${sendCount}`,
            thinkingContent: `Planning turn ${sendCount}`,
            toolCalls: [{
              id: `tool-${sendCount}`,
              name: 'exec',
              arguments: { command: 'pwd' },
              result: '/workspace/project',
              startedAt: 2_000 + sendCount,
              endedAt: 3_000 + sendCount,
              status: 'done',
            }],
          }],
    }));
    projectMocks.clientPost.mockImplementation(async (url: string) => {
      if (url.endsWith('/assistant/ensure-session')) {
        return {
          data: {
            provider: 'OPENCLAW',
            stateVersion: currentStateVersion,
            sessionKey: 'project-session-1',
            agentId: 'project-agent-1',
            runtime: 'openclaw-dedicated-project-agent',
            model: 'openai/gpt-5.5',
            modelValidated: true,
            modelVerified: true,
          },
        };
      }
      if (url.endsWith('/assistant/send')) {
        sendCount += 1;
        currentStateVersion += 1;
        return {
          data: {
            provider: 'OPENCLAW',
            stateVersion: currentStateVersion,
            sessionKey: 'project-session-1',
            turnId: `turn-${sendCount}`,
            // Native provider ids and durable turn ids are intentionally distinct.
            runId: `native-run-${sendCount}`,
            executionContext: { scope: 'PROJECT_SANDBOX', projectId: 'project-alpha' },
            runtime: 'openclaw-dedicated-project-agent',
            model: 'openai/gpt-5.5',
            modelValidated: true,
            modelVerified: true,
          },
        };
      }
      throw new Error(`Unexpected POST ${url}`);
    });
    projectMocks.agentPoll.mockImplementation(async () => {
      if (sendCount === 0) return replaySnapshot({ stateVersion: currentStateVersion });
      return replaySnapshot({
        stateVersion: currentStateVersion,
        sessionKey: 'project-session-1',
        lineCount: 4,
        runId: `turn-${sendCount}`,
        events: [
          { seq: 1, type: 'thinking', content: `Planning turn ${sendCount}` },
          { seq: 2, type: 'tool_start', toolName: 'exec', toolArgs: { command: 'pwd' } },
          { seq: 3, type: 'tool_end', toolName: 'exec', toolResult: '/workspace/project', status: 'done' },
          { seq: 4, type: 'done', content: `Finished turn ${sendCount}` },
        ],
        active: false,
        isProcessing: false,
        complete: true,
        status: 'completed',
        text: `Finished turn ${sendCount}`,
      });
    });

    const user = userEvent.setup();
    render(<ProjectChatPanel projectName="alpha" onClose={vi.fn()} />);

    const composer = await screen.findByRole('textbox', { name: 'Message project agent' });
    await waitFor(() => expect(composer).toBeEnabled());
    expect(await screen.findByText('OpenClaw Project agent verified and ready')).toBeVisible();

    await user.type(composer, 'First turn');
    await user.click(screen.getByRole('button', { name: 'Send message to project agent' }));
    await waitFor(() => expect(sendCount).toBe(1));
    await waitFor(() => expect(composer).toBeEnabled());
    expect(await screen.findByText('Run pwd')).toBeVisible();
    expect(screen.getByText('OpenClaw Project agent verified and ready')).toBeVisible();

    await user.type(composer, 'Second turn');
    await user.click(screen.getByRole('button', { name: 'Send message to project agent' }));
    await waitFor(() => expect(sendCount).toBe(2));
    await waitFor(() => expect(composer).toBeEnabled());
    expect(screen.getByText('OpenClaw Project agent verified and ready')).toBeVisible();

    expect(projectMocks.projectChatProviders).toHaveBeenCalledTimes(1);
    expect(projectMocks.clientPost.mock.calls.filter(([url]) => String(url).endsWith('/assistant/ensure-session'))).toHaveLength(1);
    expect(projectMocks.clientPost.mock.calls.filter(([url]) => String(url).endsWith('/assistant/send'))).toHaveLength(2);
    expect(projectMocks.autoCommit).not.toHaveBeenCalled();
  });

  it('retries terminal history hydration after a transient failure without refreshing', async () => {
    projectMocks.projectChatProviders.mockResolvedValue(capabilities());
    let sent = false;
    let terminalHistoryFailed = false;
    projectMocks.chatHistory.mockImplementation(async () => {
      if (sent && !terminalHistoryFailed) {
        terminalHistoryFailed = true;
        throw new Error('temporary history outage');
      }
      return {
        messages: sent ? [{
          id: 'assistant-terminal',
          role: 'assistant',
          content: 'Recovered durable answer',
          timestamp: new Date().toISOString(),
          provider: 'OPENCLAW',
          turnId: 'turn-terminal',
        }] : [],
      };
    });
    projectMocks.clientPost.mockImplementation(async (url: string) => {
      if (url.endsWith('/assistant/ensure-session')) {
        return { data: {
          provider: 'OPENCLAW', stateVersion: 1, sessionKey: 'project-session-1',
          agentId: 'project-agent-1', runtime: 'openclaw-dedicated-project-agent',
          model: 'openai/gpt-5.5', modelValidated: true, modelVerified: true,
        } };
      }
      if (url.endsWith('/assistant/send')) {
        sent = true;
        return { data: {
          provider: 'OPENCLAW', stateVersion: 2, sessionKey: 'project-session-1',
          turnId: 'turn-terminal', runId: 'turn-terminal',
          executionContext: { scope: 'PROJECT_SANDBOX', projectId: 'project-alpha' },
          runtime: 'openclaw-dedicated-project-agent', model: 'openai/gpt-5.5', modelValidated: true, modelVerified: true,
        } };
      }
      throw new Error(`Unexpected POST ${url}`);
    });
    projectMocks.agentPoll.mockImplementation(async () => sent
      ? replaySnapshot({
          stateVersion: 2,
          runId: 'turn-terminal',
          lineCount: 1,
          events: [{ seq: 1, type: 'done', content: 'Recovered durable answer' }],
          complete: true,
          status: 'completed',
        })
      : replaySnapshot());

    const user = userEvent.setup();
    render(<ProjectChatPanel projectName="alpha" onClose={vi.fn()} />);
    const composer = await screen.findByRole('textbox', { name: 'Message project agent' });
    await waitFor(() => expect(composer).toBeEnabled());
    await user.type(composer, 'Run once');
    await user.click(screen.getByRole('button', { name: 'Send message to project agent' }));

    await waitFor(
      () => expect(screen.getByText('Recovered durable answer')).toBeVisible(),
      { timeout: 5_000 },
    );
    await waitFor(() => expect(composer).toBeEnabled());
    expect(terminalHistoryFailed).toBe(true);
    expect(projectMocks.chatHistory.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('retains and reuses the persisted delivery ID after an ambiguous 5xx response', async () => {
    projectMocks.projectChatProviders.mockResolvedValue(capabilities());
    const sentBodies: Array<Record<string, unknown>> = [];
    projectMocks.clientPost.mockImplementation(async (url: string, body?: Record<string, unknown>) => {
      if (url.endsWith('/assistant/ensure-session')) {
        return { data: {
          provider: 'OPENCLAW', stateVersion: 1, sessionKey: 'project-session-1',
          agentId: 'project-agent-1', runtime: 'openclaw-dedicated-project-agent',
          model: 'openai/gpt-5.5', modelValidated: true, modelVerified: true,
        } };
      }
      if (url.endsWith('/assistant/send')) {
        sentBodies.push(body || {});
        if (sentBodies.length === 1) {
          throw Object.assign(new Error('service unavailable after dispatch'), {
            response: { status: 503, data: { error: 'service unavailable after dispatch' } },
          });
        }
        return { data: {
          provider: 'OPENCLAW', stateVersion: 2, sessionKey: 'project-session-1',
          turnId: 'turn-replayed', runId: 'turn-replayed',
          executionContext: { scope: 'PROJECT_SANDBOX', projectId: 'project-alpha' },
          runtime: 'openclaw-dedicated-project-agent', model: 'openai/gpt-5.5', modelValidated: true, modelVerified: true,
          idempotentReplay: true,
        } };
      }
      throw new Error(`Unexpected POST ${url}`);
    });

    const user = userEvent.setup();
    render(<ProjectChatPanel projectName="alpha" onClose={vi.fn()} />);
    const composer = await screen.findByRole('textbox', { name: 'Message project agent' });
    await waitFor(() => expect(composer).toBeEnabled());
    await user.type(composer, 'Retry exactly once');
    await user.click(screen.getByRole('button', { name: 'Send message to project agent' }));

    expect(await screen.findByText('service unavailable after dispatch')).toBeVisible();
    expect(screen.getByText(/Delivery confirmation is pending/i)).toBeVisible();
    const pendingStorageKey = projectChatPendingSendStorageKey('user-1', 'project-alpha', 'OPENCLAW');
    const serializedPending = localStorage.getItem(pendingStorageKey) || '';
    const stored = JSON.parse(serializedPending || '{}');
    expect(stored.messageId).toMatch(/^project-chat-[a-f0-9]{32}$/);
    expect(serializedPending).not.toContain('Retry exactly once');
    expect(stored).not.toHaveProperty('draftText');
    expect(stored).not.toHaveProperty('payloadText');
    expect(composer).toHaveValue('Retry exactly once');

    await user.click(screen.getByRole('button', { name: 'Send message to project agent' }));
    await waitFor(() => expect(sentBodies).toHaveLength(2));
    expect(sentBodies[0]?.messageId).toBe(stored.messageId);
    expect(sentBodies[1]?.messageId).toBe(stored.messageId);
    expect(sentBodies[1]?.message).toBe(sentBodies[0]?.message);
    await waitFor(() => expect(localStorage.getItem(pendingStorageKey)).toBeNull());
    expect(composer).toHaveValue('');
  });

  it('discards a definitive 409 rejection so a corrected message receives a new delivery ID', async () => {
    projectMocks.projectChatProviders.mockResolvedValue(capabilities());
    const sentBodies: Array<Record<string, unknown>> = [];
    projectMocks.clientPost.mockImplementation(async (url: string, body?: Record<string, unknown>) => {
      if (url.endsWith('/assistant/ensure-session')) {
        return { data: {
          provider: 'OPENCLAW', stateVersion: 1, sessionKey: 'project-session-1',
          agentId: 'project-agent-1', runtime: 'openclaw-dedicated-project-agent',
          model: 'openai/gpt-5.5', modelValidated: true, modelVerified: true,
        } };
      }
      if (url.endsWith('/assistant/send')) {
        sentBodies.push(body || {});
        if (sentBodies.length === 1) {
          throw Object.assign(new Error('message was not admitted'), {
            response: {
              status: 409,
              data: { error: 'message was not admitted', admissionStatus: 'never_admitted' },
            },
          });
        }
        return { data: {
          provider: 'OPENCLAW', stateVersion: 2, sessionKey: 'project-session-1',
          turnId: 'turn-corrected', runId: 'turn-corrected',
          executionContext: { scope: 'PROJECT_SANDBOX', projectId: 'project-alpha' },
          runtime: 'openclaw-dedicated-project-agent', model: 'openai/gpt-5.5', modelValidated: true, modelVerified: true,
        } };
      }
      throw new Error(`Unexpected POST ${url}`);
    });

    const user = userEvent.setup();
    render(<ProjectChatPanel projectName="alpha" onClose={vi.fn()} />);
    const composer = await screen.findByRole('textbox', { name: 'Message project agent' });
    await waitFor(() => expect(composer).toBeEnabled());
    await user.type(composer, 'Rejected draft');
    await user.click(screen.getByRole('button', { name: 'Send message to project agent' }));

    expect(await screen.findByText('message was not admitted')).toBeVisible();
    const pendingStorageKey = projectChatPendingSendStorageKey('user-1', 'project-alpha', 'OPENCLAW');
    await waitFor(() => expect(localStorage.getItem(pendingStorageKey)).toBeNull());
    expect(screen.queryByText(/Delivery confirmation is pending/i)).not.toBeInTheDocument();
    const rejectedMessageId = sentBodies[0]?.messageId;

    await user.clear(composer);
    await user.type(composer, 'Corrected draft');
    await user.click(screen.getByRole('button', { name: 'Send message to project agent' }));
    await waitFor(() => expect(sentBodies).toHaveLength(2));
    expect(sentBodies[1]?.messageId).not.toBe(rejectedMessageId);
    expect(sentBodies[1]?.message).toBe('Corrected draft');
  });

  it('preserves an ambiguous 409 unless the server explicitly proves the request was never admitted', async () => {
    projectMocks.projectChatProviders.mockResolvedValue(capabilities());
    projectMocks.clientPost.mockImplementation(async (url: string) => {
      if (url.endsWith('/assistant/ensure-session')) {
        return { data: {
          provider: 'OPENCLAW', stateVersion: 1, sessionKey: 'project-session-1',
          agentId: 'project-agent-1', runtime: 'openclaw-dedicated-project-agent',
          model: 'openai/gpt-5.5', modelValidated: true, modelVerified: true,
        } };
      }
      if (url.endsWith('/assistant/send')) {
        throw Object.assign(new Error('coordination changed after admission'), {
          response: { status: 409, data: { error: 'coordination changed after admission' } },
        });
      }
      throw new Error(`Unexpected POST ${url}`);
    });

    const user = userEvent.setup();
    render(<ProjectChatPanel projectName="alpha" onClose={vi.fn()} />);
    const composer = await screen.findByRole('textbox', { name: 'Message project agent' });
    await waitFor(() => expect(composer).toBeEnabled());
    await user.type(composer, 'Do not duplicate this');
    await user.click(screen.getByRole('button', { name: 'Send message to project agent' }));

    expect(await screen.findByText('coordination changed after admission')).toBeVisible();
    expect(screen.getByText(/Delivery confirmation is pending/i)).toBeVisible();
    expect(localStorage.getItem(
      projectChatPendingSendStorageKey('user-1', 'project-alpha', 'OPENCLAW'),
    )).not.toBeNull();
  });

  it('restores an ambiguous send after reload and reuses its delivery ID', async () => {
    projectMocks.projectChatProviders.mockResolvedValue(capabilities());
    const sentBodies: Array<Record<string, unknown>> = [];
    projectMocks.clientPost.mockImplementation(async (url: string, body?: Record<string, unknown>) => {
      if (url.endsWith('/assistant/ensure-session')) {
        return { data: {
          provider: 'OPENCLAW', stateVersion: 1, sessionKey: 'project-session-1',
          agentId: 'project-agent-1', runtime: 'openclaw-dedicated-project-agent',
          model: 'openai/gpt-5.5', modelValidated: true, modelVerified: true,
        } };
      }
      if (url.endsWith('/assistant/send')) {
        sentBodies.push(body || {});
        if (sentBodies.length === 1) throw new Error('response was lost');
        return { data: {
          provider: 'OPENCLAW', stateVersion: 2, sessionKey: 'project-session-1',
          turnId: 'turn-after-reload', runId: 'turn-after-reload',
          executionContext: { scope: 'PROJECT_SANDBOX', projectId: 'project-alpha' },
          runtime: 'openclaw-dedicated-project-agent', model: 'openai/gpt-5.5', modelValidated: true, modelVerified: true,
          idempotentReplay: true,
        } };
      }
      throw new Error(`Unexpected POST ${url}`);
    });

    const user = userEvent.setup();
    const firstView = render(<ProjectChatPanel projectName="alpha" onClose={vi.fn()} />);
    const firstComposer = await screen.findByRole('textbox', { name: 'Message project agent' });
    await waitFor(() => expect(firstComposer).toBeEnabled());
    await user.type(firstComposer, 'Survive a reload');
    await user.click(screen.getByRole('button', { name: 'Send message to project agent' }));
    await screen.findByText('response was lost');
    const firstMessageId = sentBodies[0]?.messageId;
    firstView.unmount();

    render(<ProjectChatPanel projectName="alpha" onClose={vi.fn()} />);
    const restoredComposer = await screen.findByRole('textbox', { name: 'Message project agent' });
    await waitFor(() => expect(screen.getByText(/Delivery confirmation is pending/i)).toBeVisible());
    expect(restoredComposer).toHaveValue('');
    await waitFor(() => expect(restoredComposer).toBeEnabled());
    await user.type(restoredComposer, 'Survive a reload');
    await user.click(screen.getByRole('button', { name: 'Send message to project agent' }));

    await waitFor(() => expect(sentBodies).toHaveLength(2));
    expect(sentBodies[1]?.messageId).toBe(firstMessageId);
    expect(sentBodies[1]?.message).toBe(sentBodies[0]?.message);
    await waitFor(() => expect(localStorage.getItem(
      projectChatPendingSendStorageKey('user-1', 'project-alpha', 'OPENCLAW'),
    )).toBeNull());
  });

  it('reconciles an attachment-bearing ambiguous send after reload without storing plaintext', async () => {
    projectMocks.projectChatProviders.mockResolvedValue(capabilities());
    const storageKey = projectChatPendingSendStorageKey('user-1', 'project-alpha', 'OPENCLAW');
    const payload = 'Use this reference.\n\nAttached files:\n- project_path: .portal/attachments/upload-1/reference.png';
    await expect(runCoordinatedProjectChatSend({
      scope: { actorUserId: 'user-1', projectId: 'project-alpha', provider: 'OPENCLAW' },
      draftText: 'Use this reference.',
      payloadText: payload,
      model: 'openai/gpt-5.5',
      dispatch: async () => { throw new Error('response lost after attachment admission'); },
      classifyError: () => 'ambiguous',
    })).rejects.toThrow('response lost after attachment admission');
    const stored = JSON.parse(localStorage.getItem(storageKey) || '{}');
    expect(JSON.stringify(stored)).not.toContain('reference.png');
    projectMocks.agentMessageStatus.mockImplementation(async (
      _name: string,
      request: { provider: 'OPENCLAW'; messageId: string },
    ) => ({
      found: true,
      status: 'admitted',
      provider: request.provider,
      messageId: request.messageId,
      projectId: 'project-alpha',
      stateVersion: 1,
      turnStatus: 'running',
      dispatchStatus: 'accepted',
      recoveryRequired: false,
      turnId: 'turn-attachment-recovered',
    }));

    render(<ProjectChatPanel projectName="alpha" onClose={vi.fn()} />);
    await waitFor(() => expect(projectMocks.agentMessageStatus).toHaveBeenCalledWith(
      'alpha',
      expect.objectContaining({
        messageId: stored.messageId,
        messageFingerprint: stored.payloadFingerprint,
      }),
    ));
    await waitFor(() => expect(localStorage.getItem(storageKey)).toBeNull());
    expect(screen.getByRole('textbox', { name: 'Message project agent' })).toHaveValue('');
  });

  it('clears pending delivery IDs for every provider after a confirmed project-wide reset', async () => {
    projectMocks.projectChatProviders.mockResolvedValue(capabilities());
    await expect(runCoordinatedProjectChatSend({
      scope: { actorUserId: 'user-1', projectId: 'project-alpha', provider: 'CODEX' },
      draftText: 'Old Codex draft',
      payloadText: 'Old Codex draft',
      model: 'openai/gpt-5.5',
      dispatch: async () => { throw new Error('response lost'); },
      classifyError: () => 'ambiguous',
    })).rejects.toThrow('response lost');
    const codexPendingKey = projectChatPendingSendStorageKey('user-1', 'project-alpha', 'CODEX');
    expect(localStorage.getItem(codexPendingKey)).not.toBeNull();

    projectMocks.clientPost.mockImplementation(async (url: string) => {
      if (url.endsWith('/assistant/ensure-session')) {
        return { data: {
          provider: 'OPENCLAW', stateVersion: 1, sessionKey: 'project-session-1',
          agentId: 'project-agent-1', runtime: 'openclaw-dedicated-project-agent',
          model: 'openai/gpt-5.5', modelValidated: true, modelVerified: true,
        } };
      }
      if (url.endsWith('/assistant/reset')) {
        return { data: { success: true, provider: 'OPENCLAW', stateVersion: 2 } };
      }
      throw new Error(`Unexpected POST ${url}`);
    });

    const user = userEvent.setup();
    render(<ProjectChatPanel projectName="alpha" onClose={vi.fn()} />);
    const composer = await screen.findByRole('textbox', { name: 'Message project agent' });
    await waitFor(() => expect(composer).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Session controls' }));
    await user.click(screen.getByRole('button', { name: 'New Session' }));

    await waitFor(() => expect(projectMocks.clientPost).toHaveBeenCalledWith(
      '/projects/alpha/assistant/reset',
      { provider: 'OPENCLAW', stateVersion: 1 },
    ));
    await waitFor(() => expect(localStorage.getItem(codexPendingKey)).toBeNull());
  });

  it('renders refreshed pre-tool prose, tool, and post-tool text in durable sequence order', async () => {
    projectMocks.projectChatProviders.mockResolvedValue(capabilities());
    projectMocks.chatHistory.mockResolvedValue({
      messages: [{
        id: 'assistant-ordered',
        role: 'assistant',
        content: 'Before the tool. After the tool.',
        timestamp: new Date().toISOString(),
        provider: 'OPENCLAW',
        turnId: 'turn-ordered',
        segments: [
          // Deliberately skew timestamps: durable order must win.
          { text: 'Before the tool.', kind: 'text', position: 'before', ts: 9_000, order: 1 },
          { text: 'After the tool.', kind: 'text', position: 'after', ts: 1_000, order: 5 },
        ],
        toolCalls: [{
          id: 'tool-ordered',
          name: 'exec',
          arguments: { command: 'pwd' },
          result: '/workspace/project',
          startedAt: 5_000,
          endedAt: 5_100,
          status: 'done',
          order: 3,
        }],
      }],
    });

    const view = render(<ProjectChatPanel projectName="alpha" onClose={vi.fn()} />);
    await screen.findByText('Before the tool.');
    await screen.findByText('After the tool.');
    await screen.findByText('Run pwd');

    const rendered = view.container.textContent || '';
    expect(rendered.indexOf('Before the tool.')).toBeLessThan(rendered.indexOf('Run pwd'));
    expect(rendered.indexOf('Run pwd')).toBeLessThan(rendered.indexOf('After the tool.'));
    expect(screen.queryByText('Before the tool. After the tool.')).not.toBeInTheDocument();
  });

  it('renders a thinking subject above its body and reconciles a prefix-lagging final exactly once', async () => {
    projectMocks.projectChatProviders.mockResolvedValue(capabilities());
    projectMocks.chatHistory.mockResolvedValue({
      messages: [{
        id: 'assistant-subject-and-final',
        role: 'assistant',
        content: 'The complete canonical answer.',
        timestamp: new Date().toISOString(),
        provider: 'OPENCLAW',
        turnId: 'turn-subject-and-final',
        segments: [
          {
            text: 'Reading the runtime in detail.',
            subject: 'Inspecting the runtime',
            kind: 'thinking',
            position: 'before',
            ts: 1_000,
            order: 1,
          },
          {
            text: 'The complete',
            kind: 'text',
            position: 'after',
            ts: 2_000,
            order: 2,
          },
        ],
      }],
    });

    render(<ProjectChatPanel projectName="alpha" onClose={vi.fn()} />);

    expect(await screen.findByText('thinking · Inspecting the runtime')).toBeInTheDocument();
    expect(screen.getByText('Reading the runtime in detail.')).toBeInTheDocument();
    expect(screen.queryByText('The complete')).not.toBeInTheDocument();
    expect(screen.getAllByText('The complete canonical answer.')).toHaveLength(1);
  });

  it('preserves a pre-tool prefix and places only the residual final after every later tool', () => {
    const segments = reconcileProjectPresentationSegments([
      {
        text: 'The partial',
        kind: 'text',
        position: 'before',
        ts: 1_000,
        order: 1,
      },
    ], 'The partial canonical final.', [
      {
        id: 'tool-1',
        name: 'read',
        startedAt: 2_000,
        endedAt: 2_100,
        status: 'done',
        order: 2,
      },
      {
        id: 'tool-2',
        name: 'exec',
        startedAt: 3_000,
        endedAt: 3_100,
        status: 'done',
        order: 4,
      },
    ]);

    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({
      text: 'The partial',
      order: 1,
      position: 'before',
    });
    expect(segments[1]).toMatchObject({
      text: 'canonical final.',
      order: 5,
      position: 'after',
    });
  });

  it('keeps two graduated text phases and appends only the cumulative residual after two tools', () => {
    const segments = reconcileProjectPresentationSegments([
      {
        text: 'Intro',
        kind: 'text',
        position: 'before',
        ts: 8_000,
        order: 0,
      },
      {
        text: 'Partial',
        kind: 'text',
        position: 'between',
        ts: 9_000,
        order: 2,
      },
    ], 'Intro Partial final', [
      {
        id: 'tool-one',
        name: 'read',
        startedAt: 20_000,
        endedAt: 20_100,
        status: 'done',
        order: 1,
      },
      {
        id: 'tool-two',
        name: 'exec',
        startedAt: 1_000,
        endedAt: 1_100,
        status: 'done',
        order: 3,
      },
    ]);

    expect(segments.map(({ text, order }) => ({ text, order }))).toEqual([
      { text: 'Intro', order: 0 },
      { text: 'Partial', order: 2 },
      { text: 'final', order: 4 },
    ]);
    expect(segments.some((segment) => segment.text === 'Intro Partial final')).toBe(false);
  });

  it('does not synthesize or move an already complete multi-segment final around later tools', () => {
    const input = [
      {
        text: 'Part one.',
        kind: 'text' as const,
        position: 'before' as const,
        ts: 1_000,
        order: 1,
      },
      {
        text: 'Part two.',
        kind: 'text' as const,
        position: 'between' as const,
        ts: 3_000,
        order: 3,
      },
    ];
    const segments = reconcileProjectPresentationSegments(
      input,
      'Part one. Part two.',
      [
        {
          id: 'tool-1',
          name: 'read',
          startedAt: 2_000,
          endedAt: 2_100,
          status: 'done',
          order: 2,
        },
        {
          id: 'tool-2',
          name: 'exec',
          startedAt: 4_000,
          endedAt: 4_100,
          status: 'done',
          order: 4,
        },
      ],
    );

    expect(segments).toEqual(input);
  });

  it('leaves Project reasoning creation defaults to the server and never overrides explicit off', async () => {
    projectMocks.projectChatProviders.mockResolvedValue(capabilities());
    projectMocks.gatewaySessionInfo.mockResolvedValue({
      session: { thinkingLevel: 'high' },
    });

    const view = render(<ProjectChatPanel projectName="alpha" onClose={vi.fn()} />);
    await waitFor(() => expect(projectMocks.gatewaySessionInfo).toHaveBeenCalled());
    expect(projectMocks.gatewayPatchSession).not.toHaveBeenCalled();

    projectMocks.gatewaySessionInfo.mockClear();
    projectMocks.gatewaySessionInfo.mockResolvedValue({
      session: { thinkingLevel: 'high', reasoningLevel: 'off' },
    });
    view.unmount();
    render(<ProjectChatPanel projectName="alpha" onClose={vi.fn()} />);
    await waitFor(() => expect(projectMocks.gatewaySessionInfo).toHaveBeenCalled());
    expect(projectMocks.gatewayPatchSession).not.toHaveBeenCalled();
  });

  it('copies attachments into the verified project and sends only a project-relative path', async () => {
    projectMocks.projectChatProviders.mockResolvedValue(capabilities());
    projectMocks.clientPost.mockImplementation(async (url: string, body?: Record<string, unknown>) => {
      if (url.endsWith('/assistant/ensure-session')) {
        return {
          data: {
            provider: 'OPENCLAW',
            stateVersion: 1,
            sessionKey: 'project-session-1',
            agentId: 'project-agent-1',
            runtime: 'openclaw-dedicated-project-agent',
            model: 'openai/gpt-5.5',
            modelValidated: true,
            modelVerified: true,
          },
        };
      }
      if (url.endsWith('/assistant/send')) {
        return {
          data: {
            provider: 'OPENCLAW',
            stateVersion: 2,
            sessionKey: 'project-session-1',
            turnId: 'turn-attachment-1',
            runId: 'turn-attachment-1',
            executionContext: { scope: 'PROJECT_SANDBOX', projectId: 'project-alpha' },
            model: 'openai/gpt-5.5',
            modelValidated: true,
            modelVerified: true,
          },
        };
      }
      throw new Error(`Unexpected POST ${url} ${JSON.stringify(body)}`);
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        projectPath: '.portal/attachments/upload-1/reference.png',
        provider: 'OPENCLAW',
        stateVersion: 1,
        diskPath: '/root/portal-files/reference.png',
        originalDiskPath: '/var/lib/portal/reference.png',
        toolUrl: 'https://portal.example/api/files/signed-secret',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    render(<ProjectChatPanel projectName="alpha" onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Attach files' })).toBeEnabled());
    const file = new File(['image bytes'], 'reference.png', { type: 'image/png' });
    await user.upload(screen.getByLabelText('Choose files to attach'), file);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [attachmentUrl, attachmentOptions] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(attachmentUrl).toBe('/api/projects/alpha/assistant/attachments');
    expect(attachmentOptions.method).toBe('POST');
    expect(attachmentOptions.credentials).toBe('include');
    const attachmentBody = attachmentOptions.body as FormData;
    expect(attachmentBody.get('provider')).toBe('OPENCLAW');
    expect(attachmentBody.get('stateVersion')).toBe('1');
    expect((attachmentBody.get('file') as File).name).toBe('reference.png');

    const composer = screen.getByRole('textbox', { name: 'Message project agent' });
    await user.type(composer, 'Use this reference.');
    const sendButton = screen.getByRole('button', { name: 'Send message to project agent' });
    await waitFor(() => expect(sendButton).toBeEnabled());
    await user.click(sendButton);

    await waitFor(() => expect(projectMocks.clientPost).toHaveBeenCalledWith(
      '/projects/alpha/assistant/send',
      expect.objectContaining({
        provider: 'OPENCLAW',
        stateVersion: 1,
        message: expect.stringContaining('- project_path: .portal/attachments/upload-1/reference.png'),
      }),
    ));
    const sendCall = projectMocks.clientPost.mock.calls.find(([url]) => String(url).endsWith('/assistant/send'));
    const sentMessage = String(sendCall?.[1]?.message || '');
    expect(sentMessage).toContain('Use this reference.');
    expect(sentMessage).not.toMatch(/server_path|tool_url|portal_url|diskPath|originalDiskPath|\/api\/files/i);
  });
});
