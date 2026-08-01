// @vitest-environment jsdom
import '../test/setup';
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AppsPage from './AppsPage';
import {
  RouteOperationProvider,
  isRouteOperationOwned,
  useRouteOperationGuard,
} from '../contexts/RouteOperationContext';
import { buildProjectDeepLink } from '../utils/projectSurface';

const TEST_WORKSPACE_BINDING = {
  actorUserId: 'owner-1',
  authorizationVersion: 7,
};

const mocks = vi.hoisted(() => ({
  listProjects: vi.fn(),
  getTree: vi.fn(),
  readFile: vi.fn(),
  deleteProject: vi.fn(),
  deleteFile: vi.fn(),
  renameProject: vi.fn(),
  git: vi.fn(),
  gitEnhancedLog: vi.fn(),
  gitRevert: vi.fn(),
  deploy: vi.fn(),
  undeploy: vi.fn(),
  appProcess: vi.fn(),
  checkDeps: vi.fn(),
  projectQualification: vi.fn(),
  projectSessionControl: vi.fn(),
  projectProviderTransition: vi.fn(),
  projectModelSwitch: vi.fn(),
  listShares: vi.fn(),
  updateShare: vi.fn(),
  ollamaStatus: vi.fn(),
}));

vi.mock('../api/endpoints', () => ({
  projectsAPI: {
    list: mocks.listProjects,
    getTree: mocks.getTree,
    readFile: mocks.readFile,
    delete: mocks.deleteProject,
    deleteFile: mocks.deleteFile,
    rename: mocks.renameProject,
    git: mocks.git,
    gitEnhancedLog: mocks.gitEnhancedLog,
    gitRevert: mocks.gitRevert,
    deploy: mocks.deploy,
    undeploy: mocks.undeploy,
    appProcess: mocks.appProcess,
    checkDeps: mocks.checkDeps,
    listShares: mocks.listShares,
    updateShare: mocks.updateShare,
  },
  aiAPI: {
    ollamaStatus: mocks.ollamaStatus,
  },
}));

vi.mock('../contexts/AuthContext', () => {
  const useAuthStore = Object.assign(
    () => ({
      user: {
        id: 'owner-1',
        role: 'OWNER',
        authorizationVersion: 7,
      },
    }),
    {
      getState: () => ({
        user: {
          id: 'owner-1',
          role: 'OWNER',
          authorizationVersion: 7,
        },
      }),
    },
  );
  return { useAuthStore };
});

vi.mock('../contexts/ThemeContext', () => ({
  useTheme: () => ({ resolvedTheme: 'dark' }),
}));

vi.mock('../hooks/useIsMobile', () => ({ useIsMobile: () => false }));

vi.mock('../utils/sounds', () => ({
  default: {
    click: vi.fn(),
    delete: vi.fn(),
    error: vi.fn(),
    notification: vi.fn(),
    success: vi.fn(),
    upload: vi.fn(),
  },
}));

vi.mock('react-dropzone', () => ({
  useDropzone: () => ({
    getRootProps: () => ({}),
    getInputProps: (props: Record<string, unknown> = {}) => props,
    isDragActive: false,
  }),
}));

vi.mock('framer-motion', async () => {
  const ReactModule = await import('react');
  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    motion: {
      div: ReactModule.forwardRef<HTMLDivElement, Record<string, unknown>>((props, ref) => {
        const {
          children,
          initial: _initial,
          animate: _animate,
          exit: _exit,
          transition: _transition,
          layout: _layout,
          ...domProps
        } = props;
        return <div ref={ref} {...domProps}>{children as React.ReactNode}</div>;
      }),
    },
  };
});

vi.mock('../components/projects/LazyMonacoEditor', () => ({
  default: ({ value }: { value: string }) => <output data-testid="editor-value">{value}</output>,
}));

