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
  userRole: 'OWNER',
  listProjects: vi.fn(),
  getTree: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
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
  share: vi.fn(),
  listShares: vi.fn(),
  updateShare: vi.fn(),
  ollamaStatus: vi.fn(),
  runtimeRepairStatus: vi.fn(),
  runtimeRepair: vi.fn(),
  activeDependencyRepairs: vi.fn(),
  dependencyRepairStatus: vi.fn(),
  forceForwardDependencyRepair: vi.fn(),
}));

vi.mock('../api/endpoints', () => ({
  projectsAPI: {
    list: mocks.listProjects,
    getTree: mocks.getTree,
    readFile: mocks.readFile,
    writeFile: mocks.writeFile,
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
    activeDependencyRepairs: mocks.activeDependencyRepairs,
    dependencyRepairStatus: mocks.dependencyRepairStatus,
    forceForwardDependencyRepair: mocks.forceForwardDependencyRepair,
    share: mocks.share,
    listShares: mocks.listShares,
    updateShare: mocks.updateShare,
  },
  aiAPI: {
    ollamaStatus: mocks.ollamaStatus,
  },
}));

vi.mock('../api/projectRuntimeImageRepair', () => ({
  projectRuntimeImageRepairAPI: {
    status: mocks.runtimeRepairStatus,
    repair: mocks.runtimeRepair,
  },
}));

