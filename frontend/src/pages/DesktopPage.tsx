import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { Monitor, Maximize2, Minimize2, RefreshCw, ExternalLink, AlertTriangle, Wifi, WifiOff, Settings, Play, Volume2, VolumeX } from 'lucide-react';

type RemoteDesktopHealth = 'loading' | 'ready' | 'degraded' | 'unavailable';

type DesktopConfigState =
  | { kind: 'ok'; url: URL }
  | { kind: 'loading' }
  | { kind: 'unconfigured' }
  | { kind: 'invalid'; reason: string };

const normalizePrefix = (value: string): string => {
  const cleaned = value.trim();
  if (!cleaned) return '';
  return cleaned.startsWith('/') ? cleaned : `/${cleaned}`;
};

export default function DesktopPage() {
  const navigate = useNavigate();
  const [fullscreen, setFullscreen] = useState(false);
  const [scale, setScale] = useState(100);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const iframeEverLoaded = useRef(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<'connecting' | 'connected' | 'error'>('error');
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [remoteDesktopUrl, setRemoteDesktopUrl] = useState('');
  const [allowedPrefixesRaw, setAllowedPrefixesRaw] = useState('/novnc,/vnc');
  const [configLoading, setConfigLoading] = useState(true);
  const [healthStatus, setHealthStatus] = useState<RemoteDesktopHealth>('loading');
  const [healthMessage, setHealthMessage] = useState<string | null>(null);
  const [setupRunning, setSetupRunning] = useState(false);
  const [setupResult, setSetupResult] = useState<{ ok: boolean; message: string } | null>(null);
  // Track whether backend reports services not installed (no systemd units)
  const [servicesInstalled, setServicesInstalled] = useState<boolean | null>(null);

  // Audio state
  const [audioEnabled, setAudioEnabled] = useState(false);
  const [audioConnected, setAudioConnected] = useState(false);
  const audioWsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioGainRef = useRef<GainNode | null>(null);
  const [audioVolume, setAudioVolume] = useState(0.8);
  const audioVolumeRef = useRef(0.8); // Ref mirror to avoid closure staleness
  const audioReconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const audioEnabledRef = useRef(false); // Ref mirror for reconnect logic
  const nextPlayTimeRef = useRef(0);
  const audioConfigRef = useRef({ sampleRate: 44100, channels: 2 });

  // Keep refs in sync
  useEffect(() => { audioVolumeRef.current = audioVolume; }, [audioVolume]);
  useEffect(() => { audioEnabledRef.current = audioEnabled; }, [audioEnabled]);

  // Create AudioContext on user gesture (critical for mobile Safari)
  const getOrCreateAudioContext = useCallback((): AudioContext | null => {
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      return audioContextRef.current;
    }
    try {
      // Safari fallback: webkitAudioContext
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) {
        console.error('[Audio] AudioContext not supported');
        return null;
      }
      const ctx = new AudioCtx({ sampleRate: audioConfigRef.current.sampleRate });
      const gain = ctx.createGain();
      gain.gain.value = audioVolumeRef.current;
      gain.connect(ctx.destination);
      audioContextRef.current = ctx;
      audioGainRef.current = gain;
      nextPlayTimeRef.current = ctx.currentTime;
      console.log('[Audio] AudioContext created (state:', ctx.state, ')');
      return ctx;
    } catch (err) {
      console.error('[Audio] Failed to create AudioContext:', err);
      return null;
    }
  }, []);

  // WebSocket connection (no dependencies that cause reconnects)
  const connectAudio = useCallback(() => {
    // Cleanup existing
    if (audioWsRef.current) {
      audioWsRef.current.close();
      audioWsRef.current = null;
    }
    if (audioReconnectTimer.current) {
      clearTimeout(audioReconnectTimer.current);
      audioReconnectTimer.current = null;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/novnc/audio`;
    
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
    } catch (err) {
      console.error('[Audio] WebSocket creation failed:', err);
      setAudioConnected(false);
      return;
    }
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      setAudioConnected(true);
      console.log('[Audio] WebSocket connected to', wsUrl);
    };

    let messageCount = 0;
    let totalBinaryBytes = 0;

    ws.onmessage = (event) => {
      messageCount++;
      if (typeof event.data === 'string') {
        // Config message from server
        console.log('[Audio] Config received:', event.data);
        try {
          const config = JSON.parse(event.data);
          if (config.type === 'config') {
            audioConfigRef.current = {
              sampleRate: config.sampleRate || 44100,
              channels: config.channels || 2,
            };
            console.log('[Audio] Config set:', audioConfigRef.current);
          }
        } catch { /* ignore parse errors */ }
        return;
      }

      // Binary PCM data
      totalBinaryBytes += event.data.byteLength;
      if (messageCount <= 5 || messageCount % 100 === 0) {
        console.log(`[Audio] Binary chunk #${messageCount}: ${event.data.byteLength} bytes (total: ${totalBinaryBytes})`);
      }

      const audioCtx = audioContextRef.current;
      const gainNode = audioGainRef.current;
      if (!audioCtx || !gainNode || audioCtx.state === 'closed') {
        if (messageCount <= 3) console.warn('[Audio] No AudioContext or gain node, dropping chunk. ctx:', audioCtx?.state, 'gain:', !!gainNode);
        return;
      }

      // Resume if suspended (autoplay policy — the initial resume happens on user gesture in toggleAudio)
      if (audioCtx.state === 'suspended') {
        console.log('[Audio] Resuming suspended AudioContext...');
        audioCtx.resume().catch((e) => console.error('[Audio] Resume failed:', e));
      }

      const { sampleRate, channels } = audioConfigRef.current;
      const pcmData = new Int16Array(event.data);
      const numSamples = Math.floor(pcmData.length / channels);
      if (numSamples <= 0) return;

      // Create audio buffer and decode
      const audioBuffer = audioCtx.createBuffer(channels, numSamples, sampleRate);
      for (let ch = 0; ch < channels; ch++) {
        const channelData = audioBuffer.getChannelData(ch);
        for (let i = 0; i < numSamples; i++) {
          channelData[i] = pcmData[i * channels + ch] / 32768;
        }
      }

      // Schedule playback with jitter buffer
      const source = audioCtx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(gainNode);

      const now = audioCtx.currentTime;
      let playAt = nextPlayTimeRef.current;

      // If we've fallen behind (tab was backgrounded, network lag, etc.),
      // skip ahead instead of playing a burst of stale audio
      if (playAt < now - 0.3) {
        // More than 300ms behind — hard reset, play almost immediately
        playAt = now + 0.01;
        if (messageCount <= 10) console.log('[Audio] Hard reset playback (was >300ms behind)');
      } else if (playAt < now) {
        // Slight drift — soft catch-up
        playAt = now + 0.005;
      }

      source.start(playAt);
      nextPlayTimeRef.current = playAt + audioBuffer.duration;
    };

    ws.onclose = (ev) => {
      setAudioConnected(false);
      console.log('[Audio] WebSocket disconnected (code:', ev.code, ')');
      audioWsRef.current = null;
      
      // Auto-reconnect if audio is still enabled (network hiccup, server restart)
      if (audioEnabledRef.current) {
        const delay = ev.code === 1000 ? 0 : 3000; // Clean close = no retry, abnormal = retry
        if (ev.code !== 1000) {
          console.log(`[Audio] Reconnecting in ${delay}ms...`);
          audioReconnectTimer.current = setTimeout(() => {
            if (audioEnabledRef.current) connectAudio();
          }, delay);
        }
      }
    };

    ws.onerror = () => {
      // Error fires before close — close handler does the reconnect
      setAudioConnected(false);
    };

    audioWsRef.current = ws;
  }, []);  // No deps — uses refs for all mutable state

  const disconnectAudio = useCallback(() => {
    if (audioReconnectTimer.current) {
      clearTimeout(audioReconnectTimer.current);
      audioReconnectTimer.current = null;
    }
    if (audioWsRef.current) {
      audioWsRef.current.close(1000, 'User disabled audio');
      audioWsRef.current = null;
    }
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
    audioGainRef.current = null;
    setAudioConnected(false);
  }, []);

  // Toggle audio — MUST be called from user gesture (click handler) for mobile Safari
  const toggleAudio = useCallback(() => {
    console.log('[Audio] Toggle clicked. Currently:', audioEnabled ? 'ON' : 'OFF');
    if (audioEnabled) {
      disconnectAudio();
      setAudioEnabled(false);
    } else {
      // Create AudioContext HERE in the click handler (user gesture requirement)
      const ctx = getOrCreateAudioContext();
      console.log('[Audio] AudioContext:', ctx?.state, 'sampleRate:', ctx?.sampleRate);
      if (ctx && ctx.state === 'suspended') {
        ctx.resume().then(() => console.log('[Audio] AudioContext resumed')).catch((e) => console.error('[Audio] Resume failed:', e));
      }
      setAudioEnabled(true);
      connectAudio();
    }
  }, [audioEnabled, connectAudio, disconnectAudio, getOrCreateAudioContext]);

  // Update volume via ref + gain node (no reconnect)
  useEffect(() => {
    if (audioGainRef.current) {
      audioGainRef.current.gain.setValueAtTime(audioVolume, audioContextRef.current?.currentTime || 0);
    }
  }, [audioVolume]);

  // Handle page visibility changes (mobile tab switch, screen lock)
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && audioContextRef.current) {
        // Resume AudioContext when tab comes back to foreground
        if (audioContextRef.current.state === 'suspended') {
          audioContextRef.current.resume().catch(() => {});
        }
        // Reset play time to avoid burst playback of buffered chunks
        nextPlayTimeRef.current = audioContextRef.current.currentTime + 0.05;
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, []);

  // Cleanup audio on unmount
  useEffect(() => {
    return () => {
      if (audioReconnectTimer.current) clearTimeout(audioReconnectTimer.current);
      if (audioWsRef.current) audioWsRef.current.close(1000);
      if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
        audioContextRef.current.close().catch(() => {});
      }
    };
  }, []);

  useEffect(() => {
    const loadSettings = async () => {
      setConfigLoading(true);
      try {
        const apiUrl = import.meta.env.VITE_API_URL || '';
        const res = await fetch(`${apiUrl}/settings/public`);
        if (!res.ok) throw new Error('Failed to load settings');
        const data = await res.json();
        setRemoteDesktopUrl((data.remoteDesktopUrl || '').trim());
        setAllowedPrefixesRaw((data.remoteDesktopAllowedPathPrefixes || '/novnc,/vnc').trim());
      } catch {
        setRemoteDesktopUrl('');
        setAllowedPrefixesRaw('/novnc,/vnc');
      } finally {
        setConfigLoading(false);
      }
    };
    loadSettings();
  }, []);

  const configState = useMemo<DesktopConfigState>(() => {
    if (configLoading) return { kind: 'loading' };
    if (!remoteDesktopUrl) return { kind: 'unconfigured' };

    const allowedPrefixes = allowedPrefixesRaw
      .split(',')
      .map(normalizePrefix)
      .filter(Boolean);

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(remoteDesktopUrl, window.location.origin);
    } catch {
      return { kind: 'invalid', reason: 'remoteDesktop.url is not a valid URL.' };
    }

    const sameOrigin = parsedUrl.origin === window.location.origin;
    const allowedSameOriginPath = allowedPrefixes.some(prefix => parsedUrl.pathname.startsWith(prefix));

    if (sameOrigin && !allowedSameOriginPath) {
      return {
        kind: 'invalid',
        reason: `Remote Desktop URL points to disallowed same-origin path "${parsedUrl.pathname}". Allowed prefixes: ${allowedPrefixes.join(', ')}`,
      };
    }

    return { kind: 'ok', url: parsedUrl };
  }, [configLoading, remoteDesktopUrl, allowedPrefixesRaw]);

  const runAutoSetup = useCallback(async () => {
    setSetupRunning(true);
    setSetupResult(null);
    try {
      const apiUrl = import.meta.env.VITE_API_URL || '';
      const res = await fetch(`${apiUrl}/remote-desktop/auto-setup`, {
        method: 'POST',
        credentials: 'include',
      });
      const data = await res.json();
      if (data?.ok) {
        setSetupResult({ ok: true, message: 'Remote Desktop setup complete! Reloading...' });
        // Reload settings + health after brief delay
        setTimeout(() => window.location.reload(), 2000);
      } else {
        const failedSteps = (data?.steps || []).filter((s: any) => !s.ok).map((s: any) => s.step).join(', ');
        setSetupResult({ ok: false, message: `Setup finished with issues${failedSteps ? `: ${failedSteps}` : ''}. Check Settings → Remote Desktop for details.` });
      }
    } catch {
      setSetupResult({ ok: false, message: 'Auto-setup request failed. Make sure you have admin permissions.' });
    } finally {
      setSetupRunning(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    const loadHealth = async () => {
      if (configState.kind !== 'ok' && configState.kind !== 'unconfigured') {
        setHealthStatus(configState.kind === 'loading' ? 'loading' : 'unavailable');
        setHealthMessage(null);
        return;
      }

      setHealthStatus('loading');
      try {
        const apiUrl = import.meta.env.VITE_API_URL || '';
        const res = await fetch(`${apiUrl}/remote-desktop/status`, { credentials: 'include' });
        if (!res.ok) throw new Error(`Status check failed (${res.status})`);
        const data = await res.json();
        if (cancelled) return;

        // Track whether systemd units exist
        const checks = data?.diagnostics?.checks;
        if (checks) {
          setServicesInstalled(checks.vncServiceUnitPresent || checks.websockifyUnitPresent);
        }

        if (data?.status === 'ready') setHealthStatus('ready');
        else if (data?.status === 'degraded') setHealthStatus('degraded');
        else setHealthStatus('unavailable');

        setHealthMessage(data?.message || null);
      } catch {
        if (cancelled) return;
        setHealthStatus('unavailable');
        setHealthMessage('Remote Desktop health check failed.');
      }
    };

    loadHealth();
    const interval = window.setInterval(loadHealth, 15000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [configState]);

  const setupTimeout = (ms: number) => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      setError('Remote desktop backend is unavailable or not responding.');
      setConnectionStatus('error');
      setLoading(false);
    }, ms);
  };

  useEffect(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);

    if (configState.kind !== 'ok') {
      setLoading(false);
      setConnectionStatus('error');
      setError(configState.kind === 'invalid' ? configState.reason : null);
      return;
    }

    setLoading(true);
    setConnectionStatus('connecting');
    setError(null);
    setupTimeout(20000);

    return () => { if (timeoutRef.current) clearTimeout(timeoutRef.current); };
  }, [configState]);

  const toggleFullscreen = () => {
    if (!fullscreen) document.documentElement.requestFullscreen?.();
    else document.exitFullscreen?.();
    setFullscreen(!fullscreen);
  };

  const reload = () => {
    if (configState.kind !== 'ok') return;
    if (iframeRef.current) {
      setLoading(true);
      setError(null);
      setConnectionStatus('connecting');
      setupTimeout(15000);
      iframeRef.current.src = configState.url.toString();
    }
  };

  const handleLoad = () => {
    iframeEverLoaded.current = true;
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setLoading(false);
    setError(null);
    setConnectionStatus('connected');
    setTimeout(() => iframeRef.current?.focus(), 100);
  };

  const handleError = () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setLoading(false);
    setError('Failed to load remote desktop endpoint. Check backend/proxy availability.');
    setConnectionStatus('error');
  };

  const configUrl = configState.kind === 'ok' ? configState.url.toString() : '';

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className={`flex flex-col ${fullscreen ? 'fixed inset-0 z-50 bg-[#0A0E27]' : 'h-full'}`}>
      <div className="flex items-center justify-between px-2 sm:px-4 py-2 sm:py-3 border-b border-white/5 bg-[#0D1130]/80 backdrop-blur-xl flex-shrink-0">
        <div className="flex items-center gap-1.5 sm:gap-3 min-w-0">
          <Monitor size={16} className="text-emerald-400 flex-shrink-0" />
          <span className="font-medium text-sm hidden sm:inline">Remote Desktop</span>
          <span className={`inline-flex items-center gap-1 px-1.5 sm:px-2 py-0.5 rounded-full text-[10px] font-medium flex-shrink-0 ${connectionStatus === 'connected' ? 'bg-emerald-500/10 text-emerald-400' : connectionStatus === 'error' ? 'bg-red-500/10 text-red-400' : 'bg-amber-500/10 text-amber-400'}`}>
            {connectionStatus === 'connected' ? <Wifi size={10} /> : connectionStatus === 'error' ? <WifiOff size={10} /> : <div className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />}
            <span className="hidden sm:inline">{connectionStatus === 'connected' ? 'Connected' : connectionStatus === 'error' ? 'Disconnected' : 'Connecting...'}</span>
          </span>
          <span className={`inline-flex items-center gap-1 px-1.5 sm:px-2 py-0.5 rounded-full text-[10px] font-medium flex-shrink-0 ${healthStatus === 'ready' ? 'bg-emerald-500/10 text-emerald-400' : healthStatus === 'degraded' ? 'bg-amber-500/10 text-amber-400' : 'bg-red-500/10 text-red-400'}`}>
            {healthStatus === 'ready' ? <Wifi size={10} /> : <AlertTriangle size={10} />}
            <span className="hidden sm:inline">{healthStatus === 'ready' ? 'Backend ready' : healthStatus === 'degraded' ? 'Backend degraded' : healthStatus === 'loading' ? 'Checking backend...' : 'Backend unavailable'}</span>
          </span>
        </div>
        <div className="flex items-center gap-1 sm:gap-2 flex-shrink-0">
          <div className="hidden sm:flex items-center gap-1 mr-2">
            <button onClick={() => setScale(Math.max(50, scale - 10))} className="w-8 h-8 sm:w-6 sm:h-6 rounded-md bg-white/5 text-slate-400 hover:text-white flex items-center justify-center text-xs transition-colors">−</button>
            <span className="text-xs text-slate-400 w-10 text-center">{scale}%</span>
            <button onClick={() => setScale(Math.min(150, scale + 10))} className="w-8 h-8 sm:w-6 sm:h-6 rounded-md bg-white/5 text-slate-400 hover:text-white flex items-center justify-center text-xs transition-colors">+</button>
          </div>
          <button onClick={reload} className="p-2 rounded-lg hover:bg-white/5 text-slate-400 hover:text-white transition-colors min-w-[44px] min-h-[44px] flex items-center justify-center" title="Reload" disabled={configState.kind !== 'ok'}><RefreshCw size={16} className={loading ? 'animate-spin' : ''} /></button>
          {configState.kind === 'ok' && (
            <a href={configUrl} target="_blank" rel="noopener noreferrer" className="p-2 rounded-lg hover:bg-white/5 text-slate-400 hover:text-white transition-colors min-w-[44px] min-h-[44px] items-center justify-center hidden sm:flex" title="Open in new tab"><ExternalLink size={16} /></a>
          )}
          {/* Audio controls */}
          <div className="flex items-center gap-1 border-l border-white/10 pl-2 ml-1">
            <button
              onClick={toggleAudio}
              className={`p-2 rounded-lg transition-colors min-w-[44px] min-h-[44px] flex items-center justify-center ${
                audioEnabled
                  ? audioConnected
                    ? 'bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20'
                    : 'bg-amber-500/10 text-amber-400 hover:bg-amber-500/20'
                  : 'hover:bg-white/5 text-slate-400 hover:text-white'
              }`}
              title={audioEnabled ? (audioConnected ? 'Audio on (click to mute)' : 'Audio connecting...') : 'Enable audio'}
            >
              {audioEnabled ? <Volume2 size={16} /> : <VolumeX size={16} />}
            </button>
            {audioEnabled && (
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={audioVolume}
                onChange={(e) => setAudioVolume(parseFloat(e.target.value))}
                className="w-16 sm:w-20 h-1 accent-emerald-500 cursor-pointer"
                title={`Volume: ${Math.round(audioVolume * 100)}%`}
              />
            )}
          </div>

          <button onClick={toggleFullscreen} className="p-2 rounded-lg hover:bg-white/5 text-slate-400 hover:text-white transition-colors min-w-[44px] min-h-[44px] flex items-center justify-center" title="Fullscreen">{fullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button>
        </div>
      </div>

      <div className="flex-1 relative overflow-auto bg-black">
        {configState.kind === 'loading' && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#0A0E27] z-10"><div className="text-center space-y-3"><div className="w-14 h-14 border-2 border-emerald-500/30 border-t-emerald-400 rounded-full animate-spin mx-auto" /><p className="text-sm text-slate-400">Loading remote desktop settings...</p></div></div>
        )}

        {(configState.kind === 'unconfigured' || (configState.kind === 'ok' && healthStatus === 'unavailable' && servicesInstalled === false)) && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#0A0E27] z-10">
            <div className="text-center space-y-5 max-w-lg px-6">
              <div className="w-16 h-16 rounded-2xl bg-slate-800 border border-slate-700 flex items-center justify-center mx-auto">
                <Monitor size={28} className="text-slate-400" />
              </div>
              <h3 className="text-xl font-semibold text-white">Remote Desktop needs setup</h3>
              <p className="text-sm text-slate-400">
                Remote Desktop gives you a full graphical desktop on your server, accessible from your browser.
                It takes about a minute to install.
              </p>
              {setupResult && (
                <div className={`rounded-xl border p-3 text-sm ${setupResult.ok ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' : 'border-amber-500/30 bg-amber-500/10 text-amber-300'}`}>
                  {setupResult.message}
                </div>
              )}
              <div className="flex flex-col sm:flex-row gap-3 justify-center">
                <button
                  onClick={runAutoSetup}
                  disabled={setupRunning}
                  className="inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-500 px-5 py-3 text-sm font-medium text-white transition hover:bg-emerald-600 disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {setupRunning ? (
                    <><div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Setting up...</>
                  ) : (
                    <><Play size={16} /> Set Up Remote Desktop</>
                  )}
                </button>
                <button
                  onClick={() => navigate('/settings')}
                  className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-700 bg-slate-900 px-5 py-3 text-sm font-medium text-slate-300 transition hover:bg-slate-800 hover:text-white"
                >
                  <Settings size={16} /> Advanced Settings
                </button>
              </div>
            </div>
          </div>
        )}

        {configState.kind === 'invalid' && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#0A0E27] z-10">
            <div className="text-center space-y-4 max-w-xl px-6">
              <div className="w-16 h-16 rounded-2xl bg-red-500/10 border border-red-500/20 flex items-center justify-center mx-auto"><AlertTriangle size={28} className="text-red-400" /></div>
              <h3 className="text-lg font-semibold text-white">Remote Desktop configuration error</h3>
              <p className="text-sm text-slate-400">{error || 'Invalid remote desktop configuration.'}</p>
            </div>
          </div>
        )}

        {configState.kind === 'ok' && loading && !error && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#0A0E27] z-10"><div className="text-center space-y-3"><div className="w-14 h-14 border-2 border-emerald-500/30 border-t-emerald-400 rounded-full animate-spin mx-auto" /><p className="text-sm text-slate-400">{healthStatus === 'degraded' ? 'Remote desktop is degraded. Attempting connection...' : 'Connecting to remote desktop...'}</p></div></div>
        )}

        {configState.kind === 'ok' && error && servicesInstalled !== false && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#0A0E27] z-10">
            <div className="text-center space-y-4 max-w-md px-6">
              <div className="w-16 h-16 rounded-2xl bg-red-500/10 border border-red-500/20 flex items-center justify-center mx-auto"><AlertTriangle size={28} className="text-red-400" /></div>
              <h3 className="text-lg font-semibold text-white">Remote Desktop Unavailable</h3>
              <p className="text-sm text-slate-400">{healthMessage ? `${error} ${healthMessage}` : error}</p>
              {setupResult && (
                <div className={`rounded-xl border p-3 text-sm ${setupResult.ok ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' : 'border-amber-500/30 bg-amber-500/10 text-amber-300'}`}>
                  {setupResult.message}
                </div>
              )}
              <div className="flex flex-col sm:flex-row gap-3 justify-center">
                <button onClick={reload} className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-sm font-medium hover:bg-emerald-500/20 transition-colors"><RefreshCw size={14} /> Retry Connection</button>
                <button
                  onClick={runAutoSetup}
                  disabled={setupRunning}
                  className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-400 text-sm font-medium hover:bg-amber-500/20 transition-colors disabled:opacity-60"
                >
                  {setupRunning ? 'Running...' : 'Re-run Setup'}
                </button>
              </div>
            </div>
          </div>
        )}

        {configState.kind === 'ok' && (healthStatus === 'ready' || iframeEverLoaded.current) && (
          <iframe
            ref={iframeRef}
            src={configUrl}
            onLoad={handleLoad}
            onError={handleError}
            className="w-full h-full border-0"
            data-iframe-state={iframeEverLoaded.current ? 'iframeEverLoaded' : 'initial'}
            style={{ transform: `scale(${scale / 100})`, transformOrigin: 'top left', width: `${10000 / scale}%`, height: `${10000 / scale}%` }}
            allow="clipboard-read; clipboard-write; fullscreen"
            tabIndex={0}
            onMouseEnter={() => iframeRef.current?.focus()}
            onClick={() => iframeRef.current?.focus()}
          />
        )}
      </div>
    </motion.div>
  );
}