vi.mock('../components/chat/ProjectChatPanel', async () => {
  const ReactModule = await import('react');
  type MockProjectChatActivity =
    | Readonly<{
        kind: 'provider-qualification';
        projectName: string;
        provider: 'OPENCLAW';
        token: number;
      }>
    | Readonly<{
        kind: 'session-control';
        projectName: string;
        provider: 'OPENCLAW';
        token: number;
        sessionKey: string;
        control: 'thinking';
      }>
    | Readonly<{
        kind: 'provider-transition';
        projectName: string;
        provider: 'CODEX';
        previousProvider: 'OPENCLAW';
        sessionKey: string;
        previousModel: string;
        requestedModel: string;
        stateVersion: number;
        token: number;
      }>
    | Readonly<{
        kind: 'model-switch';
        projectName: string;
        provider: 'OPENCLAW';
        sessionKey: string;
        previousModel: string;
        requestedModel: string;
        stateVersion: number;
        token: number;
      }>;
  function MockProjectChatPanel({
      projectName,
      onClose,
      onActivityChange,
    }: {
      projectName: string;
      onClose: () => void;
      onActivityChange?: (activity: MockProjectChatActivity, active: boolean) => boolean;
    }) {
      const leaseRef = ReactModule.useRef<{
        kind: 'provider-qualification';
        projectName: string;
        provider: 'OPENCLAW';
        token: number;
      } | null>(null);
      const [busy, setBusy] = ReactModule.useState(false);
      const sessionLeaseRef = ReactModule.useRef<{
        kind: 'session-control';
        projectName: string;
        provider: 'OPENCLAW';
        token: number;
        sessionKey: string;
        control: 'thinking';
      } | null>(null);
      const [sessionBusy, setSessionBusy] = ReactModule.useState(false);
      const [sessionError, setSessionError] = ReactModule.useState<string | null>(null);
      const transitionLeaseRef = ReactModule.useRef<MockProjectChatActivity | null>(null);
      const [transitionBusy, setTransitionBusy] = ReactModule.useState<'provider-transition' | 'model-switch' | null>(null);
      const [transitionError, setTransitionError] = ReactModule.useState<string | null>(null);
      const beginQualification = () => {
        if (leaseRef.current) return;
        const lease = Object.freeze({
          kind: 'provider-qualification' as const,
          projectName,
          provider: 'OPENCLAW' as const,
          token: 1,
        });
        leaseRef.current = lease;
        if (onActivityChange?.(lease, true) === false) {
          leaseRef.current = null;
          return;
        }
        setBusy(true);
        void Promise.resolve(mocks.projectQualification(projectName))
          .catch(() => undefined)
          .finally(() => {
            if (leaseRef.current !== lease) return;
            leaseRef.current = null;
            onActivityChange?.(lease, false);
            setBusy(false);
          });
      };
      const beginSessionControl = () => {
        if (sessionLeaseRef.current) return;
        const lease = Object.freeze({
          kind: 'session-control' as const,
          projectName,
          provider: 'OPENCLAW' as const,
          token: 2,
          sessionKey: 'project-session-1',
          control: 'thinking' as const,
        });
        sessionLeaseRef.current = lease;
        if (onActivityChange?.(lease, true) === false) {
          sessionLeaseRef.current = null;
          return;
        }
        setSessionBusy(true);
        setSessionError(null);
        void Promise.resolve(mocks.projectSessionControl(projectName))
          .catch((error) => setSessionError(error instanceof Error ? error.message : String(error)))
          .finally(() => {
            if (sessionLeaseRef.current !== lease) return;
            sessionLeaseRef.current = null;
            onActivityChange?.(lease, false);
            setSessionBusy(false);
          });
      };
      const beginTransition = (kind: 'provider-transition' | 'model-switch') => {
        if (transitionLeaseRef.current) return;
        const lease = kind === 'provider-transition'
          ? Object.freeze({
              kind,
              projectName,
              provider: 'CODEX' as const,
              previousProvider: 'OPENCLAW' as const,
              sessionKey: 'project-session-1',
              previousModel: 'openai/gpt-5.5',
              requestedModel: 'openai/gpt-5.4',
              stateVersion: 7,
              token: 3,
            })
          : Object.freeze({
              kind,
              projectName,
              provider: 'OPENCLAW' as const,
              sessionKey: 'project-session-1',
              previousModel: 'openai/gpt-5.5',
              requestedModel: 'openai/gpt-5.4',
              stateVersion: 7,
              token: 4,
            });
        transitionLeaseRef.current = lease;
        if (onActivityChange?.(lease, true) === false) {
          transitionLeaseRef.current = null;
          return;
        }
        setTransitionBusy(kind);
        setTransitionError(null);
        const operation = kind === 'provider-transition'
          ? mocks.projectProviderTransition(projectName)
          : mocks.projectModelSwitch(projectName);
        void Promise.resolve(operation)
          .catch((error) => setTransitionError(error instanceof Error ? error.message : String(error)))
          .finally(() => {
            if (transitionLeaseRef.current !== lease) return;
            transitionLeaseRef.current = null;
            onActivityChange?.(lease, false);
            setTransitionBusy(null);
          });
      };
      return (
        <section aria-label={`Project Chat ${projectName}`}>
          <button type="button" onClick={beginQualification} aria-busy={busy}>
            {busy ? 'Qualifying provider…' : 'Qualify provider'}
          </button>
          <button type="button" onClick={beginSessionControl} aria-busy={sessionBusy}>
            {sessionBusy ? 'Saving session control…' : 'Save session control'}
          </button>
          <button
            type="button"
            onClick={() => beginTransition('provider-transition')}
            aria-busy={transitionBusy === 'provider-transition'}
          >
            {transitionBusy === 'provider-transition' ? 'Switching project provider…' : 'Switch project provider'}
          </button>
          <button
            type="button"
            onClick={() => beginTransition('model-switch')}
            aria-busy={transitionBusy === 'model-switch'}
          >
            {transitionBusy === 'model-switch' ? 'Switching project model…' : 'Switch project model'}
          </button>
          {sessionError && <div role="alert">{sessionError}</div>}
          {transitionError && <div role="alert">{transitionError}</div>}
          <button type="button" onClick={onClose}>Close project chat</button>
        </section>
      );
  }
  return {
    default: MockProjectChatPanel,
  };
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const alphaIdentity = { id: 'project-alpha-id', generation: 3 };
const renamedAlphaIdentity = { ...alphaIdentity, generation: alphaIdentity.generation + 1 };
const betaIdentity = { id: 'project-beta-id', generation: 1 };

const projects = [
  {
    name: 'alpha',
    hasGit: true,
    currentBranch: 'main',
    deployedUrl: '/apps/alpha',
    createdAt: '2026-07-21T12:00:00.000Z',
    updatedAt: '2026-07-21T12:00:00.000Z',
    identity: alphaIdentity,
    destructiveActions: { allowed: true, reason: null },
  },
  {
    name: 'beta',
    hasGit: false,
    currentBranch: 'main',
    deployedUrl: '/apps/beta',
    createdAt: '2026-07-21T12:00:00.000Z',
    updatedAt: '2026-07-21T12:00:00.000Z',
    identity: betaIdentity,
    destructiveActions: { allowed: true, reason: null },
  },
];

const PROJECT_RENAME_ATTEMPT_STORAGE_PREFIX = 'portal:project-rename-attempt:';

function projectRenameAttemptStorageKeys(): string[] {
  return Array.from({ length: localStorage.length }, (_unused, index) => localStorage.key(index))
    .filter((key): key is string => Boolean(key?.startsWith(PROJECT_RENAME_ATTEMPT_STORAGE_PREFIX)));
}

function storedProjectRenameAttempt(projectIdentityId = alphaIdentity.id): Record<string, unknown> | null {
  const key = projectRenameAttemptStorageKeys().find((candidate) => (
    candidate.startsWith(`${PROJECT_RENAME_ATTEMPT_STORAGE_PREFIX}${encodeURIComponent(projectIdentityId)}:`)
  ));
  if (!key) return null;
  return JSON.parse(localStorage.getItem(key) || 'null') as Record<string, unknown> | null;
}

const alphaTree = [
  { name: 'one.ts', type: 'file' as const, path: 'one.ts' },
  { name: 'two.ts', type: 'file' as const, path: 'two.ts' },
];

function NavigateProbe() {
  const navigate = useNavigate();
  const location = useLocation();
  const betaDeepLink = React.useMemo(
    () => buildProjectDeepLink('beta', 'beta.ts', TEST_WORKSPACE_BINDING),
    [],
  );
  return (
    <>
      <output data-testid="apps-route">{`${location.pathname}${location.search}`}</output>
      <button type="button" onClick={() => navigate(betaDeepLink)}>
        Navigate to beta deep link
      </button>
    </>
  );
}

function RouteOperationProbe() {
  const { active } = useRouteOperationGuard();
  return <output data-testid="route-operation-owner">{active ? 'owned' : 'idle'}</output>;
}

function opaqueProjectTestEntry(initialEntry: string): string {
  const [pathname, search = ''] = initialEntry.split('?');
  if (pathname !== '/projects') return initialEntry;
  const params = new URLSearchParams(search);
  if (params.has('open')) return initialEntry;
  const project = params.get('project');
  const file = params.get('file');
  if (!project) return initialEntry;
  return file
    ? buildProjectDeepLink(project, file, TEST_WORKSPACE_BINDING)
    : buildProjectDeepLink(project, TEST_WORKSPACE_BINDING);
}

function renderApps(
  initialEntry = '/projects?project=alpha&file=one.ts',
  convertLegacyTarget = true,
) {
  return render(
    <MemoryRouter
      initialEntries={[convertLegacyTarget ? opaqueProjectTestEntry(initialEntry) : initialEntry]}
    >
      <RouteOperationProvider>
        <NavigateProbe />
        <RouteOperationProbe />
        <AppsPage />
      </RouteOperationProvider>
    </MemoryRouter>,
  );
}

async function waitForAlphaFile() {
  await waitFor(() => expect(screen.getByRole('button', { name: 'alpha' })).toHaveAttribute('aria-current', 'page'));
  await waitFor(() => expect(mocks.readFile).toHaveBeenCalledWith('alpha', 'one.ts'));
}

describe('AppsPage share action ownership', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    mocks.listProjects.mockReset().mockResolvedValue({ projects });
    mocks.getTree.mockReset().mockImplementation(async (projectName: string, path = '') => ({
      tree: projectName === 'alpha'
        ? alphaTree
        : [{ name: 'beta.ts', type: 'file', path: 'beta.ts' }],
      currentPath: path,
      identity: projectName === 'beta'
        ? betaIdentity
        : projectName === 'alpha-renamed' ? renamedAlphaIdentity : alphaIdentity,
    }));
    mocks.readFile.mockReset().mockImplementation(async (projectName: string, filePath: string) => ({
      content: `${projectName}:${filePath}`,
      language: 'typescript',
    }));
    mocks.deleteProject.mockReset().mockResolvedValue({ ok: true });
    mocks.deleteFile.mockReset().mockResolvedValue({ ok: true });
    mocks.renameProject.mockReset().mockImplementation(async (
      _oldName: string,
      newName: string,
      attempt: { attemptId: string; identity: typeof alphaIdentity },
    ) => ({
      name: newName,
      attemptId: attempt.attemptId,
      status: 'committed',
      identity: { ...attempt.identity, generation: attempt.identity.generation + 1 },
    }));
    mocks.git.mockReset().mockImplementation(async (_projectName: string, action: string) => {
      if (action === 'status') {
        return {
          branch: 'main',
          ahead: 0,
          behind: 0,
          clean: false,
          files: [{ path: 'one.ts', status: 'modified', raw: ' M one.ts' }],
        };
      }
      return { ok: true };
    });
    mocks.gitEnhancedLog.mockReset().mockResolvedValue({ commits: [] });
    mocks.gitRevert.mockReset().mockResolvedValue({ newHash: 'revert-hash' });
    mocks.deploy.mockReset().mockResolvedValue({ deployType: 'static', url: '/apps/alpha' });
    mocks.undeploy.mockReset().mockResolvedValue({ sourcePreserved: true });
    mocks.appProcess.mockReset().mockImplementation(async (_projectName: string, action: string) => ({
      status: action === 'stop' ? 'stopped' : 'running',
      deployType: 'fullstack',
      supportedActions: ['start', 'stop', 'restart', 'status', 'logs'],
      port: 5001,
      logs: ['ready'],
      restartCount: 0,
    }));
    mocks.checkDeps.mockReset().mockResolvedValue({ needsInstall: false, packages: [] });
    mocks.projectQualification.mockReset().mockResolvedValue({ ok: true });
    mocks.projectSessionControl.mockReset().mockResolvedValue({ ok: true });
    mocks.projectProviderTransition.mockReset().mockResolvedValue({ ok: true });
    mocks.projectModelSwitch.mockReset().mockResolvedValue({ ok: true });
    mocks.listShares.mockReset().mockResolvedValue({ shares: [] });
    mocks.updateShare.mockReset().mockResolvedValue({ ok: true });
    mocks.ollamaStatus.mockReset().mockResolvedValue({
      available: false,
      models: [],
      defaultModel: 'qwen3.5:4b',
    });
  });

  it('scrubs mismatched and legacy project targets without resolving them', async () => {
    const mismatchedRoute = buildProjectDeepLink('alpha', 'one.ts', {
      ...TEST_WORKSPACE_BINDING,
      authorizationVersion: TEST_WORKSPACE_BINDING.authorizationVersion - 1,
    });
    const firstView = renderApps(mismatchedRoute);
    await waitFor(() => expect(screen.getByTestId('apps-route')).toHaveTextContent(/^\/projects$/));
    expect(mocks.getTree).not.toHaveBeenCalled();
    expect(mocks.readFile).not.toHaveBeenCalled();
    firstView.unmount();

    renderApps('/projects?project=alpha&file=one.ts', false);
    await waitFor(() => expect(screen.getByTestId('apps-route')).toHaveTextContent(/^\/projects$/));
    expect(mocks.getTree).not.toHaveBeenCalled();
    expect(mocks.readFile).not.toHaveBeenCalled();
  });

  it('shows honest fullstack process controls, logs, and restart status', async () => {
    const deployedProjects = projects.map((project) => project.name === 'alpha'
      ? {
          ...project,
          deployment: {
            appId: 'app-alpha',
            deployType: 'fullstack',
            processStatus: 'running',
            port: 5001,
            isActive: true,
          },
        }
      : project);
    mocks.listProjects.mockResolvedValue({ projects: deployedProjects });
    renderApps();
    await waitForAlphaFile();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Runtime' }));
    await waitFor(() => expect(mocks.appProcess).toHaveBeenCalledWith('alpha', 'status'));
    expect(await screen.findByText('Recent logs')).toBeVisible();
    expect(screen.getByText('ready')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Restart' }));
    await waitFor(() => expect(mocks.appProcess).toHaveBeenCalledWith('alpha', 'restart'));
    expect(mocks.appProcess).toHaveBeenLastCalledWith('alpha', 'status');
  });

  it('undeploys without deleting Project source after explicit confirmation', async () => {
    const deployedProjects = projects.map((project) => project.name === 'alpha'
      ? {
          ...project,
          deployment: {
            appId: 'app-alpha',
            deployType: 'static',
            processStatus: 'stopped',
            port: null,
            isActive: true,
          },
        }
      : project);
    const undeployedProjects = deployedProjects.map((project) => project.name === 'alpha'
      ? { ...project, deployedUrl: '', deployment: null }
      : project);
    mocks.listProjects
      .mockResolvedValueOnce({ projects: deployedProjects })
      .mockResolvedValue({ projects: undeployedProjects });
    mocks.appProcess.mockResolvedValue({
      status: 'deployed',
      deployType: 'static',
      supportedActions: [],
      logs: [],
      restartCount: 0,
      limitation: 'Static deployments have no application process to control.',
    });
    renderApps();
    await waitForAlphaFile();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Runtime' }));
    expect(await screen.findByText(/static deployments have no application process/i)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Remove deployment' }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent(/project source, git history, and project chat will be preserved/i);
    await user.click(within(dialog).getByRole('button', { name: 'Remove deployment' }));

    await waitFor(() => expect(mocks.undeploy).toHaveBeenCalledWith('alpha'));
    expect(mocks.deleteProject).not.toHaveBeenCalled();
    expect(await screen.findByText(/deployment removed. project source and chat were preserved/i)).toBeVisible();
  });

  it('keeps the selected project and its file tree in view with a 50-project inventory', async () => {
    const manyProjects = Array.from({ length: 50 }, (_unused, index) => ({
      name: `project-${String(index).padStart(2, '0')}`,
      hasGit: true,
      currentBranch: 'main',
      deployedUrl: null,
      createdAt: '2026-07-21T12:00:00.000Z',
      updatedAt: '2026-07-21T12:00:00.000Z',
      identity: { id: `project-id-${index}`, generation: 1 },
      destructiveActions: { allowed: true, reason: null },
    }));
    mocks.listProjects.mockResolvedValueOnce({ projects: manyProjects });
    mocks.getTree.mockImplementation(async (projectName: string, path = '') => ({
      tree: [{ name: 'index.ts', type: 'file' as const, path: 'index.ts' }],
      currentPath: path,
      identity: manyProjects.find((project) => project.name === projectName)?.identity,
    }));

    renderApps('/projects?project=project-49&file=index.ts');

    const projectList = await screen.findByRole('region', { name: 'Project list' });
    const fileTree = await screen.findByRole('region', { name: 'Files for project-49' });
    await waitFor(() => expect(within(fileTree).getByRole('button', { name: 'index.ts' })).toBeVisible());
    expect(within(projectList).getAllByRole('button')[0]).toHaveAccessibleName('project-49');
    expect(within(projectList).getByRole('button', { name: 'project-49' })).toHaveAttribute('aria-current', 'page');
    expect(projectList).toHaveClass('overflow-y-auto', 'max-h-[42%]');
    expect(fileTree).toHaveClass('min-h-0', 'flex-1');
    expect(projectList).not.toContainElement(fileTree);
  });

  it('keeps Project Chat qualification attached to its exact project until the sandbox roundtrip settles', async () => {
    const qualification = deferred<{ ok: boolean }>();
    mocks.projectQualification.mockReturnValueOnce(qualification.promise);
    renderApps();
    await waitForAlphaFile();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Open Project Chat' }));
    const qualify = await screen.findByRole('button', { name: 'Qualify provider' });
    const close = screen.getByRole('button', { name: 'Close project chat' });
    const beta = screen.getByRole('button', { name: 'beta' });
    const secondFile = screen.getByRole('button', { name: 'two.ts' });
    const deepLink = screen.getByRole('button', { name: 'Navigate to beta deep link' });

    act(() => {
      qualify.click();
      qualify.click();
      close.click();
      beta.click();
      secondFile.click();
      deepLink.click();
    });

    expect(mocks.projectQualification).toHaveBeenCalledTimes(1);
    expect(mocks.projectQualification).toHaveBeenCalledWith('alpha');
    expect(await screen.findByRole('button', { name: 'Qualifying provider…' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('region', { name: 'Project Chat alpha' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'alpha' })).toHaveAttribute('aria-current', 'page');
    expect(mocks.getTree).not.toHaveBeenCalledWith('beta');
    expect(mocks.readFile).not.toHaveBeenCalledWith('alpha', 'two.ts');
    const unload = new Event('beforeunload', { cancelable: true });
    expect(window.dispatchEvent(unload)).toBe(false);

    await act(async () => {
      qualification.resolve({ ok: true });
      await qualification.promise;
    });
    expect(await screen.findByRole('button', { name: 'Qualify provider' })).toBeEnabled();

    await user.click(beta);
    await waitFor(() => expect(screen.getByRole('button', { name: 'beta' })).toHaveAttribute('aria-current', 'page'));
    expect(mocks.getTree).toHaveBeenCalledWith('beta');
  });

  it('owns Project session-control readback across same-frame close, project, and deep-link switches', async () => {
    const mutation = deferred<{ ok: boolean }>();
    mocks.projectSessionControl.mockReturnValueOnce(mutation.promise);
    renderApps();
    await waitForAlphaFile();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Open Project Chat' }));
    const sessionControl = await screen.findByRole('button', { name: 'Save session control' });
    const close = screen.getByRole('button', { name: 'Close project chat' });
    const beta = screen.getByRole('button', { name: 'beta' });
    const secondFile = screen.getByRole('button', { name: 'two.ts' });
    const deepLink = screen.getByRole('button', { name: 'Navigate to beta deep link' });

    act(() => {
      sessionControl.click();
      sessionControl.click();
      close.click();
      beta.click();
      secondFile.click();
      deepLink.click();
    });

    expect(mocks.projectSessionControl).toHaveBeenCalledTimes(1);
    expect(mocks.projectSessionControl).toHaveBeenCalledWith('alpha');
    expect(await screen.findByRole('button', { name: 'Saving session control…' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('region', { name: 'Project Chat alpha' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'alpha' })).toHaveAttribute('aria-current', 'page');
    expect(mocks.getTree).not.toHaveBeenCalledWith('beta');
    expect(mocks.readFile).not.toHaveBeenCalledWith('alpha', 'two.ts');
    const unload = new Event('beforeunload', { cancelable: true });
    expect(window.dispatchEvent(unload)).toBe(false);

    await act(async () => {
      mutation.reject(new Error('Session readback failed'));
      await mutation.promise.catch(() => undefined);
    });
    expect(await screen.findByRole('button', { name: 'Save session control' })).toBeEnabled();
    expect(screen.getByRole('alert')).toHaveTextContent('Session readback failed');
    expect(screen.getByRole('region', { name: 'Project Chat alpha' })).toBeVisible();

    await user.click(beta);
    await waitFor(() => expect(screen.getByRole('button', { name: 'beta' })).toHaveAttribute('aria-current', 'page'));
    expect(mocks.getTree).toHaveBeenCalledWith('beta');
  });

  it.each([
    {
      label: 'provider transition',
      actionName: 'Switch project provider',
      busyName: 'Switching project provider…',
      mockName: 'projectProviderTransition' as const,
      failure: 'Provider transition readback failed',
    },
    {
      label: 'model switch',
      actionName: 'Switch project model',
      busyName: 'Switching project model…',
      mockName: 'projectModelSwitch' as const,
      failure: 'Model switch readback failed',
    },
  ])('owns Project Chat $label across close, project, file, route, history, and unload attempts', async ({
    actionName,
    busyName,
    mockName,
    failure,
  }) => {
    const transition = deferred<{ ok: boolean }>();
    mocks[mockName].mockReturnValueOnce(transition.promise);
    renderApps();
    await waitForAlphaFile();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Open Project Chat' }));
    const transitionButton = await screen.findByRole('button', { name: actionName });
    const close = screen.getByRole('button', { name: 'Close project chat' });
    const beta = screen.getByRole('button', { name: 'beta' });
    const secondFile = screen.getByRole('button', { name: 'two.ts' });
    const deepLink = screen.getByRole('button', { name: 'Navigate to beta deep link' });

    act(() => {
      transitionButton.click();
      transitionButton.click();
      close.click();
      beta.click();
      secondFile.click();
      deepLink.click();
      fireEvent.popState(window);
    });

    expect(mocks[mockName]).toHaveBeenCalledTimes(1);
    expect(mocks[mockName]).toHaveBeenCalledWith('alpha');
    expect(await screen.findByRole('button', { name: busyName })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('region', { name: 'Project Chat alpha' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'alpha' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId('apps-route')).toHaveTextContent(/^\/projects\?open=[a-f0-9]{32}$/);
    expect(screen.getByTestId('apps-route')).not.toHaveTextContent('alpha');
    expect(mocks.getTree).not.toHaveBeenCalledWith('beta');
    expect(mocks.readFile).not.toHaveBeenCalledWith('alpha', 'two.ts');
    const unload = new Event('beforeunload', { cancelable: true });
    expect(window.dispatchEvent(unload)).toBe(false);

    await act(async () => {
      transition.reject(new Error(failure));
      await transition.promise.catch(() => undefined);
    });
    expect(await screen.findByRole('button', { name: actionName })).toBeEnabled();
    expect(screen.getByRole('alert')).toHaveTextContent(failure);
    expect(screen.getByRole('region', { name: 'Project Chat alpha' })).toBeVisible();

    await user.click(beta);
    await waitFor(() => expect(screen.getByRole('button', { name: 'beta' })).toHaveAttribute('aria-current', 'page'));
    expect(mocks.getTree).toHaveBeenCalledWith('beta');
  });

  it('disables rename and delete up front for an older project with plain move guidance', async () => {
    const reason = 'Move this older project into a new Portal project before renaming or deleting it.';
    mocks.listProjects.mockResolvedValue({
      projects: projects.map((project) => project.name === 'beta'
        ? { ...project, destructiveActions: { allowed: false, reason } }
        : project),
    });
    renderApps();
    await waitForAlphaFile();
    const user = userEvent.setup();

    const rename = screen.getByRole('button', { name: 'Rename project beta' });
    const deletion = screen.getByRole('button', { name: 'Delete project beta' });
    expect(rename).toBeDisabled();
    expect(deletion).toBeDisabled();
    expect(rename).toHaveAttribute('title', reason);
    expect(deletion).toHaveAttribute('title', reason);

    await user.click(screen.getByRole('button', { name: 'beta' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'beta' })).toHaveAttribute('aria-current', 'page'));
    expect(screen.getByText(reason)).toBeVisible();
    expect(reason).not.toMatch(/legacy|migration|retir/i);
    fireEvent.doubleClick(screen.getByRole('button', { name: 'beta' }));
    expect(screen.queryByRole('dialog', { name: 'Rename project “beta”' })).not.toBeInTheDocument();
    expect(mocks.renameProject).not.toHaveBeenCalled();
    expect(mocks.deleteProject).not.toHaveBeenCalled();
  });

  it('owns project rename through inventory and identity readback, blocks dismissal only while active, and retries without repeating a committed rename', async () => {
    const rename = deferred<{ name: string; attemptId: string; status: 'committed'; identity: typeof alphaIdentity }>();
    const renamedProjects = projects.map((project) => project.name === 'alpha'
      ? { ...project, name: 'alpha-renamed', identity: renamedAlphaIdentity }
      : project);
    mocks.renameProject.mockReturnValueOnce(rename.promise);
    renderApps();
    await waitForAlphaFile();

    const user = userEvent.setup();
    const alpha = screen.getByRole('button', { name: 'alpha' });
    const beta = screen.getByRole('button', { name: 'beta' });
    const deepLink = screen.getByRole('button', { name: 'Navigate to beta deep link' });
    await user.click(screen.getByRole('button', { name: 'Rename project alpha' }));
    const dialog = screen.getByRole('dialog', { name: 'Rename project “alpha”' });
    const input = within(dialog).getByLabelText('New project name');
    await user.clear(input);
    await user.type(input, 'alpha-renamed');
    const submit = within(dialog).getByRole('button', { name: 'Rename project' });
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' });

    // The acknowledged mutation loses its first verification readback. The
    // following old-namespace snapshot is not non-admission proof, so the exact
    // attempt must remain globally owned and must never be PATCHed again.
    const renamingProjects = projects.map((project) => project.name === 'alpha'
      ? {
          ...project,
          destructiveActions: {
            allowed: false,
            reason: 'An interrupted rename is being restored automatically.',
          },
        }
      : project);
    mocks.listProjects
      .mockRejectedValueOnce(new Error('Project inventory unavailable'))
      .mockResolvedValueOnce({ projects: renamingProjects });

    act(() => {
      submit.click();
      submit.click();
      cancel.click();
      beta.click();
      deepLink.click();
    });

    await waitFor(() => expect(mocks.renameProject).toHaveBeenCalledTimes(1));
    const admittedAttempt = mocks.renameProject.mock.calls[0][2];
    expect(mocks.renameProject).toHaveBeenCalledWith(
      'alpha',
      'alpha-renamed',
      { attemptId: expect.any(String), identity: alphaIdentity },
    );
    expect(await within(dialog).findByRole('button', { name: 'Renaming project…' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByTestId('route-operation-owner')).toHaveTextContent('owned');
    expect(alpha).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId('apps-route')).toHaveTextContent(/^\/projects\?open=[a-f0-9]{32}$/);
    expect(screen.getByTestId('apps-route')).not.toHaveTextContent('alpha');
    const unload = new Event('beforeunload', { cancelable: true });
    expect(window.dispatchEvent(unload)).toBe(false);

    await act(async () => {
      rename.resolve({
        name: 'alpha-renamed',
        attemptId: admittedAttempt.attemptId,
        status: 'committed',
        identity: renamedAlphaIdentity,
      });
      await rename.promise;
    });

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/cannot yet prove whether this rename committed/i);
    expect(within(dialog).getByRole('button', { name: 'Check rename status' })).toBeEnabled();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeEnabled();
    expect(screen.getByTestId('route-operation-owner')).toHaveTextContent('owned');
    expect(storedProjectRenameAttempt()).toMatchObject({
      attemptId: admittedAttempt.attemptId,
      sourceName: 'alpha',
      targetName: 'alpha-renamed',
      identity: alphaIdentity,
      phase: 'indeterminate',
    });

    // Reconciliation discovers the committed namespace and exact identity.
    mocks.listProjects.mockResolvedValueOnce({ projects: renamedProjects });
    await user.click(within(dialog).getByRole('button', { name: 'Check rename status' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Rename project “alpha”' })).not.toBeInTheDocument());
    expect(mocks.renameProject).toHaveBeenCalledTimes(1);
    expect(mocks.getTree).toHaveBeenCalledWith('alpha-renamed');
    expect(screen.getByRole('button', { name: 'alpha-renamed' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId('route-operation-owner')).toHaveTextContent('idle');
    expect(projectRenameAttemptStorageKeys()).toHaveLength(0);
  });

  it('retires a saved attempt when expired-lease recovery authoritatively restores the source', async () => {
    mocks.renameProject.mockRejectedValueOnce(new Error('Connection closed after request upload'));
    renderApps();
    await waitForAlphaFile();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Rename project alpha' }));
    const dialog = screen.getByRole('dialog', { name: 'Rename project “alpha”' });
    const input = within(dialog).getByLabelText('New project name');
    await user.clear(input);
    await user.type(input, 'alpha-renamed');
    await user.click(within(dialog).getByRole('button', { name: 'Rename project' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      /interrupted rename was restored automatically/i,
    );
    expect(within(dialog).getByRole('button', { name: 'Try rename again' })).toBeEnabled();
    expect(projectRenameAttemptStorageKeys()).toHaveLength(0);
    expect(screen.getByTestId('route-operation-owner')).toHaveTextContent('idle');

    await user.click(within(dialog).getByRole('button', { name: 'Try rename again' }));
    await waitFor(() => expect(mocks.renameProject).toHaveBeenCalledTimes(2));
  });

  it('permits a new PATCH only after exact structured non-admission and a deliberate retry', async () => {
    mocks.renameProject.mockImplementation(async (
      _oldName: string,
      _newName: string,
      attempt: { attemptId: string },
    ) => Promise.reject({
      response: {
        data: {
          error: 'Target is reserved',
          code: 'PROJECT_RENAME_TARGET_EXISTS',
          status: 'not_admitted',
          admitted: false,
          attemptId: attempt.attemptId,
        },
      },
    }));
    renderApps();
    await waitForAlphaFile();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Rename project alpha' }));
    const dialog = screen.getByRole('dialog', { name: 'Rename project “alpha”' });
    const input = within(dialog).getByLabelText('New project name');
    await user.clear(input);
    await user.type(input, 'alpha-renamed');
    await user.click(within(dialog).getByRole('button', { name: 'Rename project' }));

    expect(await within(dialog).findByRole('button', { name: 'Try rename again' })).toBeEnabled();
    expect(screen.getByTestId('route-operation-owner')).toHaveTextContent('idle');
    const firstAttemptId = mocks.renameProject.mock.calls[0][2].attemptId;
    expect(projectRenameAttemptStorageKeys()).toHaveLength(0);

    await user.click(within(dialog).getByRole('button', { name: 'Try rename again' }));
    await waitFor(() => expect(mocks.renameProject).toHaveBeenCalledTimes(2));
    expect(mocks.renameProject.mock.calls[1][2].attemptId).not.toBe(firstAttemptId);
    expect(await within(dialog).findByRole('button', { name: 'Try rename again' })).toBeEnabled();
    expect(screen.getByTestId('route-operation-owner')).toHaveTextContent('idle');
  });

  it('leaves no account-wide lock after non-admission, Escape, another project action, and remount', async () => {
    mocks.renameProject.mockImplementation(async (
      _oldName: string,
      _newName: string,
      attempt: { attemptId: string },
    ) => Promise.reject({
      response: {
        data: {
          error: 'Move this older project before renaming it.',
          code: 'PROJECT_MOVE_REQUIRED',
          status: 'not_admitted',
          admitted: false,
          attemptId: attempt.attemptId,
        },
      },
    }));
    const firstView = renderApps();
    await waitForAlphaFile();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Rename project alpha' }));
    const alphaDialog = screen.getByRole('dialog', { name: 'Rename project “alpha”' });
    await user.clear(within(alphaDialog).getByLabelText('New project name'));
    await user.type(within(alphaDialog).getByLabelText('New project name'), 'alpha-renamed');
    await user.click(within(alphaDialog).getByRole('button', { name: 'Rename project' }));

    expect(await within(alphaDialog).findByRole('button', { name: 'Try rename again' })).toBeEnabled();
    expect(within(alphaDialog).getByRole('button', { name: 'Cancel' })).toBeEnabled();
    expect(projectRenameAttemptStorageKeys()).toHaveLength(0);
    expect(screen.getByTestId('route-operation-owner')).toHaveTextContent('idle');

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Rename project “alpha”' })).not.toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Rename project beta' }));
    const betaDialog = screen.getByRole('dialog', { name: 'Rename project “beta”' });
    expect(within(betaDialog).getByRole('button', { name: 'Rename project' })).toBeEnabled();
    expect(within(betaDialog).queryByRole('alert')).not.toBeInTheDocument();
    await user.click(within(betaDialog).getByRole('button', { name: 'Cancel' }));

    await user.click(screen.getByRole('button', { name: 'Delete project beta' }));
    const deleteDialog = screen.getByRole('alertdialog', { name: '⚠️ Delete project "beta"?' });
    expect(within(deleteDialog).getByRole('button', { name: 'Delete' })).toBeEnabled();
    await user.click(within(deleteDialog).getByRole('button', { name: 'Cancel' }));

    firstView.unmount();
    renderApps();
    await waitForAlphaFile();
    expect(screen.getByTestId('route-operation-owner')).toHaveTextContent('idle');
    expect(projectRenameAttemptStorageKeys()).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Rename project beta' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Delete project beta' })).toBeEnabled();
    expect(mocks.renameProject).toHaveBeenCalledTimes(1);
  });

  it('restores an indeterminate rename after a tab closes and reconciles without another PATCH', async () => {
    mocks.renameProject.mockRejectedValueOnce(new Error('Connection closed after request upload'));
    const firstView = renderApps();
    await waitForAlphaFile();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Rename project alpha' }));
    const firstDialog = screen.getByRole('dialog', { name: 'Rename project “alpha”' });
    const input = within(firstDialog).getByLabelText('New project name');
    await user.clear(input);
    await user.type(input, 'alpha-renamed');
    mocks.listProjects.mockRejectedValueOnce(new Error('Project inventory unavailable'));
    await user.click(within(firstDialog).getByRole('button', { name: 'Rename project' }));
    expect(await within(firstDialog).findByRole('button', { name: 'Check rename status' })).toBeEnabled();
    expect(mocks.renameProject).toHaveBeenCalledTimes(1);
    expect(storedProjectRenameAttempt()).not.toBeNull();

    firstView.unmount();
    // sessionStorage is discarded with the old tab. The admission record must
    // remain in localStorage so a fresh tab can recover the exact attempt.
    sessionStorage.clear();
    expect(storedProjectRenameAttempt()).not.toBeNull();
    expect(isRouteOperationOwned()).toBe(false);
    const renamedProjects = projects.map((project) => project.name === 'alpha'
      ? { ...project, name: 'alpha-renamed', identity: renamedAlphaIdentity }
      : project);
    mocks.listProjects.mockResolvedValue({ projects: renamedProjects });

    renderApps('/projects?project=alpha-renamed');
    await waitFor(() => expect(screen.getByRole('button', { name: 'alpha-renamed' })).toHaveAttribute('aria-current', 'page'));
    await waitFor(() => expect(projectRenameAttemptStorageKeys()).toHaveLength(0));
    expect(mocks.renameProject).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('route-operation-owner')).toHaveTextContent('idle');
  });

  it('ignores a delayed old rename completion after a successor remount retires the attempt', async () => {
    const rename = deferred<{
      name: string;
      attemptId: string;
      status: 'committed';
      identity: typeof alphaIdentity;
    }>();
    mocks.renameProject.mockReturnValueOnce(rename.promise);
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const firstView = renderApps();
    await waitForAlphaFile();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Rename project alpha' }));
    const firstDialog = screen.getByRole('dialog', { name: 'Rename project “alpha”' });
    await user.clear(within(firstDialog).getByLabelText('New project name'));
    await user.type(within(firstDialog).getByLabelText('New project name'), 'alpha-renamed');
    await user.click(within(firstDialog).getByRole('button', { name: 'Rename project' }));
    await waitFor(() => expect(mocks.renameProject).toHaveBeenCalledTimes(1));
    const admittedAttempt = mocks.renameProject.mock.calls[0][2];
    expect(storedProjectRenameAttempt()).not.toBeNull();

    firstView.unmount();
    const renamedProjects = projects.map((project) => project.name === 'alpha'
      ? { ...project, name: 'alpha-renamed', identity: renamedAlphaIdentity }
      : project);
    mocks.listProjects.mockResolvedValue({ projects: renamedProjects });
    renderApps('/projects?project=alpha-renamed');
    await waitFor(() => expect(projectRenameAttemptStorageKeys()).toHaveLength(0));
    expect(screen.getByTestId('route-operation-owner')).toHaveTextContent('idle');
    const writesAfterSuccessorRetirement = setItem.mock.calls.length;

    await act(async () => {
      rename.resolve({
        name: 'alpha-renamed',
        attemptId: admittedAttempt.attemptId,
        status: 'committed',
        identity: renamedAlphaIdentity,
      });
      await rename.promise;
      await Promise.resolve();
    });

    expect(projectRenameAttemptStorageKeys()).toHaveLength(0);
    expect(setItem).toHaveBeenCalledTimes(writesAfterSuccessorRetirement);
    expect(mocks.renameProject).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('route-operation-owner')).toHaveTextContent('idle');
    setItem.mockRestore();
  });

  it('requires a distinct activation after pre-admission storage recovery and ignores a hostile double-click', async () => {
    const originalSetItem = Storage.prototype.setItem;
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ) {
      if (this === window.localStorage && key.startsWith('portal:project-rename-attempt:')) {
        throw new Error('Storage quota unavailable');
      }
      return originalSetItem.call(this, key, value);
    });
    renderApps();
    await waitForAlphaFile();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Rename project alpha' }));
    const dialog = screen.getByRole('dialog', { name: 'Rename project “alpha”' });
    await user.clear(within(dialog).getByLabelText('New project name'));
    await user.type(within(dialog).getByLabelText('New project name'), 'alpha-renamed');
    mocks.listProjects.mockRejectedValueOnce(new Error('Project inventory unavailable'));
    await user.click(within(dialog).getByRole('button', { name: 'Rename project' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/did not submit the rename/i);
    expect(within(dialog).getByRole('button', { name: 'Retry rename recovery' })).toBeEnabled();
    expect(mocks.renameProject).not.toHaveBeenCalled();
    expect(screen.getByTestId('route-operation-owner')).toHaveTextContent('owned');

    setItem.mockRestore();
    await user.dblClick(within(dialog).getByRole('button', { name: 'Retry rename recovery' }));
    expect(await within(dialog).findByRole('button', { name: 'Try rename again' })).toBeEnabled();
    expect(screen.getByTestId('route-operation-owner')).toHaveTextContent('idle');
    expect(mocks.renameProject).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Try rename again' }));
    await waitFor(() => expect(mocks.renameProject).toHaveBeenCalledTimes(1));
  });

  it('fails closed when persisting an admitted indeterminate rename stops working', async () => {
    const originalSetItem = Storage.prototype.setItem;
    let renameRecordWrites = 0;
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ) {
      if (this === window.localStorage && key.startsWith('portal:project-rename-attempt:')) {
        renameRecordWrites += 1;
        if (renameRecordWrites > 1) throw new Error('Storage became unavailable');
      }
      return originalSetItem.call(this, key, value);
    });
    mocks.renameProject.mockRejectedValueOnce(new Error('Connection closed after request upload'));
    renderApps();
    await waitForAlphaFile();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Rename project alpha' }));
    const dialog = screen.getByRole('dialog', { name: 'Rename project “alpha”' });
    await user.clear(within(dialog).getByLabelText('New project name'));
    await user.type(within(dialog).getByLabelText('New project name'), 'alpha-renamed');
    mocks.listProjects.mockRejectedValueOnce(new Error('Project inventory unavailable'));
    await user.click(within(dialog).getByRole('button', { name: 'Rename project' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/admitted rename recovery record is durable/i);
    expect(within(dialog).getByRole('button', { name: 'Retry rename recovery' })).toBeEnabled();
    expect(screen.getByTestId('route-operation-owner')).toHaveTextContent('owned');
    expect(mocks.renameProject).toHaveBeenCalledTimes(1);

    setItem.mockRestore();
    await user.click(within(dialog).getByRole('button', { name: 'Retry rename recovery' }));
    expect(await within(dialog).findByRole('button', { name: 'Try rename again' })).toBeEnabled();
    expect(mocks.renameProject).toHaveBeenCalledTimes(1);
    expect(projectRenameAttemptStorageKeys()).toHaveLength(0);
    expect(screen.getByTestId('route-operation-owner')).toHaveTextContent('idle');
  });

  it.each(['getItem', 'removeItem'] as const)(
    'retains committed rename ownership when localStorage.%s cannot prove record retirement',
    async (failingMethod) => {
      const rename = deferred<{
        name: string;
        attemptId: string;
        status: 'committed';
        identity: typeof alphaIdentity;
      }>();
      mocks.renameProject.mockReturnValueOnce(rename.promise);
      renderApps();
      await waitForAlphaFile();
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Rename project alpha' }));
      const dialog = screen.getByRole('dialog', { name: 'Rename project “alpha”' });
      await user.clear(within(dialog).getByLabelText('New project name'));
      await user.type(within(dialog).getByLabelText('New project name'), 'alpha-renamed');
      await user.click(within(dialog).getByRole('button', { name: 'Rename project' }));
      await waitFor(() => expect(mocks.renameProject).toHaveBeenCalledTimes(1));

      const admittedAttempt = mocks.renameProject.mock.calls[0][2];
      const renamedProjects = projects.map((project) => project.name === 'alpha'
        ? { ...project, name: 'alpha-renamed', identity: renamedAlphaIdentity }
        : project);
      let namespaceCommitted = false;
      mocks.listProjects.mockImplementation(async () => ({
        projects: namespaceCommitted ? renamedProjects : projects,
      }));
      let storageFailure: { mockRestore: () => void };
      if (failingMethod === 'getItem') {
        const originalGetItem = Storage.prototype.getItem;
        storageFailure = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (
          this: Storage,
          key: string,
        ) {
          if (this === window.localStorage && key.startsWith('portal:project-rename-attempt:')) {
            throw new Error('Storage control plane unavailable');
          }
          return originalGetItem.call(this, key);
        });
      } else {
        const originalRemoveItem = Storage.prototype.removeItem;
        storageFailure = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (
          this: Storage,
          key: string,
        ) {
          if (this === window.localStorage && key.startsWith('portal:project-rename-attempt:')) {
            throw new Error('Storage control plane unavailable');
          }
          return originalRemoveItem.call(this, key);
        });
      }

      await act(async () => {
        namespaceCommitted = true;
        rename.resolve({
          name: 'alpha-renamed',
          attemptId: admittedAttempt.attemptId,
          status: 'committed',
          identity: renamedAlphaIdentity,
        });
        await rename.promise;
      });

      expect(await within(dialog).findByRole('alert')).toHaveTextContent(/could not verify retirement/i);
      expect(within(dialog).getByRole('button', { name: 'Retry rename recovery' })).toBeEnabled();
      expect(screen.getByTestId('route-operation-owner')).toHaveTextContent('owned');
      expect(screen.getByRole('button', { name: 'alpha', hidden: true })).toHaveAttribute('aria-current', 'page');

      storageFailure.mockRestore();
      mocks.listProjects.mockResolvedValue({ projects: renamedProjects });
      await user.click(within(dialog).getByRole('button', { name: 'Retry rename recovery' }));
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Rename project “alpha”' })).not.toBeInTheDocument());
      expect(screen.getByTestId('route-operation-owner')).toHaveTextContent('idle');
      expect(mocks.renameProject).toHaveBeenCalledTimes(1);
    },
  );

  it('does not strand a proven rename when optional localStorage bookkeeping fails', async () => {
    const rename = deferred<{
      name: string;
      attemptId: string;
      status: 'committed';
      identity: typeof alphaIdentity;
    }>();
    mocks.renameProject.mockReturnValueOnce(rename.promise);
    renderApps();
    await waitForAlphaFile();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Rename project alpha' }));
    const dialog = screen.getByRole('dialog', { name: 'Rename project “alpha”' });
    await user.clear(within(dialog).getByLabelText('New project name'));
    await user.type(within(dialog).getByLabelText('New project name'), 'alpha-renamed');
    await user.click(within(dialog).getByRole('button', { name: 'Rename project' }));
    await waitFor(() => expect(mocks.renameProject).toHaveBeenCalledTimes(1));

    const admittedAttempt = mocks.renameProject.mock.calls[0][2];
    const renamedProjects = projects.map((project) => project.name === 'alpha'
      ? { ...project, name: 'alpha-renamed', identity: renamedAlphaIdentity }
      : project);
    let namespaceCommitted = false;
    mocks.listProjects.mockImplementation(async () => ({
      projects: namespaceCommitted ? renamedProjects : projects,
    }));
    const originalSetItem = Storage.prototype.setItem;
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ) {
      if (this === window.localStorage && !key.startsWith('portal:project-rename-attempt:')) {
        throw new Error('Optional preference storage unavailable');
      }
      return originalSetItem.call(this, key, value);
    });

    await act(async () => {
      namespaceCommitted = true;
      rename.resolve({
        name: 'alpha-renamed',
        attemptId: admittedAttempt.attemptId,
        status: 'committed',
        identity: renamedAlphaIdentity,
      });
      await rename.promise;
    });

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Rename project “alpha”' })).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'alpha-renamed' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId('route-operation-owner')).toHaveTextContent('idle');
    expect(projectRenameAttemptStorageKeys()).toHaveLength(0);
    setItem.mockRestore();
  });

  it.each([
    ['torn JSON', '{'],
    ['invalid schema', JSON.stringify({ version: 1, actorId: 'owner-1', phase: 'indeterminate' })],
  ])('does not let an obsolete actor-wide rename record with %s lock a current project', async (_label, storedValue) => {
    localStorage.setItem('portal:project-rename-attempt:owner-1', storedValue);
    renderApps();
    await waitForAlphaFile();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Rename project alpha' }));
    const dialog = screen.getByRole('dialog', { name: 'Rename project “alpha”' });
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Rename project' })).toBeEnabled();
    expect(mocks.renameProject).not.toHaveBeenCalled();
  });

  it('contains unavailable rename recovery storage to the submitted project and permits dismissal', async () => {
    localStorage.setItem('portal:project-rename-attempt:unrelated:old-attempt', '{}');
    const originalGetItem = Storage.prototype.getItem;
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key: string) {
      if (this === window.localStorage && key.startsWith('portal:project-rename-attempt:')) {
        throw new Error('Storage unavailable');
      }
      return originalGetItem.call(this, key);
    });
    renderApps();
    await waitForAlphaFile();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Rename project alpha' }));
    const dialog = screen.getByRole('dialog', { name: 'Rename project “alpha”' });
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
    await user.clear(within(dialog).getByLabelText('New project name'));
    await user.type(within(dialog).getByLabelText('New project name'), 'alpha-renamed');
    await user.click(within(dialog).getByRole('button', { name: 'Rename project' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/did not submit the rename/i);
    expect(mocks.renameProject).not.toHaveBeenCalled();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeEnabled();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Rename project “alpha”' })).not.toBeInTheDocument();
    expect(screen.getByTestId('route-operation-owner')).toHaveTextContent('idle');
    await user.click(screen.getByRole('button', { name: 'Delete project beta' }));
    expect(screen.getByRole('alertdialog', { name: '⚠️ Delete project "beta"?' })).toBeVisible();
    getItem.mockRestore();
  });

  it('releases only its exact global owner if Apps unmounts during an unresolved project operation', async () => {
    const deploy = deferred<{ deployType: string; url: string }>();
    mocks.deploy.mockReturnValueOnce(deploy.promise);
    const view = renderApps();
    await waitForAlphaFile();

    fireEvent.click(screen.getByRole('button', { name: 'Deploy' }));
    await waitFor(() => expect(mocks.deploy).toHaveBeenCalledTimes(1));
    expect(isRouteOperationOwned()).toBe(true);

    view.unmount();
    expect(isRouteOperationOwned()).toBe(false);

    await act(async () => {
      deploy.resolve({ deployType: 'static', url: '/apps/alpha' });
      await deploy.promise;
    });
    expect(isRouteOperationOwned()).toBe(false);
  });

  it('binds deploy completion to the admitted project and blocks project, file, and route switching', async () => {
    const deploy = deferred<{ deployType: string; url: string }>();
    mocks.deploy.mockReturnValueOnce(deploy.promise);
    renderApps();
    await waitForAlphaFile();

    const deployButton = screen.getByRole('button', { name: 'Deploy' });
    const beta = screen.getByRole('button', { name: 'beta' });
    const secondFile = screen.getByRole('button', { name: 'two.ts' });
    const deepLink = screen.getByRole('button', { name: 'Navigate to beta deep link' });
    act(() => {
      // The project switch enters its save barrier first. Deploy must still
      // take immutable ownership before that earlier click can commit.
      beta.click();
      deployButton.click();
      deployButton.click();
      secondFile.click();
      deepLink.click();
    });

    await waitFor(() => expect(mocks.deploy).toHaveBeenCalledTimes(1));
    expect(mocks.deploy).toHaveBeenCalledWith('alpha');
    expect(await screen.findByRole('button', { name: 'Deploying…' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: 'alpha' })).toHaveAttribute('aria-current', 'page');
    expect(mocks.getTree).not.toHaveBeenCalledWith('beta');
    expect(mocks.readFile).not.toHaveBeenCalledWith('alpha', 'two.ts');
    expect(screen.getByTitle('Dismiss')).toBeVisible();
    fireEvent.click(screen.getByTitle('Dismiss'));
    expect(screen.getByText('Deploying Project')).toBeVisible();

    await act(async () => {
      deploy.resolve({ deployType: 'static', url: '/apps/alpha' });
      await deploy.promise;
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Deployed!' })).toBeEnabled());

    await userEvent.click(beta);
    await waitFor(() => expect(screen.getByRole('button', { name: 'beta' })).toHaveAttribute('aria-current', 'page'));
    expect(mocks.getTree).toHaveBeenCalledWith('beta');
  });

  it('releases the project navigation guard before an admitted runtime deploy opens Remote Desktop', async () => {
    const deploy = deferred<{ deployType: string; url: string }>();
    mocks.getTree.mockImplementation(async (projectName: string, path = '') => ({
      tree: projectName === 'alpha'
        ? [{ name: 'main.py', type: 'file' as const, path: 'main.py' }]
        : [{ name: 'beta.ts', type: 'file' as const, path: 'beta.ts' }],
      currentPath: path,
      identity: projectName === 'beta' ? betaIdentity : alphaIdentity,
    }));
    mocks.deploy.mockReturnValueOnce(deploy.promise);
    renderApps('/projects?project=alpha');
    await waitFor(() => expect(screen.getByRole('button', { name: 'alpha' })).toHaveAttribute('aria-current', 'page'));
    const beta = screen.getByRole('button', { name: 'beta' });
    const deepLink = screen.getByRole('button', { name: 'Navigate to beta deep link' });
    const run = await screen.findByRole('button', { name: 'Run' });

    act(() => {
      run.click();
      run.click();
      beta.click();
      deepLink.click();
    });

    await waitFor(() => expect(mocks.deploy).toHaveBeenCalledTimes(1));
    expect(mocks.deploy).toHaveBeenCalledWith('alpha');
    expect(screen.getByRole('button', { name: 'alpha' })).toHaveAttribute('aria-current', 'page');

    await act(async () => {
      deploy.resolve({ deployType: 'runtime', url: '/desktop' });
      await deploy.promise;
    });

    await waitFor(() => expect(screen.getByTestId('apps-route')).toHaveTextContent('/desktop'), { timeout: 3500 });
  });

  it('owns Git commits through canonical status readback and blocks project or panel abandonment', async () => {
    const commit = deferred<{ ok: boolean }>();
    let statusReads = 0;
    mocks.git.mockImplementation((_projectName: string, action: string) => {
      if (action === 'commit') return commit.promise;
      if (action === 'status') {
        statusReads += 1;
        return Promise.resolve({
          branch: 'main',
          ahead: 0,
          behind: 0,
          clean: statusReads > 1,
          files: statusReads > 1 ? [] : [{ path: 'one.ts', status: 'modified', raw: ' M one.ts' }],
        });
      }
      return Promise.resolve({ ok: true });
    });
    renderApps();
    await waitForAlphaFile();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Git' }));
    const message = await screen.findByLabelText('Commit message');
    await user.type(message, 'Keep the project attached');
    const commitButton = screen.getByRole('button', { name: 'Commit All Changes' });
    const close = screen.getByRole('button', { name: 'Close Git panel' });
    const beta = screen.getByRole('button', { name: 'beta' });
    const secondFile = screen.getByRole('button', { name: 'two.ts' });
    const deepLink = screen.getByRole('button', { name: 'Navigate to beta deep link' });

    act(() => {
      commitButton.click();
      commitButton.click();
      close.click();
      beta.click();
      secondFile.click();
      deepLink.click();
    });

    expect(mocks.git.mock.calls.filter(([, action]) => action === 'commit')).toHaveLength(1);
    expect(mocks.git).toHaveBeenCalledWith('alpha', 'commit', { message: 'Keep the project attached' });
    expect(await screen.findByRole('button', { name: 'Committing Git changes' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: 'Close Git panel' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'alpha' })).toHaveAttribute('aria-current', 'page');
    expect(mocks.getTree).not.toHaveBeenCalledWith('beta');
    expect(mocks.readFile).not.toHaveBeenCalledWith('alpha', 'two.ts');
    const unload = new Event('beforeunload', { cancelable: true });
    expect(window.dispatchEvent(unload)).toBe(false);

    await act(async () => {
      commit.resolve({ ok: true });
      await commit.promise;
    });

    await waitFor(() => expect(screen.getByRole('button', { name: 'Close Git panel' })).toBeEnabled());
    expect(statusReads).toBeGreaterThanOrEqual(2);
    await user.click(beta);
    await waitFor(() => expect(screen.getByRole('button', { name: 'beta' })).toHaveAttribute('aria-current', 'page'));
  });

  it('keeps destructive Git discard owned by its confirmation until fresh status proves the file clean', async () => {
    const reset = deferred<{ ok: boolean }>();
    let statusReads = 0;
    mocks.git.mockImplementation((_projectName: string, action: string) => {
      if (action === 'reset-file') return reset.promise;
      if (action === 'status') {
        statusReads += 1;
        return Promise.resolve({
          branch: 'main',
          ahead: 0,
          behind: 0,
          clean: statusReads > 1,
          files: statusReads > 1 ? [] : [{ path: 'one.ts', status: 'modified', raw: ' M one.ts' }],
        });
      }
      return Promise.resolve({ ok: true });
    });
    renderApps();
    await waitForAlphaFile();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Git' }));
    const alpha = screen.getByRole('button', { name: 'alpha' });
    const beta = screen.getByRole('button', { name: 'beta' });
    await user.click(await screen.findByRole('button', { name: 'Discard changes to one.ts' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Discard file changes?' });
    const confirm = within(dialog).getByRole('button', { name: 'Discard changes' });
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' });

    act(() => {
      confirm.click();
      confirm.click();
      cancel.click();
      beta.click();
      fireEvent.keyDown(document, { key: 'Escape' });
    });

    expect(mocks.git.mock.calls.filter(([, action]) => action === 'reset-file')).toHaveLength(1);
    expect(mocks.git).toHaveBeenCalledWith('alpha', 'reset-file', { file: 'one.ts' });
    expect(await within(dialog).findByRole('button', { name: 'Discarding changes…' })).toHaveAttribute('aria-busy', 'true');
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(screen.getByRole('alertdialog', { name: 'Discard file changes?' })).toBeVisible();
    expect(alpha).toHaveAttribute('aria-current', 'page');

    await act(async () => {
      reset.resolve({ ok: true });
      await reset.promise;
    });

    await waitFor(() => expect(screen.queryByRole('alertdialog', { name: 'Discard file changes?' })).not.toBeInTheDocument());
    expect(statusReads).toBeGreaterThanOrEqual(2);
  });

  it('owns Git revert through exact fresh-history proof and retains its dialog on the admitted project', async () => {
    const revert = deferred<{ newHash: string }>();
    const sourceCommit = {
      hash: 'source-hash', short: 'source1', author: 'Robert', email: 'owner@example.com',
      date: '2026-07-21T12:00:00.000Z', message: 'Source change', refs: '',
      stats: { filesChanged: 1, insertions: 2, deletions: 1, files: [{ path: 'one.ts', additions: 2, deletions: 1 }] },
    };
    const revertCommit = {
      ...sourceCommit,
      hash: 'revert-hash', short: 'revert1', message: 'Revert source change',
    };
    let logReads = 0;
    mocks.gitRevert.mockReturnValueOnce(revert.promise);
    mocks.gitEnhancedLog.mockImplementation(() => {
      logReads += 1;
      return Promise.resolve({ commits: logReads > 1 ? [revertCommit, sourceCommit] : [sourceCommit] });
    });
    renderApps();
    await waitForAlphaFile();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Git' }));
    await user.click(await screen.findByRole('tab', { name: 'History' }));
    await user.click(await screen.findByRole('button', { name: /Source change/ }));
    const beta = screen.getByRole('button', { name: 'beta' });
    const deepLink = screen.getByRole('button', { name: 'Navigate to beta deep link' });
    const alpha = screen.getByRole('button', { name: 'alpha' });
    await user.click(screen.getByRole('button', { name: 'Revert' }));
    const dialog = screen.getByRole('dialog', { name: 'Revert Commit?' });
    const confirm = within(dialog).getByRole('button', { name: 'Confirm Revert' });
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' });

    act(() => {
      confirm.click();
      confirm.click();
      cancel.click();
      beta.click();
      deepLink.click();
    });

    expect(mocks.gitRevert).toHaveBeenCalledTimes(1);
    expect(mocks.gitRevert).toHaveBeenCalledWith('alpha', 'source-hash');
    expect(await within(dialog).findByRole('button', { name: 'Reverting…' })).toHaveAttribute('aria-busy', 'true');
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(alpha).toHaveAttribute('aria-current', 'page');
    const unload = new Event('beforeunload', { cancelable: true });
    expect(window.dispatchEvent(unload)).toBe(false);

    await act(async () => {
      revert.resolve({ newHash: 'revert-hash' });
      await revert.promise;
    });

    expect(await within(dialog).findByText(/new commit: revert/)).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Close' })).toBeEnabled();
    expect(logReads).toBeGreaterThanOrEqual(2);
  });

  it('keeps project deletion progress solely in its confirmation dialog', async () => {
    const deletion = deferred<{ ok: boolean }>();
    mocks.deleteProject.mockReturnValueOnce(deletion.promise);
    renderApps();
    await waitForAlphaFile();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Delete project alpha' }));
    const dialog = screen.getByRole('alertdialog', { name: '⚠️ Delete project "alpha"?' });
    const confirm = within(dialog).getByRole('button', { name: 'Delete' });

    act(() => {
      confirm.click();
      confirm.click();
    });

    await waitFor(() => expect(mocks.deleteProject).toHaveBeenCalledTimes(1));
    expect(await within(dialog).findByRole('button', { name: 'Deleting project…' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByText('Deleting Project')).not.toBeInTheDocument();
    expect(screen.queryByText(/Retiring "alpha"/)).not.toBeInTheDocument();

    await act(async () => {
      deletion.resolve({ ok: true });
      await deletion.promise;
    });
    await waitFor(() => expect(screen.queryByRole('alertdialog', { name: '⚠️ Delete project "alpha"?' })).not.toBeInTheDocument());
  });

  it('single-flights file deletion, blocks dismissal, and retains a retryable failure in the dialog', async () => {
    const firstDelete = deferred<{ ok: boolean }>();
    mocks.deleteFile.mockReturnValueOnce(firstDelete.promise);
    renderApps();
    await waitForAlphaFile();

    const user = userEvent.setup();
    const beta = screen.getByRole('button', { name: 'beta' });
    const deepLink = screen.getByRole('button', { name: 'Navigate to beta deep link' });
    await user.click(screen.getByRole('button', { name: 'Delete file one.ts' }));
    const dialog = screen.getByRole('alertdialog', { name: '⚠️ Delete one.ts?' });
    const confirm = within(dialog).getByRole('button', { name: 'Delete' });
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' });

    act(() => {
      confirm.click();
      confirm.click();
      cancel.click();
      beta.click();
      deepLink.click();
    });

    await waitFor(() => expect(mocks.deleteFile).toHaveBeenCalledTimes(1));
    expect(mocks.deleteFile).toHaveBeenCalledWith('alpha', 'one.ts');
    expect(await within(dialog).findByRole('button', { name: 'Deleting…' })).toHaveAttribute('aria-busy', 'true');
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(screen.getByRole('alertdialog', { name: '⚠️ Delete one.ts?' })).toBeVisible();
    expect(beta).toBeDisabled();
    expect(mocks.getTree).not.toHaveBeenCalledWith('beta');
    const unloadWhileDeleting = new Event('beforeunload', { cancelable: true });
    expect(window.dispatchEvent(unloadWhileDeleting)).toBe(false);

    await act(async () => {
      firstDelete.reject(new Error('Filesystem refused deletion'));
      await firstDelete.promise.catch(() => undefined);
    });

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Filesystem refused deletion');
    expect(within(dialog).getByRole('button', { name: 'Delete' })).toBeEnabled();
    expect(mocks.deleteFile).toHaveBeenCalledTimes(1);
    const unloadAfterFailure = new Event('beforeunload', { cancelable: true });
    expect(window.dispatchEvent(unloadAfterFailure)).toBe(true);

    // Recovery remains bound to the immutable alpha/one.ts request even if a
    // route change is admitted after the failed mutation has released its lock.
    deepLink.click();
    await waitFor(() => expect(mocks.getTree).toHaveBeenCalledWith('beta'));

    mocks.deleteFile.mockResolvedValueOnce({ ok: true });
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog', { name: '⚠️ Delete one.ts?' })).not.toBeInTheDocument());
    expect(mocks.deleteFile).toHaveBeenCalledTimes(2);
    expect(mocks.deleteFile).toHaveBeenLastCalledWith('alpha', 'one.ts');
  });

  it('clears stale share controls after failed readback and single-flights an explicit retry', async () => {
    const freshReadback = deferred<{ shares: Array<Record<string, unknown>> }>();
    const staleShare = {
      id: 'stale-link',
      token: 'stale-token',
      isActive: true,
      isPublic: true,
      currentUses: 0,
      maxUses: null,
      expiresAt: null,
      createdAt: '2026-07-21T12:00:00.000Z',
    };
    const freshShare = { ...staleShare, id: 'fresh-link', token: 'fresh-token', isActive: false };
    mocks.listShares
      .mockResolvedValueOnce({ shares: [staleShare] })
      .mockRejectedValueOnce(new Error('Share readback unavailable.'))
      .mockReturnValueOnce(freshReadback.promise);

    renderApps('/projects?project=alpha');
    await waitFor(() => expect(screen.getByRole('button', { name: 'alpha' })).toHaveAttribute('aria-current', 'page'));
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Share' }));

    expect(await screen.findByText('/share/stale-token')).toBeVisible();
    const activeToggle = screen.getByRole('button', { name: 'Active' });
    await user.click(activeToggle);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Share readback unavailable.');
    expect(alert).toHaveTextContent('stale links cannot be changed');
    expect(screen.queryByText('/share/stale-token')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create Public Link' })).toBeDisabled();

    const retry = screen.getByRole('button', { name: 'Retry refresh' });
    act(() => {
      retry.click();
      retry.click();
    });
    expect(mocks.listShares).toHaveBeenCalledTimes(3);
    expect(await screen.findByRole('button', { name: 'Refreshing…' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: 'Create Public Link' })).toBeDisabled();

    await act(async () => {
      freshReadback.resolve({ shares: [freshShare] });
      await freshReadback.promise;
    });

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(screen.getByText('/share/fresh-token')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Create Public Link' })).toBeEnabled();
  });

  it('keeps a share mutation attached to the route until its authoritative link readback settles', async () => {
    const mutation = deferred<{ ok: boolean }>();
    const activeShare = {
      id: 'owned-link',
      token: 'owned-token',
      isActive: true,
      isPublic: true,
      currentUses: 0,
      maxUses: null,
      expiresAt: null,
      createdAt: '2026-07-21T12:00:00.000Z',
    };
    mocks.listShares
      .mockResolvedValueOnce({ shares: [activeShare] })
      .mockResolvedValueOnce({ shares: [{ ...activeShare, isActive: false }] });
    mocks.updateShare.mockReturnValueOnce(mutation.promise);
    renderApps('/projects?project=alpha');
    await waitFor(() => expect(screen.getByRole('button', { name: 'alpha' })).toHaveAttribute('aria-current', 'page'));
    const user = userEvent.setup();
    const deepLink = screen.getByRole('button', { name: 'Navigate to beta deep link' });
    await user.click(screen.getByRole('button', { name: 'Share' }));
    await user.click(await screen.findByRole('button', { name: 'Active' }));

    expect(mocks.updateShare).toHaveBeenCalledWith('alpha', 'owned-link', { isActive: false });
    expect(screen.getByTestId('route-operation-owner')).toHaveTextContent('owned');
    deepLink.click();
    expect(screen.getByTestId('apps-route')).toHaveTextContent(/^\/projects\?open=[a-f0-9]{32}$/);
    expect(screen.getByTestId('apps-route')).not.toHaveTextContent('alpha');
    const unload = new Event('beforeunload', { cancelable: true });
    expect(window.dispatchEvent(unload)).toBe(false);

    await act(async () => {
      mutation.resolve({ ok: true });
      await mutation.promise;
    });

    await waitFor(() => expect(screen.getByTestId('route-operation-owner')).toHaveTextContent('idle'));
    expect(screen.getByRole('button', { name: 'Disabled' })).toBeEnabled();
    await user.click(deepLink);
    await waitFor(() => expect(screen.getByRole('button', { name: 'beta' })).toHaveAttribute('aria-current', 'page'));
  });
});
