import React, { useState, useEffect, useCallback } from 'react';
import client from '../api/client';

interface ProxyStatus {
  available: boolean;
  backend: string;
  version: string | null;
  models: Array<{ name: string; size: string; family: string }>;
  runningModels: string[];
  isGpu: boolean;
}

interface OllamaControlProps {
  collapsed?: boolean;
}

// Module-level cache: status survives component remounts (nav switches).
// A single shared polling interval ensures only one request is ever in-flight.
let _cachedStatus: ProxyStatus | null = null;
let _subscribers: Set<(s: ProxyStatus | null) => void> = new Set();
let _intervalId: ReturnType<typeof setInterval> | null = null;

async function _fetchStatus() {
  try {
    const res = await client.get('/system-control/ollama/proxy-status');
    _cachedStatus = res.data;
  } catch {
    _cachedStatus = { available: false, backend: 'offline', version: null, models: [], runningModels: [], isGpu: false };
  }
  _subscribers.forEach(fn => fn(_cachedStatus));
}

function subscribeOllamaStatus(fn: (s: ProxyStatus | null) => void): () => void {
  _subscribers.add(fn);
  // Deliver cached value immediately if we have one
  if (_cachedStatus !== null) fn(_cachedStatus);
  // Start shared interval if not already running
  if (!_intervalId) {
    _fetchStatus(); // immediate first fetch
    _intervalId = setInterval(_fetchStatus, 15000);
  }
  return () => {
    _subscribers.delete(fn);
    if (_subscribers.size === 0 && _intervalId) {
      clearInterval(_intervalId);
      _intervalId = null;
    }
  };
}

