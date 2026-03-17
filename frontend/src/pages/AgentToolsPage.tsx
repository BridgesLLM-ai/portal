import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { io, Socket } from 'socket.io-client';
import { RefreshCw, Wrench, Play, ShieldAlert, Loader2, CheckCircle2, XCircle, Trash2 } from 'lucide-react';
import { agentToolsAPI, AgentTool } from '../api/agentTools';
import { useAuthStore } from '../contexts/AuthContext';
import { isElevated } from '../utils/authz';

type InstallState = {
  toolId: string;
  lines: string[];
  status: 'running' | 'success' | 'error';
};

export default function AgentToolsPage() {
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const isAdmin = isElevated(user);

  const [tools, setTools] = useState<AgentTool[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);
  const [installState, setInstallState] = useState<InstallState | null>(null);
  const [error, setError] = useState('');

  const socketRef = useRef<Socket | null>(null);

  const load = async () => {
    try {
      setError('');
      const data = await agentToolsAPI.list();
      setTools(data.tools || []);
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Failed to load tools');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    return () => {
      socketRef.current?.disconnect();
      socketRef.current = null;
    };
  }, []);

  const setupInstallSocket = (toolId: string) => {
    socketRef.current?.disconnect();

    const wsUrl = import.meta.env.VITE_WS_URL || window.location.origin;
    const socket: Socket = io(`${wsUrl}/ws/agent-jobs`, {
      transports: ['websocket'],
    });

    socket.on('connect', () => {
      socket.emit('subscribe-tool-install', { toolId });
    });

    socket.on('output', ({ toolId: eventToolId, entry }: { toolId?: string; entry?: { text?: string } }) => {
      if (!entry?.text || eventToolId !== toolId) return;

      const text = entry.text;
      const nextLines = text
        .replace(/\r/g, '')
        .split('\n')
        .filter((line) => line.length > 0);

      setInstallState((prev) => {
        if (!prev || prev.toolId !== toolId) return prev;

        let status = prev.status;
        if (text.includes('✅ Install finished')) status = 'success';
        if (text.includes('❌ Install failed')) status = 'error';

        return {
          ...prev,
          lines: [...prev.lines, ...nextLines],
          status,
        };
      });

      if (text.includes('✅ Install finished') || text.includes('❌ Install failed')) {
        setInstalling(null);
        if (text.includes('✅ Install finished')) {
          load();
        }
      }
    });

    socketRef.current = socket;
  };

  const handleInstall = async (toolId: string) => {
    if (!isAdmin) return;

    setInstallState({ toolId, lines: [], status: 'running' });
    setInstalling(toolId);
    setupInstallSocket(toolId);

    try {
      await agentToolsAPI.install(toolId);
    } catch (err: any) {
      const message = err?.response?.data?.error || `Failed to install ${toolId}`;
      setInstallState({ toolId, lines: [message], status: 'error' });
      setError(message);
      setInstalling(null);
      socketRef.current?.disconnect();
      socketRef.current = null;
    }
  };

  const clearInstallLog = (toolId: string) => {
    if (installState?.toolId !== toolId || installState.status === 'running') return;
    setInstallState(null);
    socketRef.current?.disconnect();
    socketRef.current = null;
  };

  const handleTestRun = (tool: AgentTool) => {
    const detectCommand = tool.detect?.command || (tool.commands.find((c) => c.command.includes('--version'))?.command || 'echo "No test command"');
    navigate('/agent-chats', {
      state: {
        startJob: {
          toolId: tool.id,
          title: `${tool.name}: version check`,
          command: detectCommand,
        },
      },
    });
  };

  return (
    <div className="h-full overflow-y-auto p-6 bg-[#0A0E27] text-white">
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold">Agent Tools</h1>
            <p className="text-slate-400 text-sm mt-1">Tiered adapters, runtime detection, and install actions.</p>
          </div>
          <button
            onClick={() => { setRefreshing(true); load(); }}
            className="px-3 py-2 rounded-lg bg-white/10 hover:bg-white/15 text-sm inline-flex items-center gap-2"
          >
            <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>

        {!isAdmin && (
          <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 p-3 text-amber-200 text-sm flex items-center gap-2">
            <ShieldAlert size={16} />
            Install/update actions are admin-only.
          </div>
        )}

        {error && <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-red-300 text-sm">{error}</div>}

        {loading ? (
          <div className="text-slate-400">Loading tools…</div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {tools.map((tool) => {
              const installed = tool.status?.installed;
              const isLogOpen = installState?.toolId === tool.id;
              const isRunning = isLogOpen && installState?.status === 'running';
              const isSuccess = isLogOpen && installState?.status === 'success';
              const isFailure = isLogOpen && installState?.status === 'error';

              return (
                <div key={tool.id} className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h2 className="font-semibold text-lg">{tool.name}</h2>
                      <p className="text-sm text-slate-400">{tool.description}</p>
                    </div>
                    <span className={`px-2 py-1 rounded text-xs font-medium ${tool.tier === 1 ? 'bg-emerald-500/20 text-emerald-300' : 'bg-slate-500/20 text-slate-300'}`}>
                      Tier {tool.tier}
                    </span>
                  </div>

                  <div className="text-sm">
                    {installed ? (
                      <span className="text-emerald-300">Installed {tool.status.version ? `(${tool.status.version})` : ''}</span>
                    ) : (
                      <span className="text-red-300">Not installed</span>
                    )}
                  </div>

                  {tool.authRequired && tool.authHint && (
                    <div className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded p-2">{tool.authHint}</div>
                  )}

                  <div className="text-xs text-slate-400 space-y-1">
                    {tool.commands.filter((c) => c.command).slice(0, 4).map((cmd) => (
                      <div key={`${tool.id}-${cmd.command}`} className="font-mono truncate">• {cmd.command}</div>
                    ))}
                  </div>

                  <div className="flex flex-wrap gap-2 pt-1">
                    {isAdmin && tool.install.length > 0 && (
                      <button
                        onClick={() => handleInstall(tool.id)}
                        disabled={installing === tool.id}
                        className="px-3 py-1.5 rounded-lg bg-emerald-600/80 hover:bg-emerald-500 disabled:opacity-60 text-xs inline-flex items-center gap-1"
                      >
                        <Wrench size={12} /> {installed ? 'Update' : 'Install'}
                      </button>
                    )}

                    <button
                      onClick={() => handleTestRun(tool)}
                      className="px-3 py-1.5 rounded-lg bg-blue-600/80 hover:bg-blue-500 text-xs inline-flex items-center gap-1"
                    >
                      <Play size={12} /> Test run
                    </button>
                  </div>

                  {isLogOpen && (
                    <div className="mt-3 rounded-xl border border-white/10 bg-black/30 p-3 space-y-2">
                      <div className="flex items-center justify-between text-xs">
                        <div className="inline-flex items-center gap-1.5 text-slate-300">
                          {isRunning && <Loader2 size={14} className="animate-spin text-blue-300" />}
                          {isSuccess && <CheckCircle2 size={14} className="text-emerald-300" />}
                          {isFailure && <XCircle size={14} className="text-red-300" />}
                          {isRunning ? 'Installing…' : isSuccess ? 'Install complete' : 'Install failed'}
                        </div>

                        {!isRunning && (
                          <button
                            onClick={() => clearInstallLog(tool.id)}
                            className="inline-flex items-center gap-1 text-slate-300 hover:text-white"
                          >
                            <Trash2 size={12} /> Clear
                          </button>
                        )}
                      </div>

                      <div className="max-h-[200px] overflow-y-auto rounded bg-black/50 border border-white/5 p-2 font-mono text-[11px] leading-5 text-slate-200 whitespace-pre-wrap">
                        {(installState?.lines.length || 0) === 0 ? 'Waiting for install logs…' : installState?.lines.join('\n')}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
