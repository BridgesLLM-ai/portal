import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  Check,
  CheckCircle2,
  ChevronDown,
  Loader2,
  ShieldCheck,
} from 'lucide-react';
import type {
  ProjectChatProviderCapability,
  ProjectChatProviderName,
  ProjectChatProviderQualificationStatus,
} from '../../api/endpoints';
import AnchoredPopover from '../AnchoredPopover';

export interface ProjectProviderModelOption {
  value: string;
  label: string;
}

type QualificationMap = Partial<Record<
  ProjectChatProviderName,
  ProjectChatProviderQualificationStatus
>>;

export interface ProjectProviderQualificationFailure {
  message: string;
  code: string;
  retryable: boolean;
  recovery: 'HOST_MAINTENANCE' | null;
  retryAt: string | null;
  suppressionExpiresAt?: string | null;
}

export type ProjectQualificationRecoveryRole = 'OWNER' | 'SUB_ADMIN' | 'USER';

export function projectQualificationRecoveryAction(
  role: ProjectQualificationRecoveryRole,
): Readonly<{ href: string; label: string }> | null {
  if (role === 'OWNER') {
    return {
      href: '/dashboard',
      label: 'Open Dashboard for signed update',
    };
  }
  if (role === 'SUB_ADMIN') {
    return {
      href: '/agent-chats',
      label: 'Open Agent Chat to repair host',
    };
  }
  return null;
}

const MAX_PROJECT_QUALIFICATION_RETRY_DELAY_MS = 60 * 60_000;

export function normalizeProjectQualificationRetryAt(
  value: unknown,
  now = Date.now(),
): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) return null;
  const timestamp = Date.parse(value);
  if (
    !Number.isFinite(timestamp)
    || timestamp <= now
    || timestamp > now + MAX_PROJECT_QUALIFICATION_RETRY_DELAY_MS
  ) return null;
  return new Date(timestamp).toISOString();
}

function projectQualificationRetryAtMs(
  failure: ProjectProviderQualificationFailure | undefined,
  now: number,
): number | null {
  const retryAt = normalizeProjectQualificationRetryAt(failure?.retryAt, now);
  return retryAt ? Date.parse(retryAt) : null;
}

function formatProjectQualificationRetryTime(retryAt: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(retryAt));
}

interface ProjectProviderMenuProps {
  providers: ProjectChatProviderCapability[];
  qualifications: QualificationMap;
  /**
   * The last preparation failure per provider (auth missing, backend
   * offline, …). Without it the menu forgets why a Prepare failed the moment
   * the transient alert clears, and the row goes back to looking untried.
   */
  qualificationFailures?: Partial<Record<
    ProjectChatProviderName,
    ProjectProviderQualificationFailure
  >>;
  hostRecoveryRole: ProjectQualificationRecoveryRole;
  qualificationRetryNow: number;
  selectedProvider: ProjectChatProviderName;
  disabled: boolean;
  qualificationPending: boolean;
  onSelect: (provider: ProjectChatProviderName) => void;
  onQualify: (provider: ProjectChatProviderName) => void;
  agentZeroModel: string;
  agentZeroModels: ProjectProviderModelOption[];
  agentZeroModelsLoading: boolean;
  agentZeroModelsError: string | null;
  onAgentZeroModelChange: (model: string) => void;
}

const PROVIDER_MARKS: Record<ProjectChatProviderName, string> = {
  OPENCLAW: 'OC',
  CLAUDE_CODE: 'CL',
  CODEX: 'CX',
  GROK: 'GX',
  AGENT_ZERO: 'A0',
  GEMINI: 'AG',
  OLLAMA: 'OL',
};

const PROVIDER_MARK_STYLES: Record<ProjectChatProviderName, string> = {
  OPENCLAW: 'border-violet-400/25 bg-violet-500/10 text-violet-300',
  CLAUDE_CODE: 'border-orange-400/25 bg-orange-500/10 text-orange-300',
  CODEX: 'border-emerald-400/25 bg-emerald-500/10 text-emerald-300',
  GROK: 'border-slate-400/25 bg-slate-500/10 text-slate-300',
  AGENT_ZERO: 'border-cyan-400/25 bg-cyan-500/10 text-cyan-300',
  GEMINI: 'border-blue-400/25 bg-blue-500/10 text-blue-300',
  OLLAMA: 'border-amber-400/25 bg-amber-500/10 text-amber-300',
};

function isReady(capability: ProjectChatProviderCapability): boolean {
  return capability.selectable && capability.executionScope === 'PROJECT_SANDBOX';
}