vi.mock('../contexts/AuthContext', () => {
  const useAuthStore = Object.assign(
    () => ({
      user: {
        id: 'owner-1',
        role: mocks.userRole,
        authorizationVersion: 7,
      },
    }),
    {
      getState: () => ({
        user: {
          id: 'owner-1',
          role: mocks.userRole,
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
  default: ({ value, onChange }: { value: string; onChange?: (value: string) => void }) => (
    <textarea
      aria-label="Mock project editor"
      data-testid="editor-value"
      value={value}
      onChange={(event) => onChange?.(event.target.value)}
    />
  ),
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
      const dismissPanel = () => {
        if (sessionLeaseRef.current || transitionLeaseRef.current) {
          onClose();
          return;
        }
        const qualificationLease = leaseRef.current;
        if (qualificationLease) {
          if (onActivityChange?.(qualificationLease, false) === false) return;
          leaseRef.current = null;
          setBusy(false);
        }
        onClose();
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
          <button type="button" onClick={dismissPanel}>Close project chat</button>
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
const managedLifecycleActions = [
  'redeploy',
  'undeploy',
  'rename-project',
  'delete-project',
] as const;

const projects = [
  {
    name: 'alpha',
    detectedDeployType: 'static' as const,
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
    detectedDeployType: 'static' as const,
    hasGit: false,
    currentBranch: 'main',
    deployedUrl: '/apps/beta',
    createdAt: '2026-07-21T12:00:00.000Z',
    updatedAt: '2026-07-21T12:00:00.000Z',
    identity: betaIdentity,
    destructiveActions: { allowed: true, reason: null },
  },
];

const quarantinedAlpha = {
  ...projects[0],
  availability: {
    available: false as const,
    code: 'PROJECT_DEPENDENCY_PROMOTION_QUARANTINED' as const,
    message: 'Portal contained an interrupted dependency promotion.',
    action: 'RECONCILE_PROJECT_LIFECYCLE' as const,
    retryable: false,
  },
  destructiveActions: {
    allowed: false,
    reason: 'Dependency promotion recovery is required.',
  },
};

function dependencyRepairStatus(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    state: 'QUARANTINED',
    ownerOnly: true,
    action: 'FORCE_FORWARD_STAGED',
    confirmationPhrase: 'FORCE FORWARD alpha',
    project: { id: alphaIdentity.id, name: 'alpha', generation: alphaIdentity.generation },
    promotion: {
      operationId: '11111111-1111-4111-8111-111111111111',
      manifestDigest: 'a'.repeat(64),
      status: 'AUTHORIZED',
    },
    repair: null,
    backup: {
      requiredAfter: '2026-08-12T08:00:00.000Z',
      eligible: false,
      pinned: false,
    },
    retryable: true,
    statusRetryable: false,
    restartRequired: false,
    ...overrides,
  };
}

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
  strictMode = false,
) {
  const app = (
    <MemoryRouter
      initialEntries={[convertLegacyTarget ? opaqueProjectTestEntry(initialEntry) : initialEntry]}
    >
      <RouteOperationProvider>
        <NavigateProbe />
        <RouteOperationProbe />
        <AppsPage />
      </RouteOperationProvider>
    </MemoryRouter>
  );
  return render(strictMode ? <React.StrictMode>{app}</React.StrictMode> : app);
}

async function waitForAlphaFile() {
  await waitFor(() => expect(screen.getByRole('button', { name: 'alpha' })).toHaveAttribute('aria-current', 'page'));
  await waitFor(() => expect(mocks.readFile).toHaveBeenCalledWith('alpha', 'one.ts'));
}

describe('AppsPage share action ownership', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    mocks.userRole = 'OWNER';
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
    mocks.writeFile.mockReset().mockResolvedValue({ ok: true });
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
      runtimeManagement: 'portal-container',
      statusSource: 'portal-manager',
      supportedActions: ['start', 'stop', 'restart', 'status', 'logs'],
      port: 5001,
      logs: ['ready'],
      restartCount: 0,
      persistedStatus: action === 'stop' ? 'stopped' : 'running',
      recoveryRequired: false,
    }));
    mocks.checkDeps.mockReset().mockResolvedValue({ needsInstall: false, packages: [] });
    mocks.projectQualification.mockReset().mockResolvedValue({ ok: true });
    mocks.projectSessionControl.mockReset().mockResolvedValue({ ok: true });
    mocks.projectProviderTransition.mockReset().mockResolvedValue({ ok: true });
    mocks.projectModelSwitch.mockReset().mockResolvedValue({ ok: true });
    mocks.share.mockReset().mockResolvedValue({
      shareLink: {
        id: 'created-link',
        token: 'created-token',
        isActive: true,
        isPublic: true,
        currentUses: 0,
        maxUses: null,
        rateLimitMaxRequests: null,
        rateLimitWindowSeconds: null,
        expiresAt: null,
        createdAt: '2026-07-21T12:00:00.000Z',
      },
      url: '/share/created-token',
      hostedUrl: '/hosted/owner-1-alpha/',
    });
    mocks.listShares.mockReset().mockResolvedValue({ shares: [] });
    mocks.updateShare.mockReset().mockResolvedValue({ ok: true });
    mocks.ollamaStatus.mockReset().mockResolvedValue({
      available: false,
      models: [],
      defaultModel: 'qwen3.5:4b',
    });
    mocks.runtimeRepairStatus.mockReset().mockResolvedValue({
      state: 'unavailable',
      unavailableReason: 'image-missing',
      confirmationPhrase: 'REPAIR PROJECT RUNTIME IMAGE',
      ownerOnly: true,
      changesSystem: true,
      restartExpected: true,
    });
    mocks.runtimeRepair.mockReset().mockResolvedValue({ ok: true, state: 'running', started: true });
    mocks.activeDependencyRepairs.mockReset().mockResolvedValue({
      repairs: [],
      count: 0,
      unavailable: false,
    });
    mocks.dependencyRepairStatus.mockReset().mockResolvedValue(dependencyRepairStatus());
    mocks.forceForwardDependencyRepair.mockReset();
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
    const restart = deferred<Record<string, unknown>>();
    const liveManagerStatus = {
      status: 'running',
      deployType: 'fullstack',
      runtimeManagement: 'portal-container',
      statusSource: 'portal-manager',
      supportedActions: ['start', 'stop', 'restart', 'status', 'logs'],
      port: 5001,
      logs: ['ready'],
      restartCount: 0,
      persistedStatus: 'running',
      recoveryRequired: false,
    };
    const deployedProjects = projects.map((project) => project.name === 'alpha'
      ? {
          ...project,
          deployment: {
            appId: 'app-alpha',
            deployType: 'fullstack',
            processStatus: 'running',
            runtimeManagement: 'portal-container',
            statusSource: 'persisted-app',
            supportedLifecycleActions: [...managedLifecycleActions],
            port: 5001,
            isActive: true,
          },
        }
      : project);
    mocks.listProjects.mockResolvedValue({ projects: deployedProjects });
    mocks.appProcess.mockImplementation(async (_projectName: string, action: string) => (
      action === 'restart' ? restart.promise : liveManagerStatus
    ));
    renderApps();
    await waitForAlphaFile();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Deployment' }));
    await waitFor(() => expect(mocks.appProcess).toHaveBeenCalledWith('alpha', 'status'));
    expect(screen.getByText('Portal-managed container')).toBeVisible();
    expect(screen.getByText('Portal runtime manager')).toBeVisible();
    expect(await screen.findByText('Recent logs')).toBeVisible();
    expect(screen.getByText('ready')).toBeVisible();

    const restartButton = screen.getByRole('button', { name: 'Restart' });
    expect(restartButton).toHaveAttribute('aria-busy', 'false');
    await user.click(restartButton);
    await waitFor(() => expect(mocks.appProcess).toHaveBeenCalledWith('alpha', 'restart'));
    expect(restartButton).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('Restarting deployment.')).toBeInTheDocument();

    await act(async () => {
      restart.resolve(liveManagerStatus);
      await restart.promise;
    });
    expect(mocks.appProcess).toHaveBeenLastCalledWith('alpha', 'status');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Restart' })).toHaveAttribute('aria-busy', 'false'));
  });

  it('undeploys without deleting Project source after explicit confirmation', async () => {
    const deployedProjects = projects.map((project) => project.name === 'alpha'
      ? {
          ...project,
          deployment: {
            appId: 'app-alpha',
            deployType: 'static',
            processStatus: 'stopped',
            runtimeManagement: 'static',
            statusSource: 'deployment-record',
            supportedLifecycleActions: [...managedLifecycleActions],
            port: null,
            isActive: true,
          },
        }
      : project);
    const undeployedProjects = deployedProjects.map((project) => project.name === 'alpha'
      ? { ...project, deployedUrl: '', deployment: null }
      : project);
    mocks.listProjects.mockImplementation(async () => ({
      projects: mocks.undeploy.mock.calls.length > 0
        ? undeployedProjects
        : deployedProjects,
    }));
    mocks.appProcess.mockResolvedValue({
      status: 'deployed',
      deployType: 'static',
      runtimeManagement: 'static',
      statusSource: 'deployment-record',
      supportedActions: [],
      logs: [],
      restartCount: 0,
      persistedStatus: 'deployed',
      recoveryRequired: false,
      limitation: 'Static deployments have no application process to control.',
    });
    renderApps();
    await waitForAlphaFile();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Deployment' }));
    expect(await screen.findByText(/static deployments have no application process/i)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Remove deployment' }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent(/project source, git history, and project chat will be preserved/i);
    await user.click(within(dialog).getByRole('button', { name: 'Remove deployment' }));

    await waitFor(() => expect(mocks.undeploy).toHaveBeenCalledWith('alpha'));
    expect(mocks.deleteProject).not.toHaveBeenCalled();
    expect(await screen.findByText(/deployment removed. project source and chat were preserved/i)).toBeVisible();
  });

  it('turns a deployment-type conflict into a confirmed one-click undeploy recovery', async () => {
    const deployedProjects = projects.map((project) => project.name === 'alpha'
      ? {
          ...project,
          deployment: {
            appId: 'app-alpha',
            deployType: 'fullstack',
            processStatus: 'stopped',
            runtimeManagement: 'portal-container' as const,
            statusSource: 'persisted-app' as const,
            supportedLifecycleActions: [...managedLifecycleActions],
            port: 5001,
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
    mocks.deploy.mockRejectedValueOnce({
      response: {
        status: 409,
        data: {
          code: 'PROJECT_DEPLOY_TYPE_TRANSITION_REQUIRES_UNDEPLOY',
          error: 'This Project is already deployed as fullstack. Remove the current deployment before deploying it as static.',
          detail: 'Removing the deployment stops and clears its current runtime while preserving the Project source. You can then deploy the new type.',
          priorDeployType: 'fullstack',
          nextDeployType: 'static',
          recoveryAction: 'UNDEPLOY_CURRENT_DEPLOYMENT',
          details: 'raw runtime state must not be displayed',
          recoveryActionUrl: 'https://untrusted.invalid/remove',
        },
      },
    });
    renderApps();
    await waitForAlphaFile();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Deploy' }));

    const recoveryButton = await screen.findByRole('button', { name: 'Remove current deployment' });
    const alert = recoveryButton.closest('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert).toHaveTextContent(/already deployed as fullstack/i);
    expect(alert).toHaveTextContent(/preserving the project source/i);
    expect(alert).toHaveTextContent('PROJECT_DEPLOY_TYPE_TRANSITION_REQUIRES_UNDEPLOY');
    expect(alert).not.toHaveTextContent('raw runtime state');
    expect(alert).not.toHaveTextContent('untrusted.invalid');
    expect(mocks.undeploy).not.toHaveBeenCalled();

    await user.click(recoveryButton);
    const dialog = screen.getByRole('alertdialog', { name: 'Remove deployment for "alpha"?' });
    expect(dialog).toHaveTextContent(/project source, git history, and project chat will be preserved/i);
    await user.click(within(dialog).getByRole('button', { name: 'Remove deployment' }));

    await waitFor(() => expect(mocks.undeploy).toHaveBeenCalledWith('alpha'));
    expect(mocks.deleteProject).not.toHaveBeenCalled();
    expect(await screen.findByText(/deployment removed. project source and chat were preserved/i)).toBeVisible();
  });

  it('shows an honest static deployment state while its status read is pending', async () => {
    const status = deferred<{
      status: string;
      deployType: string;
      runtimeManagement: string;
      statusSource: string;
      supportedActions: string[];
      logs: string[];
      restartCount: number;
      persistedStatus: string;
      recoveryRequired: boolean;
    }>();
    mocks.listProjects.mockResolvedValue({
      projects: projects.map((project) => project.name === 'alpha'
        ? {
            ...project,
            deployment: {
              appId: 'app-alpha',
              deployType: 'static',
              processStatus: 'stopped',
              runtimeManagement: 'static' as const,
              statusSource: 'deployment-record' as const,
              supportedLifecycleActions: [...managedLifecycleActions],
              port: null,
              isActive: true,
            },
          }
        : project),
    });
    mocks.appProcess.mockReturnValue(status.promise);
    renderApps();
    await waitForAlphaFile();

    await userEvent.click(screen.getByRole('button', { name: 'Deployment' }));

    expect(await screen.findByText('deployed')).toBeVisible();
    expect(screen.queryByText('stopped')).not.toBeInTheDocument();

    await act(async () => {
      status.resolve({
        status: 'deployed',
        deployType: 'static',
        runtimeManagement: 'static',
        statusSource: 'deployment-record',
        supportedActions: [],
        logs: [],
        restartCount: 0,
        persistedStatus: 'stopped',
        recoveryRequired: false,
      });
      await status.promise;
    });
  });

  it('blocks redeploy behind an old status read and refreshes the replacement App status', async () => {
    const oldStatus = deferred<{
      status: string;
      deployType: string;
      runtimeManagement: string;
      statusSource: string;
      supportedActions: string[];
      port: number;
      logs: string[];
      restartCount: number;
      persistedStatus: string;
      recoveryRequired: boolean;
    }>();
    const oldInventory = projects.map((project) => project.name === 'alpha'
      ? {
          ...project,
          deployment: {
            appId: 'app-old',
            deployType: 'fullstack',
            processStatus: 'running',
            runtimeManagement: 'portal-container' as const,
            statusSource: 'persisted-app' as const,
            supportedLifecycleActions: [...managedLifecycleActions],
            port: 5001,
            isActive: true,
          },
        }
      : project);
    const newInventory = oldInventory.map((project) => project.name === 'alpha'
      ? {
          ...project,
          deployment: {
            appId: 'app-new',
            deployType: 'fullstack',
            processStatus: 'starting',
            runtimeManagement: 'portal-container' as const,
            statusSource: 'persisted-app' as const,
            supportedLifecycleActions: [...managedLifecycleActions],
            port: 5002,
            isActive: true,
          },
        }
      : project);
    mocks.listProjects
      .mockResolvedValueOnce({ projects: oldInventory })
      .mockResolvedValue({ projects: newInventory });
    mocks.appProcess
      .mockReturnValueOnce(oldStatus.promise)
      .mockResolvedValue({
        status: 'running',
        deployType: 'fullstack',
        runtimeManagement: 'portal-container',
        statusSource: 'portal-manager',
        supportedActions: ['start', 'stop', 'restart', 'status', 'logs'],
        port: 5002,
        logs: ['ready-new-app'],
        restartCount: 0,
        persistedStatus: 'running',
        recoveryRequired: false,
      });
    mocks.deploy.mockResolvedValue({ deployType: 'fullstack', url: '/apps/alpha' });
    renderApps();
    await waitForAlphaFile();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Deployment' }));
    const deployButton = screen.getByRole('button', { name: 'Deploy' });
    await waitFor(() => expect(deployButton).toBeDisabled());
    fireEvent.click(deployButton);
    expect(mocks.deploy).not.toHaveBeenCalled();

    await act(async () => {
      oldStatus.resolve({
        status: 'running',
        deployType: 'fullstack',
        runtimeManagement: 'portal-container',
        statusSource: 'portal-manager',
        supportedActions: ['start', 'stop', 'restart', 'status', 'logs'],
        port: 5001,
        logs: ['old-app-status'],
        restartCount: 0,
        persistedStatus: 'running',
        recoveryRequired: false,
      });
      await oldStatus.promise;
    });
    await waitFor(() => expect(deployButton).toBeEnabled());

    await user.click(deployButton);

    await waitFor(() => expect(mocks.deploy).toHaveBeenCalledWith('alpha'));
    await waitFor(() => expect(mocks.appProcess).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('ready-new-app')).toBeVisible();
    expect(screen.queryByText('old-app-status')).not.toBeInTheDocument();
  });

  it('shows externally managed deployments as read-only with an honest Open App path', async () => {
    const deployedProjects = projects.map((project) => project.name === 'alpha'
      ? {
          ...project,
          deployment: {
            appId: 'app-alpha',
            deployType: 'fullstack',
            processStatus: 'running',
            runtimeManagement: 'external-loopback' as const,
            statusSource: 'external-binding' as const,
            supportedLifecycleActions: [],
            port: null,
            isActive: true,
          },
        }
      : project);
    mocks.listProjects.mockResolvedValue({ projects: deployedProjects });
    mocks.appProcess.mockResolvedValue({
      status: 'running',
      deployType: 'fullstack',
      runtimeManagement: 'external-loopback',
      statusSource: 'external-binding',
      supportedActions: [],
      logs: [],
      restartCount: 0,
      persistedStatus: 'running',
      recoveryRequired: false,
      limitation: 'Portal routes this app, but its external service must be managed on the host.',
    });
    renderApps();
    await waitForAlphaFile();

    expect(screen.queryByRole('button', { name: 'Deploy' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rename project alpha' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Delete project alpha' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Deployment' }));

    expect(await screen.findByText('External service')).toBeVisible();
    expect(screen.getByText('External routing')).toBeVisible();
    expect(screen.getByText('Read-only external deployment')).toBeVisible();
    expect(screen.getByText(/external service must be managed on the host/i)).toBeVisible();
    expect(screen.getByRole('link', { name: 'Open App' })).toHaveAttribute('href', '/apps/alpha');
    expect(screen.queryByRole('button', { name: 'Start' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restart' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove deployment' })).not.toBeInTheDocument();
    expect(screen.getByText(/removal is unavailable because/i)).toBeVisible();
  });

  it('renders an invalid external binding as a blocked configuration with no lifecycle controls', async () => {
    const deployedProjects = projects.map((project) => project.name === 'alpha'
      ? {
          ...project,
          destructiveActions: {
            allowed: false,
            reason: 'The server-managed target must be repaired.',
          },
          deployment: {
            appId: 'app-alpha',
            deployType: 'static',
            processStatus: 'stopped',
            runtimeManagement: 'external-loopback' as const,
            statusSource: 'external-binding' as const,
            supportedLifecycleActions: [],
            bindingStatus: 'invalid' as const,
            configurationCode: 'PROJECT_RUNTIME_BINDING_INVALID' as const,
            limitation: 'The server-managed target must be repaired.',
            port: null,
            isActive: true,
          },
        }
      : project);
    mocks.listProjects.mockResolvedValue({ projects: deployedProjects });
    mocks.appProcess.mockImplementation(() => new Promise(() => {}));
    renderApps();
    await waitForAlphaFile();

    expect(screen.queryByRole('button', { name: 'Deploy' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rename project alpha' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Delete project alpha' })).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'Deployment' }));
    expect(await screen.findByText('Deployment configuration needs attention')).toBeVisible();
    expect(screen.getAllByText('The server-managed target must be repaired.')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Start' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restart' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove deployment' })).not.toBeInTheDocument();
  });

  it('preserves redeploy only for a static Project with an external API binding', async () => {
    const deployedProjects = projects.map((project) => project.name === 'alpha'
      ? {
          ...project,
          destructiveActions: {
            allowed: false,
            reason: 'This Project uses an externally managed service.',
          },
          deployment: {
            appId: 'app-alpha',
            deployType: 'static',
            processStatus: 'running',
            runtimeManagement: 'external-loopback' as const,
            statusSource: 'external-binding' as const,
            supportedLifecycleActions: ['redeploy' as const],
            port: null,
            isActive: true,
          },
        }
      : project);
    mocks.listProjects.mockResolvedValue({ projects: deployedProjects });
    mocks.appProcess.mockResolvedValue({
      status: 'running',
      deployType: 'static',
      runtimeManagement: 'external-loopback',
      statusSource: 'external-binding',
      supportedActions: [],
      logs: [],
      restartCount: 0,
      persistedStatus: 'running',
      recoveryRequired: false,
      limitation: 'Portal routes this static app to an external API service.',
    });
    renderApps();
    await waitForAlphaFile();

    expect(screen.getByRole('button', { name: 'Deploy' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Rename project alpha' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Delete project alpha' })).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'Deployment' }));
    expect(await screen.findByText('Read-only external deployment')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Remove deployment' })).not.toBeInTheDocument();
  });

  it('renders the exact live-manager deployment control set', async () => {
    const deployedProjects = projects.map((project) => project.name === 'alpha'
      ? {
          ...project,
          deployment: {
            appId: 'app-alpha',
            deployType: 'fullstack',
            processStatus: 'running',
            runtimeManagement: 'portal-container' as const,
            statusSource: 'persisted-app' as const,
            supportedLifecycleActions: [...managedLifecycleActions],
            port: 5001,
            isActive: true,
          },
        }
      : project);
    mocks.listProjects.mockResolvedValue({ projects: deployedProjects });
    mocks.appProcess.mockResolvedValue({
      status: 'running',
      deployType: 'fullstack',
      runtimeManagement: 'portal-container',
      statusSource: 'portal-manager',
      supportedActions: ['start', 'stop', 'restart', 'status', 'logs'],
      port: 5001,
      logs: ['live-manager-log'],
      restartCount: 0,
      persistedStatus: 'running',
      recoveryRequired: false,
    });
    renderApps();
    await waitForAlphaFile();

    await userEvent.click(screen.getByRole('button', { name: 'Deployment' }));

    expect(await screen.findByRole('button', { name: 'Stop' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Start' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Restart' })).toBeVisible();
    expect(screen.getByText('Recent logs')).toBeVisible();
    expect(screen.getByText('live-manager-log')).toBeVisible();
  });

  it('drops stale controls and logs when an authoritative status refresh fails', async () => {
    const failedRefresh = deferred<never>();
    const deployedProjects = projects.map((project) => project.name === 'alpha'
      ? {
          ...project,
          deployment: {
            appId: 'app-alpha',
            deployType: 'fullstack',
            processStatus: 'running',
            runtimeManagement: 'portal-container' as const,
            statusSource: 'persisted-app' as const,
            supportedLifecycleActions: [...managedLifecycleActions],
            port: 5001,
            isActive: true,
          },
        }
      : project);
    mocks.listProjects.mockResolvedValue({ projects: deployedProjects });
    mocks.appProcess
      .mockResolvedValueOnce({
        status: 'running',
        deployType: 'fullstack',
        runtimeManagement: 'portal-container',
        statusSource: 'portal-manager',
        supportedActions: ['start', 'stop', 'restart', 'status', 'logs'],
        port: 5001,
        logs: ['verified-before-refresh'],
        restartCount: 0,
        persistedStatus: 'running',
        recoveryRequired: false,
      })
      .mockReturnValueOnce(failedRefresh.promise);
    renderApps();
    await waitForAlphaFile();
    await userEvent.click(screen.getByRole('button', { name: 'Deployment' }));

    const staleStartButton = await screen.findByRole('button', { name: 'Start' });
    expect(screen.getByText('verified-before-refresh')).toBeVisible();
    const refreshButton = screen.getByRole('button', { name: 'Refresh deployment status' });

    fireEvent.click(refreshButton);
    // Exercise the old DOM node in the same tick. The synchronous owner fence,
    // not merely the subsequent render, must prevent a stale mutation.
    fireEvent.click(staleStartButton);

    await waitFor(() => expect(refreshButton).toHaveAttribute('aria-busy', 'true'));
    expect(screen.getByText('Refreshing deployment status.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restart' })).not.toBeInTheDocument();
    expect(screen.queryByText('Recent logs')).not.toBeInTheDocument();
    expect(mocks.appProcess.mock.calls).toEqual([
      ['alpha', 'status'],
      ['alpha', 'status'],
    ]);

    await act(async () => {
      failedRefresh.reject({
        response: {
          status: 503,
          data: {
            error: 'Deployment status could not be verified.',
            code: 'PROJECT_RUNTIME_REQUEST_FAILED',
          },
        },
      });
      await failedRefresh.promise.catch(() => undefined);
    });

    expect(await screen.findByRole('alert')).toHaveTextContent('Deployment status could not be verified.');
    expect(refreshButton).toHaveAttribute('aria-busy', 'false');
    expect(screen.getByText('Deployment status: unknown.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start' })).not.toBeInTheDocument();
    expect(screen.queryByText('verified-before-refresh')).not.toBeInTheDocument();
    expect(mocks.appProcess.mock.calls).toEqual([
      ['alpha', 'status'],
      ['alpha', 'status'],
    ]);
  });

  it('distinguishes an unverified live runtime from its last saved state', async () => {
    const deployedProjects = projects.map((project) => project.name === 'alpha'
      ? {
          ...project,
          deployment: {
            appId: 'app-alpha',
            deployType: 'fullstack',
            processStatus: 'running',
            runtimeManagement: 'portal-container' as const,
            statusSource: 'persisted-app' as const,
            supportedLifecycleActions: [...managedLifecycleActions],
            port: null,
            isActive: true,
          },
        }
      : project);
    mocks.listProjects.mockResolvedValue({ projects: deployedProjects });
    mocks.appProcess.mockResolvedValue({
      status: 'unknown',
      deployType: 'fullstack',
      runtimeManagement: 'portal-container',
      statusSource: 'persisted-app',
      supportedActions: ['start', 'stop', 'status'],
      logs: [],
      restartCount: 0,
      persistedStatus: 'running',
      recoveryRequired: true,
    });
    renderApps();
    await waitForAlphaFile();

    await userEvent.click(screen.getByRole('button', { name: 'Deployment' }));

    expect(await screen.findByText('unknown')).toBeVisible();
    expect(screen.getByText('Last saved state')).toBeVisible();
    expect(screen.getByText(/live status could not be verified/i)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Start' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Restart' })).not.toBeInTheDocument();
  });

  it('runs the Owner repair and replays only the server-bound failed Start action', async () => {
    const deployedProjects = projects.map((project) => project.name === 'alpha'
      ? {
          ...project,
          deployment: {
            appId: 'app-alpha',
            deployType: 'fullstack',
            processStatus: 'stopped',
            runtimeManagement: 'portal-container' as const,
            statusSource: 'persisted-app' as const,
            supportedLifecycleActions: [...managedLifecycleActions],
            port: null,
            isActive: true,
          },
        }
      : project);
    mocks.listProjects.mockResolvedValue({ projects: deployedProjects });
    const recoveryReplay = {
      proof: 'v1.11111111-1111-4111-8111-111111111111.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      action: 'start' as const,
      projectIdentity: alphaIdentity,
      expectedAppId: 'app-alpha',
    };
    let initialStartFailed = false;
    mocks.appProcess.mockImplementation(async (
      _projectName: string,
      action: string,
      replay?: typeof recoveryReplay,
    ) => {
      if (action === 'status') {
        return {
          status: replay ? 'running' : 'stopped',
          deployType: 'fullstack',
          runtimeManagement: 'portal-container',
          statusSource: 'persisted-app',
          supportedActions: ['start', 'stop', 'restart', 'status', 'logs'],
          logs: [],
          restartCount: 0,
          persistedStatus: replay ? 'running' : 'stopped',
          recoveryRequired: false,
        };
      }
      if (action === 'start' && replay) {
        return {
          status: 'running',
          deployType: 'fullstack',
          runtimeManagement: 'portal-container',
          statusSource: 'portal-manager',
          supportedActions: ['start', 'stop', 'restart', 'status', 'logs'],
          logs: [],
          restartCount: 0,
          persistedStatus: 'running',
          recoveryRequired: false,
        };
      }
      initialStartFailed = true;
      throw {
        response: {
          status: 503,
          data: {
            error: 'The Project runtime image is unavailable.',
            detail: 'Re-run the Portal installer or update, then try again.',
            limitation: 'No application process was changed.',
            code: 'PROJECT_RUNTIME_IMAGE_UNAVAILABLE',
            recoveryAction: 'REPAIR_PROJECT_RUNTIME_IMAGE',
            recoveryReplay,
            details: 'raw engine digest and host diagnostics must stay private',
            recoveryActionUrl: 'https://untrusted.invalid/update',
          },
        },
      };
    });
    mocks.runtimeRepairStatus
      .mockReset()
      .mockResolvedValueOnce({
        state: 'unavailable',
        unavailableReason: 'image-missing',
        confirmationPhrase: 'REPAIR PROJECT RUNTIME IMAGE',
        ownerOnly: true,
        changesSystem: true,
        restartExpected: true,
      })
      .mockResolvedValueOnce({
        state: 'ready',
        confirmationPhrase: 'REPAIR PROJECT RUNTIME IMAGE',
        ownerOnly: true,
        changesSystem: true,
        restartExpected: true,
      });
    renderApps();
    await waitForAlphaFile();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Deployment' }));
    await user.click(await screen.findByRole('button', { name: 'Start' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The Project runtime image is unavailable.');
    expect(alert).toHaveTextContent('Re-run the Portal installer or update, then try again.');
    expect(alert).toHaveTextContent('No application process was changed.');
    expect(alert).toHaveTextContent('PROJECT_RUNTIME_IMAGE_UNAVAILABLE');
    expect(alert).not.toHaveTextContent('raw engine digest');
    expect(alert).not.toHaveTextContent('untrusted.invalid');
    expect(initialStartFailed).toBe(true);

    await user.click(within(alert).getByRole('button', { name: 'Repair runtime image and retry' }));
    const dialog = await screen.findByRole('dialog', { name: 'Repair runtime image and retry?' });
    await user.type(within(dialog).getByLabelText(/REPAIR PROJECT RUNTIME IMAGE/), 'REPAIR PROJECT RUNTIME IMAGE');
    await user.click(within(dialog).getByRole('button', { name: 'Repair runtime image' }));

    await waitFor(() => expect(mocks.runtimeRepair).toHaveBeenCalledWith('REPAIR PROJECT RUNTIME IMAGE'));
    await waitFor(() => expect(mocks.appProcess).toHaveBeenCalledWith('alpha', 'start', recoveryReplay));
    expect(mocks.deploy).not.toHaveBeenCalled();
  });

  it('does not open a repair confirmation when systemd ownership is unknown', async () => {
    mocks.listProjects.mockResolvedValue({
      projects: projects.map((project) => project.name === 'alpha'
        ? {
            ...project,
            deployment: {
              appId: 'app-alpha',
              deployType: 'fullstack',
              processStatus: 'stopped',
              runtimeManagement: 'portal-container' as const,
              statusSource: 'persisted-app' as const,
              supportedLifecycleActions: [...managedLifecycleActions],
              port: null,
              isActive: true,
            },
          }
        : project),
    });
    const recoveryReplay = {
      proof: 'v1.11111111-1111-4111-8111-111111111111.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      action: 'start' as const,
      projectIdentity: alphaIdentity,
      expectedAppId: 'app-alpha',
    };
    mocks.appProcess.mockImplementation(async (_projectName: string, action: string) => {
      if (action === 'status') {
        return {
          status: 'stopped',
          deployType: 'fullstack',
          runtimeManagement: 'portal-container',
          statusSource: 'persisted-app',
          supportedActions: ['start', 'status'],
          logs: [],
          restartCount: 0,
          persistedStatus: 'stopped',
          recoveryRequired: false,
        };
      }
      throw {
        response: {
          status: 503,
          data: {
            error: 'The Project runtime image is unavailable.',
            code: 'PROJECT_RUNTIME_IMAGE_UNAVAILABLE',
            recoveryAction: 'REPAIR_PROJECT_RUNTIME_IMAGE',
            recoveryReplay,
          },
        },
      };
    });
    mocks.runtimeRepairStatus.mockReset().mockResolvedValue({
      state: 'unavailable',
      unavailableReason: 'unit-state-unknown',
      confirmationPhrase: 'REPAIR PROJECT RUNTIME IMAGE',
      ownerOnly: true,
      changesSystem: true,
      restartExpected: true,
    });
    renderApps();
    await waitForAlphaFile();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Deployment' }));
    await user.click(await screen.findByRole('button', { name: 'Start' }));
    await user.click(await screen.findByRole('button', { name: 'Repair runtime image and retry' }));

    expect(await screen.findByText(/cannot verify the repair service state/i)).toBeVisible();
    expect(screen.queryByRole('dialog', { name: 'Repair runtime image and retry?' })).not.toBeInTheDocument();
    expect(mocks.runtimeRepair).not.toHaveBeenCalled();
  });

  it('keeps a lost-response replay truthful when the durable receipt is still running', async () => {
    mocks.listProjects.mockResolvedValue({
      projects: projects.map((project) => project.name === 'alpha'
        ? {
            ...project,
            deployment: {
              appId: 'app-alpha',
              deployType: 'fullstack',
              processStatus: 'stopped',
              runtimeManagement: 'portal-container' as const,
              statusSource: 'persisted-app' as const,
              supportedLifecycleActions: [...managedLifecycleActions],
              port: null,
              isActive: true,
            },
          }
        : project),
    });
    const recoveryReplay = {
      proof: 'v1.11111111-1111-4111-8111-111111111111.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      action: 'start' as const,
      projectIdentity: alphaIdentity,
      expectedAppId: 'app-alpha',
    };
    let initialFailureSent = false;
    let replayAttempts = 0;
    mocks.appProcess.mockImplementation(async (_projectName: string, action: string, replay?: unknown) => {
      if (action === 'status') {
        return {
          status: 'stopped',
          deployType: 'fullstack',
          runtimeManagement: 'portal-container',
          statusSource: 'persisted-app',
          supportedActions: ['start', 'status'],
          logs: [],
          restartCount: 0,
          persistedStatus: 'stopped',
          recoveryRequired: false,
        };
      }
      if (!replay && !initialFailureSent) {
        initialFailureSent = true;
        throw {
          response: {
            status: 503,
            data: {
              error: 'The Project runtime image is unavailable.',
              code: 'PROJECT_RUNTIME_IMAGE_UNAVAILABLE',
              recoveryAction: 'REPAIR_PROJECT_RUNTIME_IMAGE',
              recoveryReplay,
            },
          },
        };
      }
      replayAttempts += 1;
      if (replayAttempts === 1) {
        throw { isAxiosError: true, code: 'ERR_NETWORK', request: {} };
      }
      throw {
        response: {
          status: 409,
          data: {
            code: 'PROJECT_RUNTIME_RECOVERY_IN_PROGRESS',
            error: 'The recovered Project action is still reconciling.',
            detail: 'Refresh Deployment status before taking another action.',
            retryable: false,
          },
        },
      };
    });
    mocks.runtimeRepairStatus.mockReset().mockResolvedValue({
      state: 'ready',
      confirmationPhrase: 'REPAIR PROJECT RUNTIME IMAGE',
      ownerOnly: true,
      changesSystem: true,
      restartExpected: true,
    });
    renderApps();
    await waitForAlphaFile();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Deployment' }));
    await user.click(await screen.findByRole('button', { name: 'Start' }));
    await user.click(await screen.findByRole('button', { name: 'Repair runtime image and retry' }));

    await waitFor(() => expect(replayAttempts).toBe(2));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/still reconciling/i);
    expect(alert).toHaveTextContent(/will not execute this recovery twice/i);
    expect(alert).not.toHaveTextContent(/stale and was not replayed/i);
    expect(mocks.runtimeRepair).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'two consecutive transport losses',
      replayError: () => ({ isAxiosError: true, code: 'ERR_NETWORK', request: {} }),
      expectedAttempts: 2,
      expectedText: /still reconciling/i,
      rejectedText: /stale and was not replayed/i,
    },
    {
      label: 'a durable failed receipt',
      replayError: () => ({
        response: {
          status: 409,
          data: {
            code: 'PROJECT_RUNTIME_RECOVERY_FAILED',
            error: 'The recovered Project action failed after it was admitted.',
            detail: 'No second execution was started.',
          },
        },
      }),
      expectedAttempts: 1,
      expectedText: /failed after it was admitted/i,
      rejectedText: /stale and was not replayed/i,
    },
  ])('does not mislabel $label as stale', async ({
    replayError,
    expectedAttempts,
    expectedText,
    rejectedText,
  }) => {
    mocks.listProjects.mockResolvedValue({
      projects: projects.map((project) => project.name === 'alpha'
        ? {
            ...project,
            deployment: {
              appId: 'app-alpha',
              deployType: 'fullstack',
              processStatus: 'stopped',
              runtimeManagement: 'portal-container' as const,
              statusSource: 'persisted-app' as const,
              supportedLifecycleActions: [...managedLifecycleActions],
              port: null,
              isActive: true,
            },
          }
        : project),
    });
    const recoveryReplay = {
      proof: 'v1.11111111-1111-4111-8111-111111111111.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      action: 'start' as const,
      projectIdentity: alphaIdentity,
      expectedAppId: 'app-alpha',
    };
    let initialFailureSent = false;
    let replayAttempts = 0;
    mocks.appProcess.mockImplementation(async (_projectName: string, action: string, replay?: unknown) => {
      if (action === 'status') {
        return {
          status: 'stopped',
          deployType: 'fullstack',
          runtimeManagement: 'portal-container',
          statusSource: 'persisted-app',
          supportedActions: ['start', 'status'],
          logs: [],
          restartCount: 0,
          persistedStatus: 'stopped',
          recoveryRequired: false,
        };
      }
      if (!replay && !initialFailureSent) {
        initialFailureSent = true;
        throw {
          response: {
            status: 503,
            data: {
              error: 'The Project runtime image is unavailable.',
              code: 'PROJECT_RUNTIME_IMAGE_UNAVAILABLE',
              recoveryAction: 'REPAIR_PROJECT_RUNTIME_IMAGE',
              recoveryReplay,
            },
          },
        };
      }
      replayAttempts += 1;
      throw replayError();
    });
    mocks.runtimeRepairStatus.mockReset().mockResolvedValue({
      state: 'ready',
      confirmationPhrase: 'REPAIR PROJECT RUNTIME IMAGE',
      ownerOnly: true,
      changesSystem: true,
      restartExpected: true,
    });
    renderApps();
    await waitForAlphaFile();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Deployment' }));
    await user.click(await screen.findByRole('button', { name: 'Start' }));
    await user.click(await screen.findByRole('button', { name: 'Repair runtime image and retry' }));

    await waitFor(() => expect(replayAttempts).toBe(expectedAttempts));
    const alerts = await screen.findAllByRole('alert');
    const alert = alerts.find((candidate) => expectedText.test(candidate.textContent || ''));
    expect(alert).toBeDefined();
    if (!alert) throw new Error('Expected replay outcome alert was not rendered');
    expect(alert).toHaveTextContent(expectedText);
    expect(alert).not.toHaveTextContent(rejectedText);
    expect(mocks.runtimeRepair).not.toHaveBeenCalled();
  });

  it('does not call an unverified inventory refresh stale', async () => {
    const inventory = {
      projects: projects.map((project) => project.name === 'alpha'
        ? {
            ...project,
            deployment: {
              appId: 'app-alpha',
              deployType: 'fullstack',
              processStatus: 'stopped',
              runtimeManagement: 'portal-container' as const,
              statusSource: 'persisted-app' as const,
              supportedLifecycleActions: [...managedLifecycleActions],
              port: null,
              isActive: true,
            },
          }
        : project),
    };
    mocks.listProjects
      .mockResolvedValueOnce(inventory)
      .mockRejectedValueOnce(new Error('inventory transport unavailable'));
    const recoveryReplay = {
      proof: 'v1.11111111-1111-4111-8111-111111111111.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      action: 'start' as const,
      projectIdentity: alphaIdentity,
      expectedAppId: 'app-alpha',
    };
    let initialFailureSent = false;
    mocks.appProcess.mockImplementation(async (_projectName: string, action: string) => {
      if (action === 'status') {
        return {
          status: 'stopped',
          deployType: 'fullstack',
          runtimeManagement: 'portal-container',
          statusSource: 'persisted-app',
          supportedActions: ['start', 'status'],
          logs: [],
          restartCount: 0,
          persistedStatus: 'stopped',
          recoveryRequired: false,
        };
      }
      if (!initialFailureSent) {
        initialFailureSent = true;
        throw {
          response: {
            status: 503,
            data: {
              error: 'The Project runtime image is unavailable.',
              code: 'PROJECT_RUNTIME_IMAGE_UNAVAILABLE',
              recoveryAction: 'REPAIR_PROJECT_RUNTIME_IMAGE',
              recoveryReplay,
            },
          },
        };
      }
      throw new Error('replay must not be sent without verified inventory');
    });
    mocks.runtimeRepairStatus.mockReset().mockResolvedValue({
      state: 'ready',
      confirmationPhrase: 'REPAIR PROJECT RUNTIME IMAGE',
      ownerOnly: true,
      changesSystem: true,
      restartExpected: true,
    });
    renderApps();
    await waitForAlphaFile();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Deployment' }));
    await user.click(await screen.findByRole('button', { name: 'Start' }));
    await user.click(await screen.findByRole('button', { name: 'Repair runtime image and retry' }));

    const alerts = await screen.findAllByRole('alert');
    const alert = alerts.find((candidate) => /could not verify the current Project inventory/i.test(
      candidate.textContent || '',
    ));
    expect(alert).toBeDefined();
    if (!alert) throw new Error('Expected inventory verification alert was not rendered');
    expect(alert).toHaveTextContent(/could not verify the current Project inventory/i);
    expect(alert).not.toHaveTextContent(/stale and was not replayed/i);
    expect(mocks.appProcess).toHaveBeenCalledTimes(2);
    expect(mocks.runtimeRepair).not.toHaveBeenCalled();
  });

  it('keeps the runtime-image repair role-aware for a non-Owner', async () => {
    mocks.userRole = 'SUB_ADMIN';
    mocks.listProjects.mockResolvedValue({
      projects: projects.map((project) => project.name === 'alpha'
        ? {
            ...project,
            deployment: {
              appId: 'app-alpha',
              deployType: 'fullstack',
              processStatus: 'stopped',
              runtimeManagement: 'portal-container' as const,
              statusSource: 'persisted-app' as const,
              supportedLifecycleActions: [...managedLifecycleActions],
              port: null,
              isActive: true,
            },
          }
        : project),
    });
    const recoveryReplay = {
      proof: 'v1.11111111-1111-4111-8111-111111111111.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      action: 'start' as const,
      projectIdentity: alphaIdentity,
      expectedAppId: 'app-alpha',
    };
    mocks.appProcess.mockImplementation(async (_projectName: string, action: string) => {
      if (action === 'status') {
        return {
          status: 'stopped',
          deployType: 'fullstack',
          runtimeManagement: 'portal-container',
          statusSource: 'persisted-app',
          supportedActions: ['start', 'status'],
          logs: [],
          restartCount: 0,
          persistedStatus: 'stopped',
          recoveryRequired: false,
        };
      }
      throw {
        response: {
          status: 503,
          data: {
            error: 'The Project runtime image is unavailable.',
            code: 'PROJECT_RUNTIME_IMAGE_UNAVAILABLE',
            recoveryAction: 'REPAIR_PROJECT_RUNTIME_IMAGE',
            recoveryReplay,
          },
        },
      };
    });
    renderApps();
    await waitForAlphaFile();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Deployment' }));
    await user.click(await screen.findByRole('button', { name: 'Start' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/ask the portal owner to run this project runtime image repair/i);
    expect(alert).toHaveTextContent(/no repair has started/i);
    expect(within(alert).queryByRole('button', { name: 'Repair runtime image and retry' })).not.toBeInTheDocument();
    expect(mocks.runtimeRepairStatus).not.toHaveBeenCalled();
    expect(mocks.runtimeRepair).not.toHaveBeenCalled();
  });

  it('keeps first-deploy repair reachable without an App row and replays the exact source-bound Deploy', async () => {
    const firstDeployProjects = projects.map((project) => project.name === 'alpha'
      ? { ...project, detectedDeployType: 'fullstack' as const, deployedUrl: null }
      : project);
    mocks.listProjects.mockResolvedValue({ projects: firstDeployProjects });
    const recoveryReplay = {
      proof: 'v1.11111111-1111-4111-8111-111111111111.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      action: 'deploy' as const,
      projectIdentity: alphaIdentity,
      expectedAppId: null,
      expectedDeployType: 'fullstack' as const,
      sourceDigest: 'a'.repeat(64),
    };
    mocks.deploy
      .mockReset()
      .mockRejectedValueOnce({
        response: {
          status: 503,
          data: {
            error: 'The Project runtime image is unavailable.',
            code: 'PROJECT_RUNTIME_IMAGE_UNAVAILABLE',
            recoveryAction: 'REPAIR_PROJECT_RUNTIME_IMAGE',
            recoveryReplay,
          },
        },
      })
      .mockResolvedValueOnce({ deployType: 'fullstack', url: '/apps/alpha' });
    mocks.runtimeRepairStatus
      .mockReset()
      .mockResolvedValueOnce({
        state: 'unavailable',
        unavailableReason: 'image-missing',
        confirmationPhrase: 'REPAIR PROJECT RUNTIME IMAGE',
        ownerOnly: true,
        changesSystem: true,
        restartExpected: true,
      })
      .mockResolvedValueOnce({
        state: 'ready',
        confirmationPhrase: 'REPAIR PROJECT RUNTIME IMAGE',
        ownerOnly: true,
        changesSystem: true,
        restartExpected: true,
      });
    renderApps();
    await waitForAlphaFile();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Deploy' }));
    await user.click(await screen.findByRole('button', { name: 'Repair runtime image and retry' }));

    const confirmation = await screen.findByRole('dialog', { name: 'Repair runtime image and retry?' });
    await user.type(within(confirmation).getByLabelText(/REPAIR PROJECT RUNTIME IMAGE/), 'REPAIR PROJECT RUNTIME IMAGE');
    await user.click(within(confirmation).getByRole('button', { name: 'Repair runtime image' }));

    await waitFor(() => expect(mocks.deploy).toHaveBeenNthCalledWith(2, 'alpha', recoveryReplay));
    expect(mocks.appProcess).not.toHaveBeenCalledWith('alpha', 'start', expect.anything());
  });

  it('suppresses recovery controls for a non-allowlisted server action', async () => {
    mocks.listProjects.mockResolvedValue({
      projects: projects.map((project) => project.name === 'alpha'
        ? {
            ...project,
            deployment: {
              appId: 'app-alpha',
              deployType: 'fullstack',
              processStatus: 'stopped',
              runtimeManagement: 'portal-container' as const,
              statusSource: 'persisted-app' as const,
              supportedLifecycleActions: [...managedLifecycleActions],
              port: null,
              isActive: true,
            },
          }
        : project),
    });
    mocks.appProcess.mockImplementation(async (_projectName: string, action: string) => {
      if (action === 'status') {
        return {
          status: 'stopped',
          deployType: 'fullstack',
          runtimeManagement: 'portal-container',
          statusSource: 'persisted-app',
          supportedActions: ['start', 'status'],
          logs: [],
          restartCount: 0,
          persistedStatus: 'stopped',
          recoveryRequired: false,
        };
      }
      throw {
        response: {
          status: 503,
          data: {
            error: 'Runtime unavailable',
            code: 'PROJECT_RUNTIME_START_FAILED',
            recoveryAction: 'REPAIR_PROJECT_RUNTIME_IMAGE',
            recoveryReplay: {
              proof: 'v1.11111111-1111-4111-8111-111111111111.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
              action: 'start',
              projectIdentity: alphaIdentity,
              expectedAppId: 'app-alpha',
            },
            recoveryActionUrl: 'https://untrusted.invalid/update',
          },
        },
      };
    });
    renderApps();
    await waitForAlphaFile();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Deployment' }));
    await user.click(await screen.findByRole('button', { name: 'Start' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Runtime unavailable');
    expect(alert).toHaveTextContent('PROJECT_RUNTIME_START_FAILED');
    expect(alert).not.toHaveTextContent('untrusted.invalid');
    expect(within(alert).queryByRole('button', { name: 'Repair runtime image and retry' })).not.toBeInTheDocument();
  });

  it('uses the server classification for runtime projects instead of filename guesses', async () => {
    mocks.listProjects.mockResolvedValue({
      projects: projects.map((project) => project.name === 'alpha'
        ? { ...project, detectedDeployType: 'runtime' as const }
        : project),
    });
    mocks.getTree.mockResolvedValue({
      tree: [
        { name: 'package.json', type: 'file', path: 'package.json' },
        { name: 'cli.ts', type: 'file', path: 'cli.ts' },
      ],
      currentPath: '',
      identity: alphaIdentity,
    });
    renderApps('/projects?project=alpha&file=cli.ts');
    await waitFor(() => expect(mocks.readFile).toHaveBeenCalledWith('alpha', 'cli.ts'));

    expect(screen.getByRole('button', { name: 'Check' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Run' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Preview' })).not.toBeInTheDocument();
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

  it('shows a durable retry state instead of claiming the project inventory is empty', async () => {
    mocks.listProjects
      .mockRejectedValueOnce(new Error('Inventory temporarily unavailable'))
      .mockResolvedValueOnce({ projects });

    renderApps('/projects', false);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Projects couldn’t be loaded');
    expect(alert).toHaveTextContent('Inventory temporarily unavailable');
    expect(screen.queryByText('No projects yet')).not.toBeInTheDocument();

    await userEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: 'alpha' })).toBeVisible();
    await waitFor(() => expect(screen.queryByText('Projects couldn’t be loaded')).not.toBeInTheDocument());
  });

  it('keeps the newest project inventory when overlapping refreshes settle out of order', async () => {
    const firstInventory = deferred<{ projects: typeof projects }>();
    const blockedProjects = [{
      ...projects[0],
      availability: {
        available: false as const,
        code: 'PROJECT_IDENTITY_RECONCILIATION_REQUIRED' as const,
        message: 'Newest inventory says this project needs reconciliation.',
        action: 'RECONCILE_PROJECT_IDENTITY' as const,
        retryable: false,
      },
      destructiveActions: {
        allowed: false,
        reason: 'Newest inventory says this project needs reconciliation.',
      },
    }];
    mocks.listProjects
      .mockReturnValueOnce(firstInventory.promise)
      .mockResolvedValueOnce({ projects: blockedProjects });
    const user = userEvent.setup();

    renderApps('/projects', false);
    await waitFor(() => expect(mocks.listProjects).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole('button', { name: 'Refresh projects' }));

    const newestProject = await screen.findByRole('button', { name: 'alpha' });
    expect(newestProject).toBeDisabled();
    expect(screen.getByText('Newest inventory says this project needs reconciliation.')).toBeVisible();

    await act(async () => {
      firstInventory.resolve({ projects });
      await firstInventory.promise;
    });

    expect(screen.getByRole('button', { name: 'alpha' })).toBeDisabled();
    expect(screen.getByText('Newest inventory says this project needs reconciliation.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'beta' })).not.toBeInTheDocument();
  });

  it('shows file-load recovery without presenting a failed tree as an empty project', async () => {
    mocks.getTree
      .mockRejectedValueOnce(new Error('Tree read failed'))
      .mockResolvedValueOnce({
        tree: alphaTree,
        currentPath: '',
        identity: alphaIdentity,
      });

    renderApps('/projects?project=alpha');

    const fileRegion = await screen.findByRole('region', { name: 'Files for alpha' });
    const alert = await within(fileRegion).findByRole('alert');
    expect(alert).toHaveTextContent('Files couldn’t be loaded');
    expect(alert).toHaveTextContent('Tree read failed');
    expect(within(fileRegion).queryByText('No files yet')).not.toBeInTheDocument();

    await userEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await within(fileRegion).findByRole('button', { name: 'one.ts' })).toBeVisible();
    await waitFor(() => expect(within(fileRegion).queryByText('Files couldn’t be loaded')).not.toBeInTheDocument());
  });

  it('keeps a blocked project visible with its recovery reason and disables Project Chat', async () => {
    mocks.listProjects.mockResolvedValueOnce({
      projects: [{
        ...projects[0],
        availability: {
          available: false as const,
          code: 'PROJECT_IDENTITY_RECONCILIATION_REQUIRED' as const,
          message: 'This project directory changed outside Portal.',
          action: 'RECONCILE_PROJECT_IDENTITY' as const,
          retryable: false,
        },
        destructiveActions: {
          allowed: false,
          reason: 'This project directory changed outside Portal.',
        },
      }],
    });

    renderApps('/projects', false);

    const project = await screen.findByRole('button', { name: 'alpha' });
    expect(project).toBeDisabled();
    expect(screen.getByText('This project directory changed outside Portal.')).toBeVisible();
    expect(screen.getByText('Administrator reconciliation is required.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Open Project Chat' })).not.toBeInTheDocument();
  });

  it('shows dependency quarantine to everyone but exposes repair only to Owners', async () => {
    mocks.userRole = 'MEMBER';
    mocks.listProjects.mockResolvedValueOnce({ projects: [quarantinedAlpha] });

    renderApps('/projects', false);

    expect(await screen.findByText('Portal contained an interrupted dependency promotion.')).toBeVisible();
    expect(screen.getByText(/Do not edit or run this Project/i)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Repair dependency update' })).not.toBeInTheDocument();
    expect(mocks.dependencyRepairStatus).not.toHaveBeenCalled();
  });

  it('shows the exact dependency repair contract and blocks submission without a fresh backup', async () => {
    mocks.listProjects.mockResolvedValueOnce({ projects: [quarantinedAlpha] });
    mocks.dependencyRepairStatus.mockResolvedValueOnce(dependencyRepairStatus());
    const user = userEvent.setup();

    renderApps('/projects', false);
    await user.click(await screen.findByRole('button', { name: 'Repair dependency update' }));

    const dialog = await screen.findByRole('dialog', { name: /Repair dependency update for alpha/i });
    expect(within(dialog).getByText(/Project identity project-alpha-id, generation 3/i)).toBeVisible();
    expect(within(dialog).getByText('Fresh comprehensive backup required')).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Force forward staged generation' })).toBeDisabled();
    expect(mocks.forceForwardDependencyRepair).not.toHaveBeenCalled();
  });

  it('shows a pre-go startup handoff without offering another repair or current-process poll', async () => {
    mocks.listProjects.mockResolvedValueOnce({ projects: [quarantinedAlpha] });
    mocks.dependencyRepairStatus.mockResolvedValueOnce(dependencyRepairStatus({
      retryable: false,
      statusRetryable: false,
      restartRequired: true,
    }));
    const user = userEvent.setup();

    renderApps('/projects', false);
    await user.click(await screen.findByRole('button', { name: 'Repair dependency update' }));

    const dialog = await screen.findByRole('dialog', { name: /Repair dependency update for alpha/i });
    expect(within(dialog).getByText('Recovery assigned to Portal startup')).toBeVisible();
    expect(within(dialog).getByText('Controlled Portal restart pending')).toBeVisible();
    expect(within(dialog).queryByRole('button', { name: 'Force forward staged generation' })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Check repair status' })).not.toBeInTheDocument();
    expect(mocks.dependencyRepairStatus).toHaveBeenCalledTimes(1);
    expect(mocks.forceForwardDependencyRepair).not.toHaveBeenCalled();
  });

  it('fails closed when the repair contract names a different Project generation', async () => {
    mocks.listProjects.mockResolvedValueOnce({ projects: [quarantinedAlpha] });
    mocks.dependencyRepairStatus.mockResolvedValueOnce(dependencyRepairStatus({
      project: { id: alphaIdentity.id, name: 'alpha', generation: alphaIdentity.generation + 1 },
    }));
    const user = userEvent.setup();

    renderApps('/projects', false);
    await user.click(await screen.findByRole('button', { name: 'Repair dependency update' }));

    await waitFor(() => expect(mocks.dependencyRepairStatus).toHaveBeenCalledWith('alpha'));
    expect(screen.queryByRole('dialog', { name: /Repair dependency update/i })).not.toBeInTheDocument();
    expect(mocks.forceForwardDependencyRepair).not.toHaveBeenCalled();
  });

  it('refreshes inventory when the quarantine cleared before the Owner opened repair', async () => {
    mocks.listProjects
      .mockResolvedValueOnce({ projects: [quarantinedAlpha] })
      .mockResolvedValueOnce({ projects });
    mocks.dependencyRepairStatus.mockResolvedValueOnce(dependencyRepairStatus({
      state: 'NOT_QUARANTINED',
      project: null,
      promotion: null,
      repair: null,
      backup: { requiredAfter: null, eligible: false, pinned: false },
      retryable: false,
      statusRetryable: false,
      restartRequired: false,
    }));
    const user = userEvent.setup();

    renderApps('/projects', false);
    await user.click(await screen.findByRole('button', { name: 'Repair dependency update' }));

    await waitFor(() => expect(mocks.listProjects).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('dialog', { name: /Repair dependency update/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'alpha' })).toBeEnabled();
    expect(mocks.forceForwardDependencyRepair).not.toHaveBeenCalled();
  });

  it('surfaces a definitive backup-gate rejection without treating it as a lost response', async () => {
    const eligible = dependencyRepairStatus({
      backup: {
        requiredAfter: '2026-08-12T08:00:00.000Z',
        eligible: true,
        filename: 'portal-complete.tar.gz',
        createdAt: '2026-08-12T08:05:00.000Z',
      },
    });
    mocks.listProjects.mockResolvedValueOnce({ projects: [quarantinedAlpha] });
    mocks.dependencyRepairStatus
      .mockResolvedValueOnce(eligible)
      .mockResolvedValueOnce(eligible);
    mocks.forceForwardDependencyRepair.mockRejectedValueOnce({
      response: {
        status: 409,
        data: {
          code: 'PROJECT_DEPENDENCY_REPAIR_BACKUP_REQUIRED',
          error: 'The verified backup is no longer eligible.',
        },
      },
    });
    const user = userEvent.setup();

    renderApps('/projects', false);
    await user.click(await screen.findByRole('button', { name: 'Repair dependency update' }));
    const dialog = await screen.findByRole('dialog', { name: /Repair dependency update for alpha/i });
    await user.type(within(dialog).getByRole('textbox'), 'FORCE FORWARD alpha');
    await user.click(within(dialog).getByRole('button', { name: 'Force forward staged generation' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('verified backup is no longer eligible');
    expect(mocks.dependencyRepairStatus).toHaveBeenCalledTimes(2);
    expect(mocks.forceForwardDependencyRepair).toHaveBeenCalledTimes(1);
  });

  it('rediscovers one live repair after reload and resumes only read-only reconciliation', async () => {
    const repairId = '22222222-2222-4222-8222-222222222222';
    const active = dependencyRepairStatus({
      state: 'PROMOTING',
      repair: {
        repairId,
        status: 'PROMOTING',
        phase: 'GO_BIT',
        startedAt: '2026-08-12T08:06:00.000Z',
        completedAt: null,
      },
      backup: {
        requiredAfter: '2026-08-12T08:00:00.000Z',
        eligible: false,
        pinned: true,
        filename: 'portal-complete.tar.gz',
        createdAt: '2026-08-12T08:05:00.000Z',
      },
      retryable: false,
      statusRetryable: true,
      restartRequired: false,
    });
    const statusRead = deferred<Record<string, unknown>>();
    mocks.listProjects
      .mockRejectedValueOnce(new Error('Project inventory is fenced during dependency repair.'))
      .mockResolvedValueOnce({ projects });
    mocks.activeDependencyRepairs.mockResolvedValueOnce({
      repairs: [active],
      count: 1,
      unavailable: false,
    });
    mocks.dependencyRepairStatus.mockReturnValueOnce(statusRead.promise);

    renderApps('/projects', false, true);

    const dialog = await screen.findByRole('dialog', { name: /Repair dependency update for alpha/i });
    expect(within(dialog).getByText('Recovery backup pinned to this repair')).toBeVisible();
    expect(within(dialog).queryByText('Controlled Portal restart pending')).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Force forward staged generation' })).not.toBeInTheDocument();
    expect(mocks.forceForwardDependencyRepair).not.toHaveBeenCalled();

    statusRead.resolve(dependencyRepairStatus({
      state: 'COMPLETE',
      repair: {
        repairId,
        status: 'APPLIED',
        phase: 'COMPLETE',
        startedAt: '2026-08-12T08:06:00.000Z',
        completedAt: '2026-08-12T08:07:00.000Z',
      },
      promotion: {
        operationId: '11111111-1111-4111-8111-111111111111',
        manifestDigest: 'a'.repeat(64),
        status: 'APPLIED',
      },
      backup: {
        requiredAfter: '2026-08-12T08:00:00.000Z',
        eligible: false,
        pinned: false,
        filename: 'portal-complete.tar.gz',
        createdAt: '2026-08-12T08:05:00.000Z',
      },
      retryable: false,
      statusRetryable: false,
      restartRequired: false,
    }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Repair dependency update/i })).not.toBeInTheDocument());
    expect(mocks.activeDependencyRepairs).toHaveBeenCalledTimes(1);
    expect(mocks.forceForwardDependencyRepair).not.toHaveBeenCalled();
    expect(mocks.listProjects).toHaveBeenCalledTimes(3);
  });

  it('rediscovers a startup-owned repair after reload without polling the retired process', async () => {
    const repairId = '22222222-2222-4222-8222-222222222222';
    const active = dependencyRepairStatus({
      state: 'PROMOTING',
      repair: {
        repairId,
        status: 'PROMOTING',
        phase: 'GO_BIT',
        startedAt: '2026-08-12T08:06:00.000Z',
        completedAt: null,
      },
      backup: {
        requiredAfter: '2026-08-12T08:00:00.000Z',
        eligible: false,
        pinned: true,
        filename: 'portal-complete.tar.gz',
        createdAt: '2026-08-12T08:05:00.000Z',
      },
      retryable: false,
      statusRetryable: false,
      restartRequired: true,
    });
    mocks.listProjects.mockRejectedValueOnce(new Error('Project inventory is fenced during dependency repair.'));
    mocks.activeDependencyRepairs.mockResolvedValueOnce({
      repairs: [active],
      count: 1,
      unavailable: false,
    });

    renderApps('/projects', false, true);

    const dialog = await screen.findByRole('dialog', { name: /Repair dependency update for alpha/i });
    expect(within(dialog).getByText('Recovery assigned to Portal startup')).toBeVisible();
    expect(within(dialog).getByText('Controlled Portal restart pending')).toBeVisible();
    expect(within(dialog).queryByRole('button', { name: 'Check repair status' })).not.toBeInTheDocument();
    expect(mocks.dependencyRepairStatus).not.toHaveBeenCalled();
    expect(mocks.forceForwardDependencyRepair).not.toHaveBeenCalled();
  });

  it('reconciles an indeterminate 503 without submitting the repair twice', async () => {
    const eligible = dependencyRepairStatus({
      backup: {
        requiredAfter: '2026-08-12T08:00:00.000Z',
        eligible: true,
        filename: 'portal-complete.tar.gz',
        createdAt: '2026-08-12T08:05:00.000Z',
      },
    });
    let submittedRepairId = '';
    mocks.listProjects
      .mockResolvedValueOnce({ projects: [quarantinedAlpha] })
      .mockResolvedValueOnce({ projects });
    mocks.dependencyRepairStatus
      .mockResolvedValueOnce(eligible)
      .mockResolvedValueOnce(eligible)
      .mockImplementation(async () => dependencyRepairStatus({
        state: 'COMPLETE',
        repair: {
          repairId: submittedRepairId,
          status: 'APPLIED',
          phase: 'COMPLETE',
          startedAt: '2026-08-12T08:06:00.000Z',
          completedAt: '2026-08-12T08:07:00.000Z',
        },
        backup: {
          requiredAfter: '2026-08-12T08:00:00.000Z',
          eligible: true,
          filename: 'portal-complete.tar.gz',
          createdAt: '2026-08-12T08:05:00.000Z',
        },
      }));
    mocks.forceForwardDependencyRepair.mockImplementationOnce(async (
      _projectName: string,
      request: { repairId: string },
    ) => {
      submittedRepairId = request.repairId;
      throw {
        response: {
          status: 503,
          data: {
            code: 'PROJECT_DEPENDENCY_REPAIR_INDETERMINATE',
            error: 'Portal could not prove whether the repair go-bit committed.',
          },
        },
      };
    });
    const user = userEvent.setup();

    renderApps('/projects', false);
    await user.click(await screen.findByRole('button', { name: 'Repair dependency update' }));
    const dialog = await screen.findByRole('dialog', { name: /Repair dependency update for alpha/i });
    await user.type(within(dialog).getByRole('textbox'), 'FORCE FORWARD alpha');
    await user.click(within(dialog).getByRole('button', { name: 'Force forward staged generation' }));

    await waitFor(() => expect(mocks.forceForwardDependencyRepair).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Repair dependency update/i })).not.toBeInTheDocument());
    expect(mocks.dependencyRepairStatus).toHaveBeenCalledTimes(3);
    expect(mocks.listProjects).toHaveBeenCalledTimes(2);
  });

  it('reconciles a lost repair response by exact receipt before reporting the Project ACTIVE', async () => {
    const eligible = dependencyRepairStatus({
      backup: {
        requiredAfter: '2026-08-12T08:00:00.000Z',
        eligible: true,
        filename: 'portal-complete.tar.gz',
        createdAt: '2026-08-12T08:05:00.000Z',
      },
    });
    let submittedRepairId = '';
    mocks.listProjects
      .mockResolvedValueOnce({ projects: [quarantinedAlpha] })
      .mockResolvedValueOnce({ projects });
    mocks.dependencyRepairStatus
      .mockResolvedValueOnce(eligible)
      .mockResolvedValueOnce(eligible)
      .mockImplementation(async () => dependencyRepairStatus({
        state: 'COMPLETE',
        repair: {
          repairId: submittedRepairId,
          status: 'APPLIED',
          phase: 'COMPLETE',
          startedAt: '2026-08-12T08:06:00.000Z',
          completedAt: '2026-08-12T08:07:00.000Z',
        },
        backup: {
          requiredAfter: '2026-08-12T08:00:00.000Z',
          eligible: true,
          filename: 'portal-complete.tar.gz',
          createdAt: '2026-08-12T08:05:00.000Z',
        },
      }));
    mocks.forceForwardDependencyRepair.mockImplementation(async (
      _projectName: string,
      request: { repairId: string },
    ) => {
      submittedRepairId = request.repairId;
      throw new Error('Project dependency repair status is malformed');
    });
    const user = userEvent.setup();

    renderApps('/projects', false);
    await user.click(await screen.findByRole('button', { name: 'Repair dependency update' }));
    const dialog = await screen.findByRole('dialog', { name: /Repair dependency update for alpha/i });
    await user.type(within(dialog).getByRole('textbox'), 'FORCE FORWARD alpha');
    await user.click(within(dialog).getByRole('button', { name: 'Force forward staged generation' }));

    await waitFor(() => expect(mocks.forceForwardDependencyRepair).toHaveBeenCalledTimes(1));
    expect(mocks.forceForwardDependencyRepair).toHaveBeenCalledWith('alpha', {
      repairId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
      expectedProjectIdentityId: alphaIdentity.id,
      expectedProjectIdentityGeneration: alphaIdentity.generation,
      expectedPromotionOperationId: '11111111-1111-4111-8111-111111111111',
      expectedManifestDigest: 'a'.repeat(64),
      confirmation: 'FORCE FORWARD alpha',
    });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Repair dependency update/i })).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'alpha' })).toBeEnabled();
    expect(mocks.listProjects).toHaveBeenCalledTimes(2);
  });

  it('refuses a blocked Project deep link without loading its file tree', async () => {
    mocks.listProjects.mockResolvedValueOnce({
      projects: [{
        ...projects[0],
        availability: {
          available: false as const,
          code: 'PROJECT_IDENTITY_RECONCILIATION_REQUIRED' as const,
          message: 'This project directory changed outside Portal.',
          action: 'RECONCILE_PROJECT_IDENTITY' as const,
          retryable: false,
        },
        destructiveActions: {
          allowed: false,
          reason: 'This project directory changed outside Portal.',
        },
      }],
    });

    renderApps('/projects?project=alpha');

    expect(await screen.findByRole('button', { name: 'alpha' })).toBeDisabled();
    await waitFor(() => expect(screen.getByTestId('apps-route')).toHaveTextContent('/projects'));
    expect(mocks.getTree).not.toHaveBeenCalledWith('alpha');
  });

  it('does not restore a blocked Project from local storage', async () => {
    localStorage.setItem('projects-last-selected', 'alpha');
    mocks.listProjects.mockResolvedValueOnce({
      projects: [{
        ...projects[0],
        availability: {
          available: false as const,
          code: 'PROJECT_LIFECYCLE_RECONCILIATION_REQUIRED' as const,
          message: 'Portal found conflicting lifecycle records for this project.',
          action: 'RECONCILE_PROJECT_LIFECYCLE' as const,
          retryable: false,
        },
        destructiveActions: {
          allowed: false,
          reason: 'Portal found conflicting lifecycle records for this project.',
        },
      }],
    });

    renderApps('/projects', false);

    expect(await screen.findByRole('button', { name: 'alpha' })).toBeDisabled();
    await waitFor(() => expect(localStorage.getItem('projects-last-selected')).toBeNull());
    expect(mocks.getTree).not.toHaveBeenCalledWith('alpha');
  });

  it('keeps Project Chat qualification owned until dismissal, then releases it while preparation continues', async () => {
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

    await user.click(close);
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Project Chat alpha' })).not.toBeInTheDocument());
    const releasedUnload = new Event('beforeunload', { cancelable: true });
    expect(window.dispatchEvent(releasedUnload)).toBe(true);

    await user.click(screen.getByRole('button', { name: 'beta' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'beta' })).toHaveAttribute('aria-current', 'page'));
    expect(mocks.getTree).toHaveBeenCalledWith('beta');

    await act(async () => {
      qualification.resolve({ ok: true });
      await qualification.promise;
    });
    expect(mocks.projectQualification).toHaveBeenCalledTimes(1);
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
    mocks.listProjects.mockResolvedValue({
      projects: projects.map((project) => project.name === 'alpha'
        ? { ...project, detectedDeployType: 'runtime' as const }
        : project),
    });
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
    expect(mocks.deleteProject).toHaveBeenCalledWith('alpha', alphaIdentity);
    expect(await within(dialog).findByRole('button', { name: 'Deleting project…' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByText('Deleting Project')).not.toBeInTheDocument();
    expect(screen.queryByText(/Retiring "alpha"/)).not.toBeInTheDocument();

    await act(async () => {
      deletion.resolve({ ok: true });
      await deletion.promise;
    });
    await waitFor(() => expect(screen.queryByRole('alertdialog', { name: '⚠️ Delete project "alpha"?' })).not.toBeInTheDocument());
  });

  it('refuses a confirmed Project deletion after inventory reports a replacement identity', async () => {
    const replacementIdentity = { id: 'project-alpha-replacement', generation: 1 };
    mocks.listProjects
      .mockResolvedValueOnce({ projects })
      .mockResolvedValue({
        projects: projects.map((project) => project.name === 'alpha'
          ? { ...project, identity: replacementIdentity }
          : project),
      });
    renderApps();
    await waitForAlphaFile();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Delete project alpha' }));
    const dialog = screen.getByRole('alertdialog', { name: '⚠️ Delete project "alpha"?' });
    const refreshButton = document.querySelector<HTMLButtonElement>('button[aria-label="Refresh projects"]');
    expect(refreshButton).not.toBeNull();
    fireEvent.click(refreshButton!);
    await waitFor(() => expect(mocks.listProjects).toHaveBeenCalledTimes(2));
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

    expect(await within(dialog).findByText(/project identity changed/i)).toBeVisible();
    expect(mocks.deleteProject).not.toHaveBeenCalled();
  });

  it('rechecks Project identity after deferred autosave settles before deleting', async () => {
    const autosave = deferred<{ ok: boolean }>();
    const replacementIdentity = { id: 'project-alpha-replacement-after-save', generation: 1 };
    mocks.writeFile.mockReturnValueOnce(autosave.promise);
    mocks.listProjects
      .mockResolvedValueOnce({ projects })
      .mockResolvedValue({
        projects: projects.map((project) => project.name === 'alpha'
          ? { ...project, identity: replacementIdentity }
          : project),
      });
    renderApps();
    await waitForAlphaFile();

    const user = userEvent.setup();
    fireEvent.change(screen.getByLabelText('Mock project editor'), {
      target: { value: 'alpha:changed before delete' },
    });
    await user.click(screen.getByRole('button', { name: 'Delete project alpha' }));
    const dialog = screen.getByRole('alertdialog', { name: '⚠️ Delete project "alpha"?' });
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(mocks.writeFile).toHaveBeenCalledWith(
      'alpha',
      'one.ts',
      'alpha:changed before delete',
    ));
    expect(screen.getByTestId('route-operation-owner')).toHaveTextContent('owned');

    const refreshButton = document.querySelector<HTMLButtonElement>('button[aria-label="Refresh projects"]');
    expect(refreshButton).not.toBeNull();
    fireEvent.click(refreshButton!);
    await waitFor(() => expect(mocks.listProjects).toHaveBeenCalledTimes(2));

    await act(async () => {
      autosave.resolve({ ok: true });
      await autosave.promise;
    });

    expect(await within(dialog).findByText(/project identity changed/i)).toBeVisible();
    expect(mocks.deleteProject).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId('route-operation-owner')).toHaveTextContent('idle'));
    expect(within(dialog).getByRole('button', { name: 'Delete' })).toBeEnabled();
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

  it('creates a share with visitor slots and an enabled shared API throttle, then restores unlimited defaults', async () => {
    renderApps('/projects?project=alpha');
    await waitFor(() => expect(screen.getByRole('button', { name: 'alpha' })).toHaveAttribute('aria-current', 'page'));
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Share' }));

    expect(await screen.findByRole('button', { name: 'Unlimited visitor slots' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('checkbox', { name: 'Limit share link API requests' })).not.toBeChecked();
    expect(screen.getByText(/Each slot grants one browser up to 30 days of access while the link remains active/i)).toBeVisible();
    expect(screen.getByText(/dynamic API requests only; static files are excluded/i)).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Small audience: 10 visitor slots' }));
    await user.click(screen.getByRole('checkbox', { name: 'Limit share link API requests' }));
    await user.type(screen.getByLabelText('Share link API request limit'), '25');
    await user.selectOptions(screen.getByLabelText('Share link API request window'), '300');
    await user.click(screen.getByRole('button', { name: 'Create Public Link' }));

    await waitFor(() => expect(mocks.share).toHaveBeenCalledWith('alpha', {
      isPublic: true,
      maxUses: 10,
      rateLimitMaxRequests: 25,
      rateLimitWindowSeconds: 300,
    }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Unlimited visitor slots' })).toHaveAttribute('aria-pressed', 'true'));
    expect(screen.getByLabelText('Share link visitor slots')).toHaveValue(null);
    expect(screen.getByRole('checkbox', { name: 'Limit share link API requests' })).not.toBeChecked();
    expect(screen.queryByLabelText('Share link API request limit')).not.toBeInTheDocument();
  });

  it('blocks a multibyte share password above the backend UTF-8 byte ceiling', async () => {
    renderApps('/projects?project=alpha');
    await waitFor(() => expect(screen.getByRole('button', { name: 'alpha' })).toHaveAttribute('aria-current', 'page'));
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Share' }));
    await user.click(screen.getByRole('button', { name: 'Password' }));

    const password = 'é'.repeat(37);
    const passwordInput = screen.getByLabelText('Share link password');
    const confirmationInput = screen.getByLabelText('Confirm share link password');
    expect(passwordInput).toHaveAttribute('maxlength', '72');
    fireEvent.change(passwordInput, { target: { value: password } });
    fireEvent.change(confirmationInput, { target: { value: password } });

    expect(passwordInput).toHaveAttribute('aria-invalid', 'true');
    expect(passwordInput).toHaveAttribute('aria-describedby', expect.stringContaining('share-password-byte-error'));
    const byteError = screen.getByText('Password is 74 UTF-8 bytes; maximum 72. Shorten it by 2 bytes.');
    expect(byteError).toHaveAttribute('id', 'share-password-byte-error');
    expect(byteError).toHaveAttribute('role', 'alert');
    expect(screen.getByRole('button', { name: 'Create Password-Protected Link' })).toBeDisabled();
    expect(mocks.share).not.toHaveBeenCalled();

    fireEvent.change(passwordInput, { target: { value: 'correct horse battery staple' } });
    fireEvent.change(confirmationInput, { target: { value: 'correct horse battery stapler' } });
    expect(confirmationInput).toHaveAttribute('aria-invalid', 'true');
    expect(confirmationInput).toHaveAttribute('aria-describedby', 'share-password-mismatch-error');
    const mismatchError = screen.getByText('Passwords do not match.');
    expect(mismatchError).toHaveAttribute('id', 'share-password-mismatch-error');
    expect(mismatchError).toHaveAttribute('role', 'alert');
  });

  it('rejects out-of-range share policies inline and displays configured policies on retained links', async () => {
    mocks.listShares.mockResolvedValue({
      shares: [{
        id: 'policy-link',
        token: 'policy-token',
        isActive: true,
        isPublic: true,
        currentUses: 2,
        maxUses: 10,
        rateLimitMaxRequests: 25,
        rateLimitWindowSeconds: 300,
        expiresAt: null,
        createdAt: '2026-07-21T12:00:00.000Z',
      }],
    });
    renderApps('/projects?project=alpha');
    await waitFor(() => expect(screen.getByRole('button', { name: 'alpha' })).toHaveAttribute('aria-current', 'page'));
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Share' }));

    expect(await screen.findByText('2 / 10 visitor slots used')).toBeVisible();
    expect(screen.getByText('25 API requests / 5 minutes · shared')).toBeVisible();

    await user.type(screen.getByLabelText('Share link visitor slots'), '1000001');
    expect(screen.getByLabelText('Share link visitor slots')).toHaveAttribute('aria-invalid', 'true');
    await user.click(screen.getByRole('button', { name: 'Create Public Link' }));
    expect(await screen.findByText('Visitor slots must be a whole number from 1 to 1,000,000', { selector: '#share-create-error' })).toHaveAttribute('role', 'alert');
    expect(mocks.share).not.toHaveBeenCalled();

    await user.clear(screen.getByLabelText('Share link visitor slots'));
    await user.click(screen.getByRole('checkbox', { name: 'Limit share link API requests' }));
    await user.type(screen.getByLabelText('Share link API request limit'), '1000001');
    expect(screen.getByLabelText('Share link API request limit')).toHaveAttribute('aria-invalid', 'true');
    await user.click(screen.getByRole('button', { name: 'Create Public Link' }));
    expect(await screen.findByText('API request limit must be a whole number from 1 to 1,000,000', { selector: '#share-create-error' })).toHaveAttribute('role', 'alert');
    expect(mocks.share).not.toHaveBeenCalled();
  });

  it('does not let a delayed older share success replace a newer authoritative list', async () => {
    const olderRead = deferred<{ shares: Array<Record<string, unknown>> }>();
    const newerRead = deferred<{ shares: Array<Record<string, unknown>> }>();
    const share = (id: string, token: string) => ({
      id,
      token,
      isActive: true,
      isPublic: true,
      currentUses: 0,
      maxUses: null,
      rateLimitMaxRequests: null,
      rateLimitWindowSeconds: null,
      expiresAt: null,
      createdAt: '2026-07-21T12:00:00.000Z',
    });
    mocks.listShares
      .mockReturnValueOnce(olderRead.promise)
      .mockReturnValueOnce(newerRead.promise);

    renderApps('/projects?project=alpha');
    await waitFor(() => expect(screen.getByRole('button', { name: 'alpha' })).toHaveAttribute('aria-current', 'page'));
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Share' }));
    await waitFor(() => expect(mocks.listShares).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole('button', { name: 'Close sharing panel' }));
    await user.click(screen.getByRole('button', { name: 'Share' }));
    await waitFor(() => expect(mocks.listShares).toHaveBeenCalledTimes(2));

    await act(async () => {
      newerRead.resolve({ shares: [share('newer-link', 'newer-token')] });
      await newerRead.promise;
    });
    expect(await screen.findByText('/share/newer-token')).toBeVisible();

    await act(async () => {
      olderRead.resolve({ shares: [share('older-link', 'older-token')] });
      await olderRead.promise;
    });
    expect(screen.getByText('/share/newer-token')).toBeVisible();
    expect(screen.queryByText('/share/older-token')).not.toBeInTheDocument();
  });

  it('does not let a delayed older share failure clear a newer authoritative list', async () => {
    const olderRead = deferred<{ shares: Array<Record<string, unknown>> }>();
    const newerRead = deferred<{ shares: Array<Record<string, unknown>> }>();
    mocks.listShares
      .mockReturnValueOnce(olderRead.promise)
      .mockReturnValueOnce(newerRead.promise);

    renderApps('/projects?project=alpha');
    await waitFor(() => expect(screen.getByRole('button', { name: 'alpha' })).toHaveAttribute('aria-current', 'page'));
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Share' }));
    await waitFor(() => expect(mocks.listShares).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole('button', { name: 'Close sharing panel' }));
    await user.click(screen.getByRole('button', { name: 'Share' }));
    await waitFor(() => expect(mocks.listShares).toHaveBeenCalledTimes(2));

    await act(async () => {
      newerRead.resolve({
        shares: [{
          id: 'newer-link',
          token: 'newer-token',
          isActive: true,
          isPublic: true,
          currentUses: 0,
          maxUses: null,
          rateLimitMaxRequests: null,
          rateLimitWindowSeconds: null,
          expiresAt: null,
          createdAt: '2026-07-21T12:00:00.000Z',
        }],
      });
      await newerRead.promise;
    });
    expect(await screen.findByText('/share/newer-token')).toBeVisible();

    await act(async () => {
      olderRead.reject(new Error('Delayed obsolete share failure.'));
      await olderRead.promise.catch(() => undefined);
    });
    expect(screen.getByText('/share/newer-token')).toBeVisible();
    expect(screen.queryByText(/Delayed obsolete share failure/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry refresh' })).not.toBeInTheDocument();
  });

  it('rechecks share ownership after autosave settles before switching projects', async () => {
    const autosave = deferred<{ ok: boolean }>();
    const mutation = deferred<{ ok: boolean }>();
    const activeShare = {
      id: 'autosave-share',
      token: 'autosave-token',
      isActive: true,
      isPublic: true,
      currentUses: 0,
      maxUses: null,
      rateLimitMaxRequests: null,
      rateLimitWindowSeconds: null,
      expiresAt: null,
      createdAt: '2026-07-21T12:00:00.000Z',
    };
    mocks.writeFile.mockReturnValueOnce(autosave.promise);
    mocks.updateShare.mockReturnValueOnce(mutation.promise);
    mocks.listShares
      .mockResolvedValueOnce({ shares: [activeShare] })
      .mockResolvedValueOnce({ shares: [{ ...activeShare, isActive: false }] });

    renderApps();
    await waitForAlphaFile();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Share' }));
    expect(await screen.findByText('/share/autosave-token')).toBeVisible();
    fireEvent.change(screen.getByLabelText('Mock project editor'), { target: { value: 'alpha:changed while sharing' } });

    const beta = screen.getByRole('button', { name: 'beta' });
    act(() => { beta.click(); });
    await waitFor(() => expect(mocks.writeFile).toHaveBeenCalledWith('alpha', 'one.ts', 'alpha:changed while sharing'));
    act(() => { screen.getByRole('button', { name: 'Active' }).click(); });
    expect(mocks.updateShare).toHaveBeenCalledWith('alpha', 'autosave-share', { isActive: false });
    expect(screen.getByTestId('route-operation-owner')).toHaveTextContent('owned');

    await act(async () => {
      autosave.resolve({ ok: true });
      await autosave.promise;
    });
    expect(screen.getByRole('button', { name: 'alpha' })).toHaveAttribute('aria-current', 'page');
    expect(mocks.getTree).not.toHaveBeenCalledWith('beta');

    await act(async () => {
      mutation.resolve({ ok: true });
      await mutation.promise;
    });
    await waitFor(() => expect(screen.getByTestId('route-operation-owner')).toHaveTextContent('idle'));
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
