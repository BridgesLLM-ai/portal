import { useEffect, useState } from 'react';
import client from '../api/client';
import { useAuthStore } from '../contexts/AuthContext';

type Lease = { sessionKey: string; agentId: string; mode: 'human' | 'agent' | 'taking-control' | 'revoked'; revision: number; handoverRequested: boolean };
type AgentChatSession = { sessionId: string; title?: string; metadata?: { executionScope?: string } };
type Page = { targetId: string; title: string };
export default function SharedBrowserPanel() {
  const userId = useAuthStore(state => state.user?.id);
  const [open, setOpen] = useState(() => new URLSearchParams(window.location.search).get('panel') === 'browser');
  const [lease, setLease] = useState<Lease | null>(null);
  const [sessions, setSessions] = useState<Array<{ sessionKey: string; name: string }>>([]);
  const [selection, setSelection] = useState('');
  const [pages, setPages] = useState<Page[]>([]);
  const [target, setTarget] = useState('');
  const [image, setImage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener('portal:open-shared-browser', show);
    return () => window.removeEventListener('portal:open-shared-browser', show);
  }, []);
  useEffect(() => {
    setSessions([]); setSelection('');
    if (!open || !userId) return;
    let cancelled = false;
    let inFlight = false;
    const refresh = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const state = (await client.get('/shared-browser/state')).data;
        if (cancelled) return;
        setAvailable(true); setLease(state.lease); setError('');
        if (state.lease) {
          const tabs = (await client.get('/shared-browser/pages')).data.pages;
          if (!cancelled) setPages(tabs);
        } else if (!cancelled) { setPages([]); setTarget(''); }
      } catch (err: any) {
        if (!cancelled) { setAvailable(false); setLease(null); setError(err?.response?.data?.error || 'Shared browser unavailable'); }
      } finally { inFlight = false; }
    };
    void client.get('/gateway/sessions', { params: { provider: 'OPENCLAW' } }).then(response => {
      // Real Agent Chat summaries, not the cron/subagent Tasks projection.
      // Mirror the selection boundary; the server still revalidates access.
      const rows: AgentChatSession[] = Array.isArray(response.data.sessions) ? response.data.sessions : [];
      const owned = rows.filter(row => {
        const match = typeof row?.sessionId === 'string'
          ? /^agent:([a-z0-9][a-z0-9_-]{0,63}):(portal-[^:]+)$/.exec(row.sessionId) : null;
        if (!match || row.metadata?.executionScope === 'PROJECT_SANDBOX') return false;
        const [, agentId, sessionName] = match;
        if (agentId === 'portal' || /^portal-[0-9a-f]{8}-/.test(agentId)) return false;
        return sessionName === `portal-${userId}` || sessionName.startsWith(`portal-${userId}-`);
      });
      if (!cancelled) setSessions(owned.map(row => ({ sessionKey: row.sessionId, name: row.title || row.sessionId })));
    }).catch(() => { if (!cancelled) setError(current => current || 'Agent Chat session list unavailable'); });
    void refresh();
    const timer = setInterval(() => void refresh(), 1500);
    return () => { cancelled = true; clearInterval(timer); };
  }, [open, userId]);
  useEffect(() => {
    if (!open || !lease || lease.mode !== 'agent' || !target || !pages.some(page => page.targetId === target)) { setImage(''); return; }
    let cancelled = false;
    let inFlight = false;
    let currentUrl = '';
    const refresh = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const response = await client.get(`/shared-browser/screenshot/${encodeURIComponent(target)}`, { responseType: 'blob' });
        if (cancelled) return;
        const url = URL.createObjectURL(response.data);
        if (currentUrl) URL.revokeObjectURL(currentUrl);
        currentUrl = url; setImage(url);
      } catch { if (!cancelled) { setImage(''); setError('Selected browser tab preview unavailable'); } }
      finally { inFlight = false; }
    };
    void refresh(); const timer = setInterval(() => void refresh(), 1500);
    return () => { cancelled = true; clearInterval(timer); if (currentUrl) URL.revokeObjectURL(currentUrl); };
  }, [open, lease?.mode, lease?.sessionKey, target, pages.map(page => page.targetId).join('|')]);
  const act = async (action: string) => {
    setBusy(true); setError('');
    try {
      const response = action === 'select'
        ? await client.post('/shared-browser/select', { sessionKey: selection })
        : await client.post('/shared-browser/control', { revision: lease?.revision, action });
      setLease(response.data.lease); setTarget(''); setImage('');
    } catch (err: any) { setError(err?.response?.data?.error || 'Shared browser control unavailable'); }
    finally { setBusy(false); }
  };
  return <section className="shrink-0 border-b border-white/10 bg-slate-950 p-3 text-sm text-slate-200" aria-label="Shared interactive browser">
    <button type="button" className="font-semibold" aria-expanded={open} onClick={() => setOpen(!open)}>Shared interactive browser {open ? '▴' : '▾'}</button>
    {open && <div className="mt-2 max-h-[60vh] overflow-auto space-y-2">
      <p>Opt-in dedicated browser for you and one selected Agent Chat. Its persistent logins stay with the commissioned owner; it does not import your existing browser profile. Project App browsers are separate.</p>
      {error && <p role="alert" className="text-amber-300">{error}</p>}
      {!lease && available && <div className="flex flex-wrap gap-2">
        <select aria-label="Owned Agent Chat session" value={selection} onChange={event => setSelection(event.target.value)} className="bg-slate-800 p-2 rounded">
          <option value="">Select an Agent Chat session</option>
          {sessions.map(row => <option key={row.sessionKey} value={row.sessionKey}>{row.name || row.sessionKey}</option>)}
        </select>
        <button disabled={busy || !selection} onClick={() => void act('select')}>Select browser (human control)</button>
      </div>}
      {lease && <>
        <p className="break-all">{lease.agentId} · {lease.sessionKey} · {lease.mode === 'taking-control' ? 'Waiting for active browser action to finish' : lease.mode === 'human' ? 'You have control' : lease.mode === 'revoked' ? 'Selection revoked' : 'Agent has control'}</p>
        {lease.handoverRequested && <p role="status">The agent requests your help in this browser.</p>}
        <div className="flex flex-wrap gap-4">
          <button disabled={busy || lease.mode !== 'agent'} onClick={() => void act('take')}>Take control</button>
          <button disabled={busy || lease.mode !== 'human'} onClick={() => void act('return')}>Return to agent</button>
          {lease.handoverRequested && <button disabled={busy} onClick={() => void act('decline')}>Decline</button>}
          <button disabled={busy || lease.mode === 'taking-control'} onClick={() => void act('release')}>Release selection</button>
        </div>
        {lease.mode === 'human' && <iframe key={`${lease.sessionKey}:${lease.revision}`} title="Shared browser desktop" className="w-full h-[360px] border-0" src="/novnc/vnc.html?path=api%2Fshared-browser%2Fdesktop&autoconnect=1&resize=scale&reconnect=0" allow="clipboard-read; clipboard-write" />}
        {lease.mode === 'agent' && <>
          <select aria-label="Browser tab preview" value={target} onChange={event => setTarget(event.target.value)} className="bg-slate-800 p-2 rounded">
            <option value="">Select a tab to preview</option>
            {pages.map(page => <option value={page.targetId} key={page.targetId}>{page.title}</option>)}
          </select>
          {image && <img src={image} alt="Selected shared browser tab" className="max-h-[360px] max-w-full" />}
        </>}
      </>}
    </div>}
  </section>;
}
