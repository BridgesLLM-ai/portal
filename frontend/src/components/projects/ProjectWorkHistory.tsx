import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../../contexts/AuthContext';
import client from '../../api/client';
import { projectWorkLink } from '../../utils/projectWorkNavigation';
import type { WorkCard } from '../chat/ProjectWork';

/** A second view of the same links and turns; this never starts work. */
export default function ProjectWorkHistory({ projectIdentityId }: { projectIdentityId: string }) {
  const user = useAuthStore((state) => state.user);
  const navigate = useNavigate();
  const [cards, setCards] = useState<WorkCard[]>([]);
  const [error, setError] = useState(false);
  useEffect(() => {
    let cancelled = false; setCards([]); setError(false);
    if (!user || !['OWNER', 'SUB_ADMIN'].includes(user.role)) return;
    const load = async () => {
      try {
        const { data } = await client.get('/project-work', { params: { projectIdentityId }, _silent: true } as any);
        if (!cancelled) { setCards(data.cards); setError(false); }
      } catch { if (!cancelled) setError(true); }
    };
    void load(); const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 5000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [projectIdentityId, user?.id, user?.role, user?.authorizationVersion]);
  if (!user || !['OWNER', 'SUB_ADMIN'].includes(user.role)) return null;
  return <section aria-label="Agent Chat work" className="border-b border-white/10 p-3">
    <h4 className="mb-2 text-xs font-medium text-cyan-200">Agent Chat work</h4>
    {error ? <p role="alert" className="text-xs text-amber-200">Work history is temporarily unavailable.</p>
      : !cards.length ? <p className="text-xs text-slate-500">Project work started from Agent Chat appears here too.</p>
      : cards.slice(-20).reverse().map((card) => <button type="button" key={card.id} className="mb-1 w-full rounded-lg bg-white/[0.03] p-2 text-left hover:bg-white/[0.07]" onClick={() => navigate(projectWorkLink({ projectIdentityId: card.projectIdentityId, projectGeneration: card.projectGeneration, cardId: card.id, originProvider: card.originProvider, originSessionKey: card.originSessionKey }, { actorUserId: user.id, authorizationVersion: user.authorizationVersion ?? 1 }))}>
        <p className="line-clamp-2 text-xs text-slate-200">{card.prompt}</p><p className="mt-1 text-[10px] text-slate-400">{card.turn?.status === 'COMPLETED' ? 'Agent finished' : card.turn?.status === 'RUNNING' ? 'Working' : card.turn?.status ? 'Needs attention' : 'Not started'} · Open in Agent Chat</p>
      </button>)}
  </section>;
}