function qualificationLabel(
  capability: ProjectChatProviderCapability,
  qualification: ProjectChatProviderQualificationStatus | undefined,
  active: boolean,
): string {
  if (isReady(capability)) return active ? 'Selected' : 'Ready';
  // "Preparing" is reserved for an actually running preparation (the button
  // spinner). A provider waiting on operator action must say so: labelling
  // expired auth or an unattempted runtime "Preparing" promised progress
  // that could never arrive.
  if (qualification?.status === 'EXPIRED') return 'Expired';
  if (qualification?.status === 'INVALID') return 'Needs attention';
  if (qualification?.status === 'UNQUALIFIED') return 'Not prepared';
  if (qualification?.status === 'UNAVAILABLE') return 'Unavailable';
  return 'Unavailable';
}

function canQualify(
  qualification: ProjectChatProviderQualificationStatus | undefined,
): qualification is ProjectChatProviderQualificationStatus {
  return Boolean(
    qualification
    && qualification.status !== 'QUALIFIED'
    && qualification.status !== 'UNAVAILABLE',
  );
}

export default function ProjectProviderMenu({
  providers,
  qualifications,
  qualificationFailures,
  hostRecoveryRole,
  qualificationRetryNow,
  selectedProvider,
  disabled,
  qualificationPending,
  onSelect,
  onQualify,
  agentZeroModel,
  agentZeroModels,
  agentZeroModelsLoading,
  agentZeroModelsError,
  onAgentZeroModelChange,
}: ProjectProviderMenuProps) {
  const [open, setOpen] = useState(false);
  const [focusedProvider, setFocusedProvider] = useState<ProjectChatProviderName>(selectedProvider);
  const [pendingPreparedProvider, setPendingPreparedProvider] = useState<ProjectChatProviderName | null>(null);
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [menuElement, setMenuElement] = useState<HTMLDivElement | null>(null);
  const selectedCapability = useMemo(
    () => providers.find((provider) => provider.provider === selectedProvider) || null,
    [providers, selectedProvider],
  );
  const hostRecoveryAction = projectQualificationRecoveryAction(hostRecoveryRole);

  useEffect(() => {
    setFocusedProvider(selectedProvider);
  }, [selectedProvider]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (!pendingPreparedProvider || qualificationPending) return;
    const capability = providers.find((entry) => entry.provider === pendingPreparedProvider);
    if (!capability) {
      setPendingPreparedProvider(null);
      return;
    }
    if (isReady(capability)) {
      setPendingPreparedProvider(null);
      if (capability.provider !== selectedProvider) onSelect(capability.provider);
      return;
    }
    const qualification = qualifications[pendingPreparedProvider];
    if (qualification?.status === 'UNAVAILABLE' || qualification?.status === 'INVALID') {
      setPendingPreparedProvider(null);
    }
  }, [
    onSelect,
    pendingPreparedProvider,
    providers,
    qualificationPending,
    qualifications,
    selectedProvider,
  ]);

  useEffect(() => {
    if (!open) return;
    const selectedItem = menuElement?.querySelector<HTMLButtonElement>(
      `[data-project-provider="${selectedProvider}"]`,
    );
    selectedItem?.focus();
  }, [menuElement, open, selectedProvider]);

  const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const items = Array.from(
      menuElement?.querySelectorAll<HTMLElement>('[data-project-provider-focusable]') || [],
    );
    if (items.length === 0) return;
    event.preventDefault();
    const currentIndex = Math.max(0, items.indexOf(document.activeElement as HTMLElement));
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? items.length - 1
        : event.key === 'ArrowDown'
          ? (currentIndex + 1) % items.length
          : (currentIndex - 1 + items.length) % items.length;
    items[nextIndex]?.focus();
  };

  const handleProviderPress = (capability: ProjectChatProviderCapability) => {
    if (isReady(capability)) {
      setOpen(false);
      triggerRef.current?.focus();
      if (capability.provider !== selectedProvider) onSelect(capability.provider);
      return;
    }
    const qualification = qualifications[capability.provider];
    const retryDeferred = projectQualificationRetryAtMs(
      qualificationFailures?.[capability.provider],
      qualificationRetryNow,
    ) !== null;
    const oneClickPreparationAvailable = canQualify(qualification)
      && qualificationFailures?.[capability.provider]?.retryable !== false
      && !retryDeferred
      && (
        capability.provider !== 'AGENT_ZERO'
        || agentZeroModels.some((option) => option.value === agentZeroModel)
      );
    if (oneClickPreparationAvailable) {
      setPendingPreparedProvider(capability.provider);
      setOpen(false);
      triggerRef.current?.focus();
      onQualify(capability.provider);
      return;
    }
    setFocusedProvider(capability.provider);
  };

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-label="Project chat provider"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled}
        title={selectedCapability?.reason || 'Choose a Project Chat provider'}
        onClick={() => setOpen((current) => !current)}
        className="flex max-w-[144px] items-center gap-1.5 rounded-lg border border-theme-border bg-theme-surface px-2 py-1 text-[10px] text-theme-text shadow-sm transition-colors hover:bg-theme-bg disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span
          aria-hidden="true"
          className={`grid h-5 w-5 flex-shrink-0 place-items-center rounded-md border text-[8px] font-bold ${PROVIDER_MARK_STYLES[selectedProvider]}`}
        >
          {PROVIDER_MARKS[selectedProvider]}
        </span>
        <span className="truncate font-medium">
          {selectedCapability?.displayName || selectedProvider}
        </span>
        <ChevronDown
          size={11}
          className={`flex-shrink-0 text-theme-text-muted transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      <AnchoredPopover
        open={open}
        anchorRef={triggerRef}
        onDismiss={(reason) => {
          setOpen(false);
          if (reason === 'escape') triggerRef.current?.focus();
        }}
        width={352}
        mobileBreakpoint={767}
      >
        <div
          ref={setMenuElement}
          id={menuId}
          role="menu"
          tabIndex={-1}
          aria-label="Project chat providers"
          onKeyDown={handleMenuKeyDown}
          className="flex min-h-0 max-h-full w-full flex-col overflow-hidden rounded-2xl border border-theme-border bg-theme-surface shadow-2xl"
        >
          <div className="border-b border-theme-border px-3 py-2.5">
            <div className="text-xs font-semibold text-theme-text">Choose an agent harness</div>
            <div className="mt-0.5 text-[10px] text-theme-text-muted">
              Same project and transcript. Switch the engine behind it.
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5">
            {providers.map((capability) => {
              const qualification = qualifications[capability.provider];
              const qualificationFailure = qualificationFailures?.[capability.provider];
              const retryAtMs = projectQualificationRetryAtMs(
                qualificationFailure,
                qualificationRetryNow,
              );
              const retryDeferred = retryAtMs !== null;
              const ready = isReady(capability);
              const active = capability.provider === selectedProvider;
              const focused = capability.provider === focusedProvider;
              const actionAvailable = canQualify(qualification)
                && qualificationFailure?.retryable !== false
                && !retryDeferred;
              const exactAgentZeroModelSelected = agentZeroModels.some(
                (option) => option.value === agentZeroModel,
              );
              const oneClickPreparationAvailable = actionAvailable
                && (capability.provider !== 'AGENT_ZERO' || exactAgentZeroModelSelected);
              const showDetails = focused && !ready;

              return (
                <div
                  key={capability.provider}
                  className={`mb-1 overflow-hidden rounded-xl border transition-colors ${
                    focused
                      ? 'border-theme-border bg-theme-bg'
                      : 'border-transparent hover:border-theme-border hover:bg-theme-bg'
                  }`}
                >
                  <button
                    type="button"
                    role="menuitem"
                    data-project-provider={capability.provider}
                    data-project-provider-focusable="true"
                    aria-current={active ? 'true' : undefined}
                    aria-label={`${ready ? 'Use' : oneClickPreparationAvailable ? 'Prepare' : 'Review'} ${capability.displayName}`}
                    onClick={() => handleProviderPress(capability)}
                    className="flex w-full items-center gap-2.5 px-2.5 py-2 text-left"
                  >
                    <span
                      aria-hidden="true"
                      className={`grid h-8 w-8 flex-shrink-0 place-items-center rounded-lg border text-[10px] font-bold ${PROVIDER_MARK_STYLES[capability.provider]}`}
                    >
                      {PROVIDER_MARKS[capability.provider]}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[11px] font-medium text-theme-text">
                        {capability.displayName}
                      </span>
                      <span className="mt-0.5 block truncate text-[9px] text-theme-text-muted">
                        {capability.supportsModelSelection ? 'Choose a model' : 'Provider-managed model'}
                        {' · '}
                        Project sandbox
                      </span>
                    </span>
                    <span
                      className={`inline-flex flex-shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-medium ${
                        ready
                          ? 'bg-emerald-500/10 text-emerald-300'
                          : actionAvailable
                            ? 'bg-amber-500/10 text-amber-300'
                            : 'bg-theme-bg text-theme-text-muted'
                      }`}
                    >
                      {ready && <CheckCircle2 size={9} />}
                      {qualificationLabel(capability, qualification, active)}
                    </span>
                    {active && ready && <Check size={12} className="flex-shrink-0 text-emerald-300" />}
                    {!ready && <ChevronDown size={11} className={`flex-shrink-0 text-theme-text-muted transition-transform ${showDetails ? 'rotate-180' : ''}`} />}
                  </button>

                  {showDetails && (
                    <div className="border-t border-theme-border px-3 pb-3 pt-2">
                      <p className="text-[10px] leading-relaxed text-theme-text-muted">
                        {qualification?.reason || capability.reason}
                      </p>
                      {qualificationFailure && (
                        <p
                          role="note"
                          className="mt-1.5 rounded-lg border border-red-500/20 bg-red-500/10 px-2 py-1.5 text-[10px] leading-relaxed text-red-300"
                        >
                          {qualificationFailure.message}
                        </p>
                      )}
                      {qualificationFailure?.recovery === 'HOST_MAINTENANCE' && (
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          {hostRecoveryAction ? (
                            <a
                              href={hostRecoveryAction.href}
                              role="menuitem"
                              data-project-provider-focusable="true"
                              className="inline-flex rounded-lg border border-violet-400/25 bg-violet-500/10 px-2.5 py-1.5 text-[10px] font-medium text-violet-100 transition-colors hover:bg-violet-500/20"
                            >
                              {hostRecoveryAction.label}
                            </a>
                          ) : (
                            <p className="text-[10px] font-medium text-amber-200">
                              Contact an Owner or Sub Admin to repair the Portal host.
                            </p>
                          )}
                          <button
                            type="button"
                            role="menuitem"
                            data-project-provider-focusable="true"
                            aria-label={`Recheck ${capability.displayName} after host repair`}
                            disabled={qualificationPending}
                            onClick={() => {
                              setPendingPreparedProvider(capability.provider);
                              setOpen(false);
                              triggerRef.current?.focus();
                              onQualify(capability.provider);
                            }}
                            className="inline-flex rounded-lg border border-theme-border bg-theme-bg px-2.5 py-1.5 text-[10px] font-medium text-theme-text transition-colors hover:bg-theme-surface disabled:cursor-wait disabled:opacity-50"
                          >
                            Recheck after repair
                          </button>
                        </div>
                      )}
                      {retryDeferred && qualificationFailure?.retryAt && (
                        <p
                          role="status"
                          className="mt-2 text-[10px] font-medium text-amber-200"
                        >
                          Preparation is rate limited. Try again after{' '}
                          <time dateTime={qualificationFailure.retryAt}>
                            {formatProjectQualificationRetryTime(qualificationFailure.retryAt)}
                          </time>.
                        </p>
                      )}

                      {capability.provider === 'AGENT_ZERO' && actionAvailable && (
                        <div className="mt-2 space-y-1.5">
                          <label
                            htmlFor="agent-zero-project-qualification-model"
                            className="block text-[10px] font-medium text-theme-text"
                          >
                            Connected model
                          </label>
                          <select
                            id="agent-zero-project-qualification-model"
                            aria-label="Agent Zero qualification model"
                            value={agentZeroModel}
                            onChange={(event) => onAgentZeroModelChange(event.target.value)}
                            disabled={agentZeroModelsLoading || qualificationPending}
                            className="w-full rounded-lg border border-theme-border bg-theme-bg px-2 py-1.5 text-[10px] text-theme-text disabled:opacity-50"
                          >
                            <option value="">Select a connected model…</option>
                            {agentZeroModels.map((option) => (
                              <option key={option.value} value={option.value}>{option.label}</option>
                            ))}
                          </select>
                          {agentZeroModelsLoading && (
                            <div className="text-[10px] text-theme-text-muted">Checking connected Agent Zero accounts…</div>
                          )}
                          {agentZeroModelsError && (
                            <div className="text-[10px] text-amber-300/90">{agentZeroModelsError}</div>
                          )}
                        </div>
                      )}

                      {qualificationFailure?.retryable === false || retryDeferred ? null : actionAvailable ? (
                        <button
                          type="button"
                          aria-label={`Qualify ${capability.displayName} for this project`}
                          onClick={() => {
                            setPendingPreparedProvider(capability.provider);
                            setOpen(false);
                            onQualify(capability.provider);
                          }}
                          disabled={
                            qualificationPending
                            || (capability.provider === 'AGENT_ZERO' && (
                              agentZeroModelsLoading || !exactAgentZeroModelSelected
                            ))
                          }
                          className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-amber-400/20 bg-amber-500/10 px-2.5 py-1.5 text-[10px] font-medium text-amber-100 transition-colors hover:bg-amber-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {qualificationPending
                            ? <Loader2 size={11} className="animate-spin" />
                            : <ShieldCheck size={11} />}
                          {qualificationPending ? 'Preparing…' : 'Prepare provider'}
                        </button>
                      ) : (
                        <div className="mt-2 text-[9px] font-medium uppercase tracking-wide text-theme-text-muted">
                          Not available in Project Chat
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="flex items-center gap-1.5 border-t border-theme-border bg-theme-bg px-3 py-2 text-[9px] text-theme-text-muted">
            <ShieldCheck size={10} className="text-emerald-400" />
            Portal prepares and checks each isolated project runtime automatically.
          </div>
        </div>
      </AnchoredPopover>
    </div>
  );
}