const OllamaControl: React.FC<OllamaControlProps> = ({ collapsed = false }) => {
  const [status, setStatus] = useState<ProxyStatus | null>(_cachedStatus);
  const [expanded, setExpanded] = useState(false);
  const [actionMsg, setActionMsg] = useState('');

  const fetchStatus = useCallback(() => { _fetchStatus(); }, []);

  useEffect(() => {
    return subscribeOllamaStatus(setStatus);
  }, []);

  if (!status) return null;

  const backendLabel = status.isGpu ? 'GPU' : status.available ? 'CPU' : 'Off';
  const backendDetail = status.isGpu ? 'Legion 4070' : status.available ? 'Server CPU' : 'Unavailable';
  const dotColor = status.isGpu ? 'bg-emerald-400' : status.available ? 'bg-amber-400' : 'bg-gray-500';
  const textColor = status.isGpu ? 'text-emerald-400' : status.available ? 'text-amber-400' : 'text-gray-500';

  return (
    <div className="relative">
      {/* Sidebar button */}
      <button
        onClick={() => setExpanded(!expanded)}
        className={`flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-200 w-full
          ${expanded
            ? 'bg-white/[0.06] text-white border border-white/10'
            : 'text-slate-400 hover:text-white hover:bg-white/[0.04] border border-transparent'
          }`}
        title={`Ollama: ${backendDetail}`}
      >
        <div className="relative flex-shrink-0">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="4" y="4" width="16" height="16" rx="2" />
            <rect x="9" y="9" width="6" height="6" />
            <line x1="9" y1="1" x2="9" y2="4" /><line x1="15" y1="1" x2="15" y2="4" />
            <line x1="9" y1="20" x2="9" y2="23" /><line x1="15" y1="20" x2="15" y2="23" />
            <line x1="20" y1="9" x2="23" y2="9" /><line x1="20" y1="14" x2="23" y2="14" />
            <line x1="1" y1="9" x2="4" y2="9" /><line x1="1" y1="14" x2="4" y2="14" />
          </svg>
          <span className={`absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full ${dotColor} ${status.runningModels.length > 0 ? 'animate-pulse' : ''}`} />
        </div>
        {!collapsed && (
          <div className="flex items-center justify-between flex-1 min-w-0">
            <span>Ollama</span>
            <span className={`text-[10px] font-semibold ${textColor}`}>{backendLabel}</span>
          </div>
        )}
      </button>

      {/* Expanded panel (popover) */}
      {expanded && (
        <div className="absolute bottom-full left-0 mb-2 bg-[#0d1117] border border-gray-700/50 rounded-xl shadow-2xl p-4 min-w-[280px] backdrop-blur-sm z-50"
          style={{ width: collapsed ? 280 : '100%', minWidth: 280 }}
        >
          <div className="flex justify-between items-center mb-3">
            <div className="flex items-center gap-2">
              <span className="text-lg">{status.isGpu ? '⚡' : status.available ? '🔄' : '⚫'}</span>
              <div>
                <h3 className="text-white font-semibold text-sm">Ollama {status.isGpu ? 'GPU' : 'CPU'}</h3>
                <p className="text-[10px] text-slate-400">{backendDetail} • v{status.version || '?'}</p>
              </div>
            </div>
            <button onClick={() => setExpanded(false)} className="text-gray-500 hover:text-white text-lg leading-none">×</button>
          </div>

          {/* Backend indicator */}
          <div className={`rounded-lg px-3 py-2 mb-3 ${status.isGpu ? 'bg-emerald-500/10 border border-emerald-500/20' : status.available ? 'bg-amber-500/10 border border-amber-500/20' : 'bg-gray-500/10 border border-gray-500/20'}`}>
            <div className="flex items-center justify-between">
              <span className={`text-xs font-medium ${status.isGpu ? 'text-emerald-400' : status.available ? 'text-amber-400' : 'text-gray-400'}`}>
                {status.isGpu ? '🖥️ Remote GPU Active' : status.available ? '💻 Local CPU Fallback' : '🔌 Disconnected'}
              </span>
              <span className={`text-[10px] ${status.isGpu ? 'text-emerald-500' : status.available ? 'text-amber-500' : 'text-gray-500'}`}>
                {status.backend}
              </span>
            </div>
          </div>

          {/* Running models */}
          {status.runningModels.length > 0 && (
            <div className="mb-3">
              <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">Running</div>
              {status.runningModels.map((model, idx) => (
                <div key={idx} className="text-xs text-blue-300 flex items-center gap-1.5 py-0.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
                  <span className="truncate">{model}</span>
                </div>
              ))}
            </div>
          )}

          {/* Available models */}
          {status.models.length > 0 && (
            <div>
              <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">Available Models</div>
              <div className="space-y-0.5 max-h-32 overflow-y-auto">
                {status.models.map((model, idx) => (
                  <div key={idx} className="flex items-center justify-between text-[11px] py-0.5">
                    <span className="text-slate-300 truncate">{model.name}</span>
                    <span className="text-slate-500 ml-2 flex-shrink-0">{model.size}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {!status.available && (
            <p className="text-xs text-slate-500 text-center py-2">
              No Ollama backend available.<br />
              <span className="text-[10px]">Start Ollama on Legion or server.</span>
            </p>
          )}

          {/* Kill / Restart controls */}
          {status.available && (
            <div className="flex gap-2 mt-3 pt-3 border-t border-white/5">
              <button
                onClick={async () => {
                  if (!confirm('🛑 Kill all Ollama runners?\n\nThis will unload models from memory.')) return;
                  setActionMsg('Killing...');
                  try {
                    await client.post('/system-control/ollama/kill');
                    setActionMsg('✅ Killed');
                    fetchStatus();
                  } catch { setActionMsg('❌ Failed'); }
                  setTimeout(() => setActionMsg(''), 3000);
                }}
                className="flex-1 bg-red-500/15 hover:bg-red-500/25 border border-red-500/20 text-red-400 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
              >
                🛑 Kill
              </button>
              <button
                onClick={async () => {
                  if (!confirm('🔄 Restart Ollama service?')) return;
                  setActionMsg('Restarting...');
                  try {
                    await client.post('/system-control/ollama/restart');
                    setActionMsg('✅ Restarted');
                    fetchStatus();
                  } catch { setActionMsg('❌ Failed'); }
                  setTimeout(() => setActionMsg(''), 3000);
                }}
                className="flex-1 bg-blue-500/15 hover:bg-blue-500/25 border border-blue-500/20 text-blue-400 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
              >
                🔄 Restart
              </button>
            </div>
          )}

          {actionMsg && (
            <div className="mt-2 text-center text-xs text-slate-400">{actionMsg}</div>
          )}
        </div>
      )}
    </div>
  );
};

export default OllamaControl;
