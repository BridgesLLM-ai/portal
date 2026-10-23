import { useCallback, useEffect, useId, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { KeyRound, Loader2, RefreshCw, Trash2, Upload } from 'lucide-react';
import ConfirmDialog from '../ConfirmDialog';
import { appCredentialsAPI, type AppCredentialSlotView, type AppCredentialsView } from '../../api/appCredentials';

// Named App credentials (Portal Owner only). Values are write-only: typed or
// loaded into a masked field, sent once, then dropped from the page. The App
// reads each one as a read-only file at /portal/credentials/<name>.

const SLOT_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;

type Editor = { mode: 'add' } | { mode: 'replace'; slot: string; revision: number };
type Notice = { tone: 'success' | 'error'; text: string } | null;

function errorText(error: unknown, fallback: string): string {
  const data = (error as { response?: { data?: { error?: unknown } } })?.response?.data;
  const text = typeof data?.error === 'string' && data.error.trim() ? data.error.trim() : fallback;
  return text.length > 300 ? `${text.slice(0, 299)}…` : text;
}

function when(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
}

function author(slot: AppCredentialSlotView): string {
  if (slot.updatedBy.kind === 'operator') return 'the server operator (import)';
  return slot.updatedBy.username || 'a removed account';
}

function CredentialsManager({ appId }: { appId: string }) {
  const [view, setView] = useState<AppCredentialsView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'load' | 'save' | 'remove' | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [slotName, setSlotName] = useState('');
  const [value, setValue] = useState('');
  const [valueSource, setValueSource] = useState<'file' | 'paste' | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [removing, setRemoving] = useState<AppCredentialSlotView | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const requestVersion = useRef(0);
  // A file read finishes later than the click that started it. Every save,
  // cancel, close and unmount bumps the generation and aborts the reader, so a
  // late result can never write a value back into the page.
  const readGeneration = useRef(0);
  const reader = useRef<FileReader | null>(null);
  const idPrefix = useId();

  const cancelFileRead = useCallback(() => {
    readGeneration.current += 1;
    const pending = reader.current;
    reader.current = null;
    if (pending && pending.readyState === 1) pending.abort();
  }, []);

  useEffect(() => cancelFileRead, [cancelFileRead]);

  const load = useCallback(async () => {
    const version = ++requestVersion.current;
    setBusy('load');
    try {
      const next = await appCredentialsAPI.list(appId);
      if (version !== requestVersion.current) return;
      if (next.app.id !== appId) throw new Error('The App changed. Refresh Projects.');
      setView(next);
      setLoadError(null);
    } catch (failure) {
      if (version !== requestVersion.current) return;
      setView(null);
      setLoadError(errorText(failure, 'App credentials are unavailable. Refresh to retry.'));
    } finally {
      if (version === requestVersion.current) setBusy(null);
    }
  }, [appId]);

  useEffect(() => {
    void load();
    return () => { requestVersion.current += 1; };
  }, [load]);

  const closeEditor = () => {
    cancelFileRead();
    setEditor(null);
    setSlotName('');
    setValue('');
    setValueSource(null);
    if (fileInput.current) fileInput.current.value = '';
  };

  const maxBytes = view?.limits.maxBytes ?? 64 * 1024;
  const slot = editor?.mode === 'replace' ? editor.slot : slotName.trim();
  const slotInvalid = editor?.mode === 'add' && slotName.length > 0 && !SLOT_PATTERN.test(slotName.trim());
  const tooLarge = new TextEncoder().encode(value).length > maxBytes;
  const canSave = Boolean(editor) && SLOT_PATTERN.test(slot) && value.length > 0 && !tooLarge && !busy;

  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!editor || !canSave) return;
    const expectedRevision = editor.mode === 'replace' ? editor.revision : null;
    // What is sent is what the field holds now; a read still pending is dropped.
    cancelFileRead();
    setBusy('save');
    setNotice(null);
    void appCredentialsAPI.set(appId, slot, value, expectedRevision).then((next) => {
      setView(next);
      closeEditor();
      setNotice({ tone: 'success', text: `Saved "${slot}". It reaches the App the next time it starts or is redeployed.` });
    }, (failure) => {
      setNotice({ tone: 'error', text: errorText(failure, 'The credential was not saved.') });
    }).finally(() => setBusy(null));
  };

  const remove = () => {
    const target = removing;
    if (!target) return;
    setBusy('remove');
    setNotice(null);
    void appCredentialsAPI.remove(appId, target.slot, target.revision).then((next) => {
      setView(next);
      setRemoving(null);
      setNotice({ tone: 'success', text: `Removed "${target.slot}". A running App keeps its copy until it restarts.` });
    }, (failure) => {
      setRemoving(null);
      setNotice({ tone: 'error', text: errorText(failure, 'The credential was not removed.') });
    }).finally(() => setBusy(null));
  };

  const readFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > maxBytes) {
      setNotice({ tone: 'error', text: `That file is larger than ${maxBytes} bytes.` });
      event.target.value = '';
      return;
    }
    cancelFileRead();
    const generation = readGeneration.current;
    const next = new FileReader();
    reader.current = next;
    next.onload = () => {
      if (generation !== readGeneration.current) return;
      reader.current = null;
      setValue(String(next.result || ''));
      setValueSource('file');
    };
    next.onerror = () => {
      if (generation !== readGeneration.current) return;
      reader.current = null;
      setNotice({ tone: 'error', text: 'That file could not be read.' });
    };
    next.readAsText(file);
  };

  const atLimit = Boolean(view && view.slots.length >= view.limits.maxSlots);
  const button = 'inline-flex min-h-[32px] items-center gap-1.5 rounded px-2 text-slate-300 hover:bg-white/5 hover:text-white disabled:opacity-40';

  return (
    <section aria-label="App credentials" className="space-y-2 rounded-lg border border-white/5 bg-white/[0.02] p-3 text-xs">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-1.5 font-medium text-slate-200"><KeyRound size={12} aria-hidden="true" />Credentials</h3>
        <button type="button" onClick={() => void load()} disabled={Boolean(busy)} aria-label="Refresh App credentials"
          className="inline-flex size-7 items-center justify-center rounded text-slate-400 hover:text-white disabled:opacity-40">
          <RefreshCw size={12} className={busy === 'load' ? 'animate-spin' : ''} />
        </button>
      </div>
      {loadError && <p role="alert" className="text-amber-200">{loadError}</p>}
      {notice && <p role={notice.tone === 'error' ? 'alert' : 'status'} className={notice.tone === 'error' ? 'text-red-300' : 'text-emerald-300'}>{notice.text}</p>}
      {view?.runtime.restartRequired && (
        <p role="status" className="text-amber-200">Credentials changed since this App started. Restart the App to apply them.</p>
      )}
      {view && (
        view.slots.length === 0
          ? <p className="text-slate-400">No credentials yet.</p>
          : (
            <ul className="space-y-1.5">
              {view.slots.map((entry) => (
                <li key={entry.slot} className="flex flex-wrap items-center justify-between gap-2">
                  <span className="min-w-0">
                    <code className="text-slate-200">{entry.slot}</code>
                    <span className="block text-[11px] text-slate-500">Set {when(entry.updatedAt)} by {author(entry)} · revision {entry.revision}</span>
                  </span>
                  <span className="flex gap-1">
                    <button type="button" className={button} disabled={Boolean(busy)}
                      onClick={() => { closeEditor(); setNotice(null); setEditor({ mode: 'replace', slot: entry.slot, revision: entry.revision }); }}
                      aria-label={`Replace ${entry.slot}`}>Replace</button>
                    <button type="button" className={`${button} text-red-300`} disabled={Boolean(busy)}
                      onClick={() => setRemoving(entry)} aria-label={`Remove ${entry.slot}`}><Trash2 size={12} aria-hidden="true" />Remove</button>
                  </span>
                </li>
              ))}
            </ul>
          )
      )}
      {view && !editor && (
        <button type="button" className={`${button} border border-white/10`} disabled={Boolean(busy) || atLimit}
          onClick={() => { closeEditor(); setNotice(null); setEditor({ mode: 'add' }); }}>
          Add credential
        </button>
      )}
      {view && atLimit && !editor && <p className="text-slate-500">This App holds the maximum of {view.limits.maxSlots} credentials.</p>}
      {editor && (
        <form onSubmit={save} className="space-y-2 rounded border border-white/10 p-2" noValidate>
          {editor.mode === 'add'
            ? (
              <div className="space-y-1">
                <label htmlFor={`${idPrefix}-slot`} className="block text-slate-400">Name</label>
                <input id={`${idPrefix}-slot`} value={slotName} onChange={(event) => setSlotName(event.target.value)}
                  autoComplete="off" spellCheck={false} placeholder="api-token" maxLength={63}
                  aria-invalid={slotInvalid} aria-describedby={`${idPrefix}-slot-help`}
                  className="min-h-[36px] w-full rounded border border-white/10 bg-[#11162f] px-2 text-slate-100" />
                <p id={`${idPrefix}-slot-help`} className={slotInvalid ? 'text-red-300' : 'text-slate-500'}>
                  Lowercase letters, digits and hyphens, starting with a letter. The App reads it at /portal/credentials/&lt;name&gt;.
                </p>
              </div>
            )
            : <p className="text-slate-300">Replace <code>{editor.slot}</code> (revision {editor.revision}).</p>}
          <div className="space-y-1">
            <label htmlFor={`${idPrefix}-value`} className="block text-slate-400">Value (hidden; never shown again)</label>
            <input id={`${idPrefix}-value`} type="password" value={valueSource ? '' : value}
              readOnly={Boolean(valueSource)} placeholder={valueSource ? 'Value loaded' : undefined}
              onChange={(event) => { cancelFileRead(); setValue(event.target.value); }}
              onPaste={(event) => {
                const pasted = event.clipboardData.getData('text/plain');
                if (/[\r\n]/.test(pasted)) {
                  event.preventDefault();
                  cancelFileRead();
                  setValue(pasted);
                  setValueSource('paste');
                }
              }}
              autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
              data-1p-ignore="true" data-lpignore="true" aria-invalid={tooLarge}
              aria-describedby={valueSource ? `${idPrefix}-loaded-value` : undefined}
              className="min-h-[36px] w-full rounded border border-white/10 bg-[#11162f] px-2 py-1 font-mono text-slate-100" />
            {valueSource && <p id={`${idPrefix}-loaded-value`} className="text-slate-400">
              {valueSource === 'file' ? 'File loaded.' : 'Multiline value loaded.'} The complete value will be saved without displaying it.{' '}
              <button type="button" disabled={busy === 'save'} className="underline hover:text-white"
                onClick={() => { cancelFileRead(); setValue(''); setValueSource(null); if (fileInput.current) fileInput.current.value = ''; }}>Clear value</button>
            </p>}
            {tooLarge && <p className="text-red-300">The value is larger than {maxBytes} bytes.</p>}
            <div>
              <input ref={fileInput} id={`${idPrefix}-file`} type="file" className="peer sr-only" onChange={readFile} disabled={busy === 'save'} />
              <label htmlFor={`${idPrefix}-file`} className={`${button} w-fit cursor-pointer border border-white/10 peer-focus-visible:ring-2 peer-focus-visible:ring-sky-400`}>
                <Upload size={12} aria-hidden="true" />Load from a file
              </label>
            </div>
          </div>
          <div className="flex gap-2">
            <button type="submit" disabled={!canSave} aria-busy={busy === 'save'}
              className={`${button} border border-emerald-500/30 bg-emerald-500/10 text-emerald-200`}>
              {busy === 'save' ? <Loader2 size={12} className="animate-spin" /> : null}
              {editor.mode === 'add' ? 'Add' : 'Replace'}
            </button>
            <button type="button" className={button} onClick={closeEditor} disabled={busy === 'save'}>Cancel</button>
          </div>
        </form>
      )}
      <p className="text-[11px] text-slate-500">
        Only this App&apos;s own container receives them, as read-only files in {view?.containerDirectory || '/portal/credentials'} (PORTAL_CREDENTIALS_DIR). Changes take effect the next time the App starts or is redeployed. Lifecycle jobs and Project Chat do not receive them.
      </p>
      <ConfirmDialog
        open={Boolean(removing)}
        title="Remove credential?"
        message={removing ? `Remove "${removing.slot}" from this App?` : ''}
        detail="The App loses it the next time it starts or is redeployed. This cannot be undone; you would have to enter the value again."
        confirmLabel="Remove"
        busy={busy === 'remove'}
        busyLabel="Removing…"
        onConfirm={remove}
        onCancel={() => setRemoving(null)}
      />
    </section>
  );
}

export default function ProjectAppCredentials({ appId, canManage }: { appId: string; canManage: boolean }) {
  if (!canManage) {
    return (
      <section aria-label="App credentials" className="space-y-1 rounded-lg border border-white/5 bg-white/[0.02] p-3 text-xs">
        <h3 className="flex items-center gap-1.5 font-medium text-slate-200"><KeyRound size={12} aria-hidden="true" />Credentials</h3>
        <p className="text-slate-400">App credentials are managed by the Portal owner.</p>
      </section>
    );
  }
  return <CredentialsManager key={appId} appId={appId} />;
}
