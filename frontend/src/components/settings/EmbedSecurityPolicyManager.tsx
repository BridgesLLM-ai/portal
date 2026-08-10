import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Loader2, Plus, RefreshCw, RotateCcw, Save, Trash2 } from 'lucide-react';
import {
  settingsAPI,
  type EmbedOriginPolicy,
  type EmbedOriginPolicyEntry,
} from '../../api/settings';
import type {
  SettingsMutationClaim,
  SettingsMutationRelease,
} from './SettingsMutationContext';

type DraftEntry = EmbedOriginPolicyEntry & { id: string };

type ValidationResult = {
  normalizedEntries: EmbedOriginPolicyEntry[];
  rowErrors: Map<string, string>;
  globalError: string | null;
};

export type EmbedSecurityPolicyManagerProps = {
  addToast: (type: 'success' | 'error', message: string) => void;
  claimMutation: SettingsMutationClaim;
  releaseMutation: SettingsMutationRelease;
  mutationOwner?: string | null;
  navigationAttemptVersion?: number;
  onDirtyChange?: (dirty: boolean) => void;
};

const MUTATION_OWNER = 'settings:security:embed-origins';

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

export function normalizeClientEmbedOrigin(
  value: string,
  maxOriginBytes: number,
): { origin: string } | { error: string } {
  const candidate = value.trim();
  if (!candidate) return { error: 'Enter an HTTPS origin.' };
  if (utf8Bytes(candidate) > maxOriginBytes) {
    return { error: `Origin must be no more than ${maxOriginBytes} UTF-8 bytes.` };
  }
  if (!/^https:\/\//i.test(candidate)) return { error: 'Origin must use HTTPS.' };
  if (/[\u0000-\u0020\u007f\\]/.test(candidate)) {
    return { error: 'Origin cannot contain spaces, control characters, or backslashes.' };
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { error: 'Enter an exact origin, such as https://video.example.com.' };
  }
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.origin === 'null') {
    return { error: 'Origin must use HTTPS.' };
  }
  if (parsed.username || parsed.password) {
    return { error: 'Origin cannot include a username or password.' };
  }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    return { error: 'Enter only the origin, without a path, query, or fragment.' };
  }
  if (parsed.hostname.includes('*')) {
    return { error: 'Wildcards are not allowed. Add each exact origin.' };
  }
  const hostname = parsed.hostname.toLowerCase();
  if (parsed.port) {
    return { error: 'Origin must use the standard HTTPS port.' };
  }
  const unwrappedHostname = hostname.replace(/^\[|\]$/g, '');
  if (unwrappedHostname.includes(':') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(unwrappedHostname) || hostname.endsWith('.')) {
    return { error: 'Origin must use a DNS hostname, not an IP address.' };
  }
  const labels = hostname.split('.');
  if (hostname.length > 253
      || labels.length < 2
      || labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    return { error: 'Origin must use a valid DNS hostname.' };
  }
  const privateSuffixes = [
    'local', 'internal', 'lan', 'home', 'localhost', 'localdomain',
    'test', 'invalid', 'onion', 'alt', 'arpa', 'example',
  ];
  if (privateSuffixes.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`))) {
    return { error: 'Private and special-use hostnames cannot be used as embed origins.' };
  }
  const suffix = candidate.slice('https://'.length).replace(/^[^/?#]*/i, '');
  if (suffix !== '' && suffix !== '/') {
    return { error: 'Enter only the origin, without a path, query, or fragment.' };
  }
  if (utf8Bytes(parsed.origin) > maxOriginBytes) {
    return { error: `Origin must be no more than ${maxOriginBytes} UTF-8 bytes.` };
  }
  return { origin: parsed.origin };
}

function canonicalEntries(entries: readonly EmbedOriginPolicyEntry[]): string {
  return JSON.stringify(
    entries
      .map((entry) => ({
        origin: entry.origin,
        camera: entry.camera,
        microphone: entry.microphone,
      }))
      .sort((left, right) => left.origin.localeCompare(right.origin)),
  );
}

export function serializedEmbedOriginPolicyBytes(
  entries: readonly EmbedOriginPolicyEntry[],
): number {
  return utf8Bytes(JSON.stringify({ version: 1, entries }));
}

export function validateEmbedOriginDraft(
  entries: readonly DraftEntry[],
  policy: Pick<EmbedOriginPolicy, 'limits'>,
): ValidationResult {
  const rowErrors = new Map<string, string>();
  const normalizedEntries: EmbedOriginPolicyEntry[] = [];
  const seen = new Map<string, string>();

  for (const entry of entries) {
    const parsed = normalizeClientEmbedOrigin(entry.origin, policy.limits.maxOriginBytes);
    if ('error' in parsed) {
      rowErrors.set(entry.id, parsed.error);
      continue;
    }
    const priorId = seen.get(parsed.origin);
    if (priorId) {
      rowErrors.set(priorId, `${parsed.origin} is listed more than once.`);
      rowErrors.set(entry.id, `${parsed.origin} is listed more than once.`);
      continue;
    }
    seen.set(parsed.origin, entry.id);
    normalizedEntries.push({
      origin: parsed.origin,
      camera: entry.camera,
      microphone: entry.microphone,
    });
  }
  normalizedEntries.sort((left, right) => left.origin.localeCompare(right.origin));

  let globalError: string | null = null;
  if (entries.length > policy.limits.maxOrigins) {
    globalError = `No more than ${policy.limits.maxOrigins} embed origins are allowed.`;
  } else if (rowErrors.size === 0) {
    const policyBytes = serializedEmbedOriginPolicyBytes(normalizedEntries);
    if (policyBytes > policy.limits.maxPolicyBytes) {
      globalError = `The serialized embed policy is ${policyBytes} UTF-8 bytes; the limit is ${policy.limits.maxPolicyBytes}. Remove or shorten origins.`;
    }
  }

  return {
    normalizedEntries,
    rowErrors,
    globalError,
  };
}

function cloneDraft(entries: readonly EmbedOriginPolicyEntry[], nextId: () => string): DraftEntry[] {
  return entries.map((entry) => ({ ...entry, id: nextId() }));
}

function requestMessage(error: any, fallback: string): string {
  return error?.response?.data?.error || error?.message || fallback;
}

function formatUpdatedAt(value: string | null): string {
  if (!value) return 'Never saved';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? 'Saved previously' : `Last saved ${parsed.toLocaleString()}`;
}

export default function EmbedSecurityPolicyManager({
  addToast,
  claimMutation,
  releaseMutation,
  mutationOwner,
  navigationAttemptVersion = 0,
  onDirtyChange,
}: EmbedSecurityPolicyManagerProps) {
  const [policy, setPolicy] = useState<EmbedOriginPolicy | null>(null);
  const [draft, setDraft] = useState<DraftEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [reloading, setReloading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [revisionConflict, setRevisionConflict] = useState(false);
  const mountedRef = useRef(true);
  const policyRef = useRef<EmbedOriginPolicy | null>(null);
  const readSequenceRef = useRef(0);
  const readControllerRef = useRef<AbortController | null>(null);
  const activeReadSequenceRef = useRef(0);
  const draftGenerationRef = useRef(0);
  const draftRef = useRef<DraftEntry[]>([]);
  const nextEntryIdRef = useRef(0);
  const revisionConflictRef = useRef(false);
  const saveActionRef = useRef<{ revision: string; entries: EmbedOriginPolicyEntry[] } | null>(null);

  const nextEntryId = useCallback(() => `embed-origin-${++nextEntryIdRef.current}`, []);

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  const installPolicy = useCallback((nextPolicy: EmbedOriginPolicy) => {
    policyRef.current = nextPolicy;
    setPolicy(nextPolicy);
    const nextDraft = cloneDraft(nextPolicy.entries, nextEntryId);
    draftRef.current = nextDraft;
    setDraft(nextDraft);
    setSaveError(null);
    setNotice(null);
    revisionConflictRef.current = false;
    setRevisionConflict(false);
  }, [nextEntryId]);

  const loadPolicy = useCallback(async () => {
    if (saveActionRef.current) return;
    const sequence = ++readSequenceRef.current;
    activeReadSequenceRef.current = sequence;
    const startingDraftGeneration = draftGenerationRef.current;
    readControllerRef.current?.abort();
    const controller = new AbortController();
    readControllerRef.current = controller;
    if (policyRef.current) setReloading(true);
    else setLoading(true);
    setLoadError(null);
    try {
      const nextPolicy = await settingsAPI.getEmbedOriginPolicy(controller.signal);
      if (!mountedRef.current || sequence !== readSequenceRef.current) return;
      if (draftGenerationRef.current !== startingDraftGeneration) {
        setNotice('The saved policy finished loading, but newer edits were kept. Reload again to replace them.');
        return;
      }
      installPolicy(nextPolicy);
    } catch (error: any) {
      if (!mountedRef.current || sequence !== readSequenceRef.current || error?.name === 'CanceledError' || error?.name === 'AbortError') return;
      setLoadError(requestMessage(error, 'Embed-origin policy could not be loaded.'));
    } finally {
      if (sequence === readSequenceRef.current) {
        if (mountedRef.current) {
          setLoading(false);
          setReloading(false);
        }
        activeReadSequenceRef.current = 0;
      }
    }
  }, [installPolicy]);

  useEffect(() => {
    mountedRef.current = true;
    void loadPolicy();
    return () => {
      mountedRef.current = false;
      readControllerRef.current?.abort();
      readSequenceRef.current += 1;
    };
  }, [loadPolicy]);

  const validation = useMemo(
    () => policy
      ? validateEmbedOriginDraft(draft, policy)
      : { normalizedEntries: [], rowErrors: new Map<string, string>(), globalError: null },
    [draft, policy],
  );

  const dirty = useMemo(() => {
    if (!policy) return false;
    if (validation.rowErrors.size > 0 || validation.globalError) return draft.length > 0;
    return canonicalEntries(validation.normalizedEntries) !== canonicalEntries(policy.entries);
  }, [draft.length, policy, validation]);
  const canSave = dirty || policy?.status === 'invalid';

  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);

  const mutateDraft = useCallback((mutator: (current: DraftEntry[]) => DraftEntry[]) => {
    if (saveActionRef.current) return;
    draftGenerationRef.current += 1;
    setDraft((current) => {
      const next = mutator(current);
      draftRef.current = next;
      return next;
    });
    if (!revisionConflictRef.current) setSaveError(null);
    setNotice(null);
  }, []);

  const handleAdd = () => {
    if (!policy || draftRef.current.length >= policy.limits.maxOrigins) return;
    mutateDraft((current) => [
      ...current,
      { id: nextEntryId(), origin: '', camera: false, microphone: false },
    ]);
  };

  const handleReset = () => {
    if (!policy || saveActionRef.current) return;
    draftGenerationRef.current += 1;
    const nextDraft = cloneDraft(policy.entries, nextEntryId);
    draftRef.current = nextDraft;
    setDraft(nextDraft);
    if (revisionConflictRef.current) {
      setNotice(null);
      setSaveError('This policy changed in another session. Your draft was reset to the previously loaded copy; reload the saved policy to see the current version.');
    } else {
      setSaveError(null);
      setNotice('Unsaved embed-origin changes were reset.');
    }
  };

  const handleSave = async (): Promise<void> => {
    if (!policy || saveActionRef.current || activeReadSequenceRef.current !== 0 || revisionConflictRef.current || !canSave || validation.rowErrors.size > 0 || validation.globalError) return;
    const snapshot = {
      revision: policy.revision,
      entries: validation.normalizedEntries.map((entry) => ({ ...entry })),
    };
    saveActionRef.current = snapshot;
    if (!claimMutation(MUTATION_OWNER)) {
      saveActionRef.current = null;
      return;
    }
    setSaving(true);
    setSaveError(null);
    setNotice(null);
    try {
      const saved = await settingsAPI.updateEmbedOriginPolicy({
        expectedRevision: snapshot.revision,
        entries: snapshot.entries,
      });
      if (!mountedRef.current || saveActionRef.current !== snapshot) return;
      draftGenerationRef.current += 1;
      installPolicy(saved);
      setNotice('Embed-origin policy saved. New hosted and share responses use it immediately.');
      addToast('success', 'Embed-origin policy saved');
    } catch (error: any) {
      if (!mountedRef.current || saveActionRef.current !== snapshot) return;
      if (Number(error?.response?.status) === 409) {
        const conflictMessage = 'This policy changed in another session. Your draft is still here. Reload the saved policy before trying again.';
        revisionConflictRef.current = true;
        setRevisionConflict(true);
        setSaveError(conflictMessage);
        addToast('error', conflictMessage);
      } else {
        const message = requestMessage(error, 'Embed-origin policy could not be saved.');
        setSaveError(message);
        addToast('error', message);
      }
    } finally {
      if (saveActionRef.current === snapshot) {
        saveActionRef.current = null;
        releaseMutation(MUTATION_OWNER);
        if (mountedRef.current) setSaving(false);
      }
    }
  };

  const surfaceBusy = saving || Boolean(mutationOwner && mutationOwner !== MUTATION_OWNER);

  if (loading && !policy) {
    return (
      <section aria-labelledby="embed-security-policy-heading" className="mb-4 rounded-xl border border-white/[0.06] bg-white/[0.03] p-5">
        <h3 id="embed-security-policy-heading" className="text-sm font-semibold text-theme-text">Hosted content embeds</h3>
        <p role="status" aria-live="polite" className="mt-4 flex items-center gap-2 text-sm text-slate-400">
          <Loader2 size={16} className="animate-spin" aria-hidden="true" /> Loading embed security policy…
        </p>
      </section>
    );
  }

  if (!policy) {
    return (
      <section aria-labelledby="embed-security-policy-heading" className="mb-4 rounded-xl border border-red-500/20 bg-red-500/5 p-5">
        <h3 id="embed-security-policy-heading" className="text-sm font-semibold text-theme-text">Hosted content embeds</h3>
        <p role="alert" className="mt-3 text-sm text-red-300">{loadError || 'Embed-origin policy could not be loaded.'}</p>
        <button
          type="button"
          onClick={() => void loadPolicy()}
          disabled={reloading}
          className="mt-4 inline-flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-200 hover:bg-red-500/20 disabled:opacity-50"
        >
          {reloading ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={15} aria-hidden="true" />}
          Retry policy load
        </button>
      </section>
    );
  }

  const atLimit = draft.length >= policy.limits.maxOrigins;
  const legacyContract = !Array.isArray(policy.defaultOrigins);
  const mutationBlocked = surfaceBusy || legacyContract;

  return (
    <section aria-labelledby="embed-security-policy-heading" className="mb-4 rounded-xl border border-white/[0.06] bg-white/[0.03] p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 id="embed-security-policy-heading" className="text-sm font-semibold text-theme-text">Hosted content embeds</h3>
          <p className="mt-1 max-w-3xl text-xs leading-5 text-theme-text-muted">
            This Owner-managed allowlist is portal-wide: it affects every isolated hosted app and project share on this installation. Allowed origins are added to those pages&apos; response security headers, not to the authenticated Portal itself.
          </p>
        </div>
        <span className="shrink-0 text-xs text-slate-500">{formatUpdatedAt(policy.updatedAt)}</span>
      </div>

      <div className="mt-4 rounded-lg border border-amber-400/20 bg-amber-400/5 p-3 text-xs leading-5 text-amber-100/90">
        <div className="flex items-start gap-2">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-300" aria-hidden="true" />
          <div className="space-y-1">
            <p>Allowing an origin lets content from that site load inside every hosted/share surface. The configured origins are visible in CSP and Permissions-Policy response headers and in browser tools; this setting is not private or per-project.</p>
            <p>A provider can still refuse embedding through its own <code className="rounded bg-black/20 px-1">X-Frame-Options</code> or <code className="rounded bg-black/20 px-1">frame-ancestors</code> policy.</p>
            <p>Camera and microphone toggles only let that origin request browser permission; they do not grant it automatically. The project must also use an iframe <code className="rounded bg-black/20 px-1">allow=&quot;camera; microphone&quot;</code> attribute for those capabilities.</p>
          </div>
        </div>
      </div>

      {policy.updatedAt === null && (policy.defaultOrigins?.length ?? 0) > 0 && (
        <p className="mt-4 rounded-lg border border-violet-400/15 bg-violet-400/5 p-3 text-xs leading-5 text-violet-100/90">
          This installation starts with YouTube and YouTube No-Cookie as removable defaults. They are ordinary entries: remove either one and save, or save an empty list to allow no third-party frames.
        </p>
      )}

      {legacyContract && (
        <p role="alert" className="mt-4 rounded-lg border border-amber-400/25 bg-amber-400/10 p-3 text-sm leading-5 text-amber-100">
          Portal&apos;s update is still converging. The preceding backend still enforces
          {(policy.builtInOrigins?.length ?? 0) > 0
            ? ` ${policy.builtInOrigins!.join(' and ')} as built-in frame origins`
            : ' a legacy built-in frame policy'}.
          {' '}Embed-policy changes are disabled until the new contract loads; use Reload saved policy after the update finishes.
        </p>
      )}

      <div className="mt-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Allowed origins</h4>
            <p className="mt-1 text-xs text-slate-500">Exact HTTPS origins only · {draft.length}/{policy.limits.maxOrigins}</p>
          </div>
          <button
            type="button"
            onClick={handleAdd}
            disabled={atLimit || mutationBlocked || reloading}
            className="inline-flex min-h-[40px] items-center gap-2 rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-2 text-sm text-slate-200 hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Plus size={15} aria-hidden="true" /> Add origin
          </button>
        </div>

        {draft.length === 0 ? (
          <p className="mt-3 rounded-lg border border-dashed border-white/[0.08] px-3 py-4 text-center text-sm text-slate-500">
            {legacyContract
              ? 'Saved policy entries are unavailable while the Portal update finishes.'
              : 'No third-party embed origins are allowed.'}
          </p>
        ) : (
          <div className="mt-3 space-y-3">
            {draft.map((entry, index) => {
              const error = validation.rowErrors.get(entry.id);
              const errorId = `${entry.id}-error`;
              const helpId = `${entry.id}-help`;
              return (
                <div key={entry.id} className="rounded-lg border border-white/[0.07] bg-black/10 p-3">
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <label htmlFor={`${entry.id}-input`} className="text-xs font-medium text-slate-300">Origin {index + 1}</label>
                      <input
                        id={`${entry.id}-input`}
                        type="url"
                        inputMode="url"
                        value={entry.origin}
                        onChange={(event) => mutateDraft((current) => current.map((candidate) => (
                          candidate.id === entry.id ? { ...candidate, origin: event.target.value } : candidate
                        )))}
                        placeholder="https://video.example.com"
                        autoComplete="off"
                        spellCheck={false}
                        disabled={mutationBlocked || reloading}
                        aria-invalid={Boolean(error)}
                        aria-describedby={error ? `${helpId} ${errorId}` : helpId}
                        className="mt-1 w-full rounded-lg border border-white/[0.08] bg-white/[0.05] px-3 py-2 font-mono text-sm text-slate-200 placeholder-slate-600 outline-none focus:border-violet-400/40 focus:ring-1 focus:ring-violet-400/20 disabled:opacity-60"
                      />
                      <p id={helpId} className="mt-1 text-xs text-slate-500">DNS hostname only; private and special-use suffixes are blocked, along with paths, queries, fragments, credentials, wildcards, and nonstandard ports.</p>
                      {error && <p id={errorId} role="alert" className="mt-1 text-xs text-red-300">{error}</p>}
                    </div>
                    <button
                      type="button"
                      onClick={() => mutateDraft((current) => current.filter((candidate) => candidate.id !== entry.id))}
                      disabled={mutationBlocked || reloading}
                      aria-label={`Remove embed origin ${index + 1}`}
                      className="mt-5 rounded-lg border border-red-500/10 p-2 text-slate-500 hover:bg-red-500/10 hover:text-red-300 disabled:opacity-50"
                    >
                      <Trash2 size={16} aria-hidden="true" />
                    </button>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
                    {(['camera', 'microphone'] as const).map((permission) => (
                      <label key={permission} className="flex items-center gap-2 text-sm text-slate-300">
                        <input
                          type="checkbox"
                          aria-label={`Allow ${permission} for origin ${index + 1}`}
                          checked={entry[permission]}
                          onChange={(event) => mutateDraft((current) => current.map((candidate) => (
                            candidate.id === entry.id ? { ...candidate, [permission]: event.target.checked } : candidate
                          )))}
                          disabled={mutationBlocked || reloading}
                          className="h-4 w-4 rounded border-white/20 bg-white/5 accent-violet-500"
                        />
                        Allow {permission}
                      </label>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {policy.status === 'invalid' && (
        <p role="alert" className="mt-4 rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-200">
          {policy.warning || 'The saved policy is invalid. Third-party origins are disabled until you replace it.'}
        </p>
      )}
      {validation.globalError && <p role="alert" className="mt-4 text-sm text-red-300">{validation.globalError}</p>}
      {loadError && <p role="alert" className="mt-4 text-sm text-red-300">{loadError}</p>}
      {saveError && <p role="alert" className="mt-4 rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-200">{saveError}</p>}
      {notice && <p role="status" aria-live="polite" className="mt-4 text-sm text-emerald-300">{notice}</p>}
      {dirty && (
        <p className="mt-4 rounded-lg border border-sky-400/20 bg-sky-400/5 p-3 text-sm text-sky-100">
          {navigationAttemptVersion > 0
            ? 'Navigation paused to protect this draft. Save or reset the embed-origin changes before leaving Security.'
            : 'Unsaved embed-origin changes are protected. Save or reset them before switching Settings tabs or leaving the Portal; closing or reloading the page will show a browser warning.'}
        </p>
      )}

      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <button
          type="button"
          onClick={handleReset}
          disabled={!dirty || mutationBlocked || reloading}
          className="inline-flex min-h-[42px] items-center gap-2 rounded-lg border border-white/[0.08] px-3 py-2 text-sm text-slate-300 hover:bg-white/[0.05] disabled:cursor-not-allowed disabled:opacity-50"
        >
          <RotateCcw size={15} aria-hidden="true" /> Reset draft
        </button>
        <button
          type="button"
          onClick={() => void loadPolicy()}
          disabled={surfaceBusy || reloading}
          aria-busy={reloading}
          className="inline-flex min-h-[42px] items-center gap-2 rounded-lg border border-white/[0.08] px-3 py-2 text-sm text-slate-300 hover:bg-white/[0.05] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {reloading ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={15} aria-hidden="true" />}
          {reloading ? 'Reloading…' : 'Reload saved policy'}
        </button>
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={!canSave || revisionConflict || validation.rowErrors.size > 0 || Boolean(validation.globalError) || mutationBlocked || reloading}
          aria-busy={saving}
          className="accent-btn inline-flex min-h-[42px] items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50"
          style={{
            background: 'var(--accent-bg)',
            color: 'var(--accent)',
            borderColor: 'var(--accent-border)',
          }}
        >
          {saving ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <Save size={15} aria-hidden="true" />}
          {saving ? 'Saving embed policy…' : 'Save embed policy'}
        </button>
      </div>
    </section>
  );
}
