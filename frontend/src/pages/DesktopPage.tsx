import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import {
  Monitor,
  Maximize2,
  Minimize2,
  RefreshCw,
  ExternalLink,
  AlertTriangle,
  Wifi,
  WifiOff,
  Settings,
  Play,
  Volume2,
  VolumeX,
  Globe,
  ClipboardPaste,
  ClipboardCopy,
  Wrench,
} from 'lucide-react';
import client from '../api/client';
import TypedConfirmationDialog from '../components/TypedConfirmationDialog';

type RemoteDesktopHealth = 'loading' | 'ready' | 'degraded' | 'unavailable';

type DesktopConfigState =
  | { kind: 'ok'; url: URL; portalManaged: boolean }
  | { kind: 'loading' }
  | { kind: 'unconfigured' }
  | { kind: 'invalid'; reason: string };

const normalizePrefix = (value: string): string => {
  const cleaned = value.trim();
  if (!cleaned) return '';
  const normalized = cleaned.startsWith('/') ? cleaned : `/${cleaned}`;
  return normalized.length > 1 && normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
};

const pathMatchesPrefix = (pathname: string, prefix: string): boolean =>
  pathname === prefix || pathname.startsWith(`${prefix}/`);

const isSafeDesktopPrefix = (prefix: string): boolean =>
  prefix.length > 1
  && prefix.startsWith('/')
  && !prefix.startsWith('//')
  && !prefix.includes('..')
  && !/[?#\\\u0000-\u001f\u007f]/.test(prefix);

const DEFAULT_SETUP_CONFIRMATION = 'SET UP REMOTE DESKTOP';
const DEFAULT_RECOVERY_CONFIRMATION = 'RESTART REMOTE DESKTOP';
const MAX_AUDIO_CHUNK_BYTES = 256 * 1024;
const MAX_AUDIO_QUEUE_SECONDS = 0.75;
const DESKTOP_SETUP_SETTLE_MS = 2000;
const DESKTOP_CONVERGENCE_TIMEOUT_MS = 20_000;
const DESKTOP_STATUS_REQUEST_TIMEOUT_MS = 4000;
const DESKTOP_STATUS_POLL_MS = 400;

type DesktopOperationKind = 'setup' | 'recover';
type DesktopOperationPhase = 'submitting' | 'settling' | 'reconnecting' | 'verifying';
type DesktopOperationLease = { kind: DesktopOperationKind; phase: DesktopOperationPhase };

async function withDesktopRequestDeadline<T>(request: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      request,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Remote Desktop status verification timed out.')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isAttestedDesktopReady(data: any): boolean {
  const checks = data?.diagnostics?.checks;
  return data?.status === 'ready'
    && typeof data?.diagnostics?.configuredUrl === 'string'
    && data.diagnostics.configuredUrl.trim().length > 0
    && checks?.vncServiceUnitPresent === true
    && checks?.websockifyUnitPresent === true;
}

export default function DesktopPage() {
  const navigate = useNavigate();
  const [fullscreen, setFullscreen] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const desktopViewportRef = useRef<HTMLDivElement>(null);
  const iframeEverLoaded = useRef(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<'connecting' | 'connected' | 'external' | 'error'>('error');
  const connectionStatusRef = useRef<'connecting' | 'connected' | 'external' | 'error'>('error');
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [remoteDesktopUrl, setRemoteDesktopUrl] = useState('');
  const [allowedPrefixesRaw, setAllowedPrefixesRaw] = useState('/novnc,/vnc');
  const [configLoading, setConfigLoading] = useState(true);
  const [healthStatus, setHealthStatus] = useState<RemoteDesktopHealth>('loading');
  const [healthMessage, setHealthMessage] = useState<string | null>(null);
  const [setupRunning, setSetupRunning] = useState(false);
  const [setupPhase, setSetupPhase] = useState<DesktopOperationPhase | null>(null);
  const [setupResult, setSetupResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [servicesInstalled, setServicesInstalled] = useState<boolean | null>(null);
  const [pendingMutation, setPendingMutation] = useState<'setup' | 'recover' | null>(null);
  const [setupConfirmationPhrase, setSetupConfirmationPhrase] = useState(DEFAULT_SETUP_CONFIRMATION);
  const [recoveryConfirmationPhrase, setRecoveryConfirmationPhrase] = useState(DEFAULT_RECOVERY_CONFIRMATION);
  const setupReloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const setupActionRef = useRef<DesktopOperationLease | null>(null);

  const [audioEnabled, setAudioEnabled] = useState(false);
  const [audioConnected, setAudioConnected] = useState(false);
  const audioWsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioGainRef = useRef<GainNode | null>(null);
  const audioSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const [audioVolume, setAudioVolume] = useState(0.8);
  const audioVolumeRef = useRef(0.8);
  const audioReconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const audioReconnectAttemptRef = useRef(0);
  const audioEnabledRef = useRef(false);
  const mountedRef = useRef(true);
  const nextPlayTimeRef = useRef(0);
  const audioConfigRef = useRef({ sampleRate: 44100, channels: 2 });

  const [openingInDesktop, setOpeningInDesktop] = useState(false);
  const [sharedBrowserMessage, setSharedBrowserMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const sharedBrowserMessageTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    audioVolumeRef.current = audioVolume;
  }, [audioVolume]);

  useEffect(() => {
    audioEnabledRef.current = audioEnabled;
  }, [audioEnabled]);

  const getOrCreateAudioContext = useCallback((): AudioContext | null => {
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      return audioContextRef.current;
    }
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) return null;
      const ctx = new AudioCtx({ sampleRate: audioConfigRef.current.sampleRate });
      const gain = ctx.createGain();
      gain.gain.value = audioVolumeRef.current;
      gain.connect(ctx.destination);
      audioContextRef.current = ctx;
      audioGainRef.current = gain;
      nextPlayTimeRef.current = ctx.currentTime;
      return ctx;
    } catch {
      return null;
    }
  }, []);

  const connectAudio = useCallback(() => {
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
    } catch {
      if (mountedRef.current) setAudioConnected(false);
      return;
    }
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      audioReconnectAttemptRef.current = 0;
      if (mountedRef.current) setAudioConnected(true);
    };

    ws.onmessage = (event) => {
      if (typeof event.data === 'string') {
        try {
          const config = JSON.parse(event.data);
          const sampleRate = Number(config?.sampleRate);
          const channels = Number(config?.channels);
          if (config?.type === 'config'
            && config?.format === 's16le'
            && Number.isSafeInteger(sampleRate) && sampleRate >= 8000 && sampleRate <= 192000
            && Number.isSafeInteger(channels) && channels >= 1 && channels <= 8) {
            audioConfigRef.current = {
              sampleRate,
              channels,
            };
          }
        } catch {}
        return;
      }

      if (!(event.data instanceof ArrayBuffer)
        || event.data.byteLength <= 0
        || event.data.byteLength > MAX_AUDIO_CHUNK_BYTES
        || event.data.byteLength % 2 !== 0) return;

      const audioCtx = audioContextRef.current;
      const gainNode = audioGainRef.current;
      if (!audioCtx || !gainNode || audioCtx.state === 'closed') return;

      if (audioCtx.state === 'suspended') {
        audioCtx.resume().catch(() => {});
      }

      const { sampleRate, channels } = audioConfigRef.current;
      const pcmData = new Int16Array(event.data);
      const numSamples = Math.floor(pcmData.length / channels);
      if (numSamples <= 0) return;

      const audioBuffer = audioCtx.createBuffer(channels, numSamples, sampleRate);
      for (let ch = 0; ch < channels; ch++) {
        const channelData = audioBuffer.getChannelData(ch);
        for (let i = 0; i < numSamples; i++) {
          channelData[i] = pcmData[i * channels + ch] / 32768;
        }
      }

      const source = audioCtx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(gainNode);

      const now = audioCtx.currentTime;
      let playAt = nextPlayTimeRef.current;

      if (playAt < now - 0.3 || playAt > now + MAX_AUDIO_QUEUE_SECONDS) {
        for (const queuedSource of audioSourcesRef.current) {
          try { queuedSource.stop(); } catch {}
        }
        audioSourcesRef.current.clear();
        playAt = now + 0.01;
      } else if (playAt < now) {
        playAt = now + 0.005;
      }

      source.onended = () => audioSourcesRef.current.delete(source);
      audioSourcesRef.current.add(source);
      source.start(playAt);
      nextPlayTimeRef.current = playAt + audioBuffer.duration;
    };

    ws.onclose = (ev) => {
      if (mountedRef.current) setAudioConnected(false);
      if (audioWsRef.current === ws) audioWsRef.current = null;

      if (audioEnabledRef.current && ev.code !== 1000) {
        const attempt = Math.min(audioReconnectAttemptRef.current++, 4);
        const delay = Math.min(1000 * (2 ** attempt), 15000);
        audioReconnectTimer.current = setTimeout(() => {
          if (mountedRef.current && audioEnabledRef.current) connectAudio();
        }, delay);
      }
    };

    ws.onerror = () => {
      if (mountedRef.current) setAudioConnected(false);
    };

    audioWsRef.current = ws;
  }, []);

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
      for (const source of audioSourcesRef.current) {
        try { source.stop(); } catch {}
      }
      audioSourcesRef.current.clear();
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
    audioGainRef.current = null;
    audioReconnectAttemptRef.current = 0;
    if (mountedRef.current) setAudioConnected(false);
  }, []);

  const toggleAudio = useCallback(() => {
    if (audioEnabled) {
      audioEnabledRef.current = false;
      disconnectAudio();
      setAudioEnabled(false);
    } else {
      const ctx = getOrCreateAudioContext();
      if (!ctx) {
        setSetupResult({ ok: false, message: 'This browser could not start Remote Desktop audio.' });
        return;
      }
      if (ctx && ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
      }
      audioEnabledRef.current = true;
      setAudioEnabled(true);
      connectAudio();
    }
  }, [audioEnabled, connectAudio, disconnectAudio, getOrCreateAudioContext]);

  useEffect(() => {
    if (audioGainRef.current) {
      audioGainRef.current.gain.setValueAtTime(audioVolume, audioContextRef.current?.currentTime || 0);
    }
  }, [audioVolume]);

  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && audioContextRef.current) {
        if (audioContextRef.current.state === 'suspended') {
          audioContextRef.current.resume().catch(() => {});
        }
        nextPlayTimeRef.current = audioContextRef.current.currentTime + 0.05;
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const audioSources = audioSourcesRef.current;
    return () => {
      mountedRef.current = false;
      audioEnabledRef.current = false;
      if (audioReconnectTimer.current) clearTimeout(audioReconnectTimer.current);
      if (audioWsRef.current) audioWsRef.current.close(1000);
      for (const source of audioSources) {
        try { source.stop(); } catch {}
      }
      audioSources.clear();
      if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
        audioContextRef.current.close().catch(() => {});
      }
      if (setupReloadTimer.current) clearTimeout(setupReloadTimer.current);
      if (sharedBrowserMessageTimer.current) clearTimeout(sharedBrowserMessageTimer.current);
    };
  }, []);

  useEffect(() => {
    const loadSettings = async () => {
      setConfigLoading(true);
      try {
        const { data } = await client.get('/remote-desktop/status');
        const configuredUrl = String(data?.diagnostics?.configuredUrl || '').trim();
        const allowedPrefixes = Array.isArray(data?.diagnostics?.allowedPrefixes)
          ? data.diagnostics.allowedPrefixes.join(',')
          : '/novnc,/vnc';
        setRemoteDesktopUrl(configuredUrl);
        setAllowedPrefixesRaw((allowedPrefixes || '/novnc,/vnc').trim());
        setSetupConfirmationPhrase(String(data?.actions?.setup?.confirmationPhrase || DEFAULT_SETUP_CONFIRMATION));
        setRecoveryConfirmationPhrase(String(data?.actions?.recover?.confirmationPhrase || DEFAULT_RECOVERY_CONFIRMATION));
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
      .filter(isSafeDesktopPrefix);

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(remoteDesktopUrl, window.location.origin);
    } catch {
      return { kind: 'invalid', reason: 'remoteDesktop.url is not a valid URL.' };
    }

    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return { kind: 'invalid', reason: 'remoteDesktop.url must use HTTP or HTTPS.' };
    }
    if (parsedUrl.username || parsedUrl.password) {
      return { kind: 'invalid', reason: 'remoteDesktop.url must not contain embedded credentials.' };
    }

    const sameOrigin = parsedUrl.origin === window.location.origin;
    const allowedSameOriginPath = allowedPrefixes.some(prefix => pathMatchesPrefix(parsedUrl.pathname, prefix));

    if (sameOrigin && !allowedSameOriginPath) {
      return {
        kind: 'invalid',
        reason: `Remote Desktop URL points to disallowed same-origin path "${parsedUrl.pathname}". Allowed prefixes: ${allowedPrefixes.join(', ')}`,
      };
    }

    return { kind: 'ok', url: parsedUrl, portalManaged: sameOrigin };
  }, [configLoading, remoteDesktopUrl, allowedPrefixesRaw]);

  const applyAttestedDesktopStatus = useCallback((data: any) => {
    const configuredUrl = String(data?.diagnostics?.configuredUrl || '').trim();
    const allowedPrefixes = Array.isArray(data?.diagnostics?.allowedPrefixes)
      ? data.diagnostics.allowedPrefixes.join(',')
      : '/novnc,/vnc';
    setRemoteDesktopUrl(configuredUrl);
    setAllowedPrefixesRaw((allowedPrefixes || '/novnc,/vnc').trim());
    setServicesInstalled(true);
    setSetupConfirmationPhrase(String(data?.actions?.setup?.confirmationPhrase || DEFAULT_SETUP_CONFIRMATION));
    setRecoveryConfirmationPhrase(String(data?.actions?.recover?.confirmationPhrase || DEFAULT_RECOVERY_CONFIRMATION));
    setHealthStatus('ready');
    setHealthMessage(data?.message || 'Remote Desktop is ready.');
  }, []);

  const waitForDesktopConvergence = useCallback(async (
    lease: DesktopOperationLease,
    options: { initialDelayMs?: number; requireConnected?: boolean } = {},
  ) => {
    if (options.initialDelayMs) {
      lease.phase = 'settling';
      setSetupPhase('settling');
      await new Promise<void>((resolve) => {
        setupReloadTimer.current = setTimeout(resolve, options.initialDelayMs);
      });
      setupReloadTimer.current = null;
    }

    const deadline = Date.now() + DESKTOP_CONVERGENCE_TIMEOUT_MS;
    let lastFailure = 'Remote Desktop did not report a verified ready state.';
    while (Date.now() <= deadline) {
      if (!mountedRef.current || setupActionRef.current !== lease) {
        throw new Error('Remote Desktop verification was interrupted.');
      }
      lease.phase = options.requireConnected ? 'reconnecting' : 'verifying';
      setSetupPhase(lease.phase);
      const remainingMs = Math.max(1, deadline - Date.now());
      const requestTimeoutMs = Math.max(1, Math.min(DESKTOP_STATUS_REQUEST_TIMEOUT_MS, remainingMs));
      try {
        const response = await withDesktopRequestDeadline(
          client.get('/remote-desktop/status', { timeout: requestTimeoutMs }),
          requestTimeoutMs,
        );
        const data = response?.data;
        if (isAttestedDesktopReady(data)) {
          if (!options.requireConnected || connectionStatusRef.current === 'connected') {
            applyAttestedDesktopStatus(data);
            return data;
          }
          lastFailure = 'Remote Desktop services are ready, but the VNC session has not reconnected.';
        } else {
          lastFailure = data?.message || 'Remote Desktop has not reached a verified ready state.';
        }
      } catch (statusError: any) {
        lastFailure = statusError?.response?.data?.error || statusError?.message || 'Remote Desktop status verification failed.';
      }

      const sleepMs = Math.max(0, Math.min(DESKTOP_STATUS_POLL_MS, deadline - Date.now()));
      await new Promise((resolve) => setTimeout(resolve, sleepMs));
    }
    throw new Error(`${lastFailure} Verification did not converge within 20 seconds.`);
  }, [applyAttestedDesktopStatus]);

  // the server already says exactly which verification failed and why.
  // "Setup completed with warnings — review steps above" is useless on its own,
  // and the warning case arrives as an HTTP 500, so the payload has to be read
  // from either an ordinary response or a thrown error.
  const describeSetupFailure = useCallback((payload: any, fallback: string): string => {
    const steps = Array.isArray(payload?.steps) ? payload.steps : [];
    const failed = steps.filter((step: any) => step && step.ok === false);
    if (failed.length === 0) return payload?.message || fallback;
    const detail = failed
      .map((step: any) => {
        const name = String(step.step || 'Unnamed step').trim();
        const reason = String(step.message || '').replace(/\s+/g, ' ').trim();
        return reason ? `${name}: ${reason}` : name;
      })
      .join(' • ');
    const heading = failed.length === 1
      ? '1 step needs attention'
      : `${failed.length} steps need attention`;
    return `${heading} — ${detail}`;
  }, []);

  const runAutoSetup = useCallback(async (confirmation: string) => {
    if (setupActionRef.current) return;
    const lease: DesktopOperationLease = { kind: 'setup', phase: 'submitting' };
    setupActionRef.current = lease;
    setSetupRunning(true);
    setSetupPhase('submitting');
    setSetupResult(null);
    let completed = false;
    try {
      const { data } = await client.post('/remote-desktop/auto-setup', { confirmation });
      if (data?.ok) {
        setSetupResult({ ok: true, message: 'Remote Desktop setup finished. Waiting for the managed services to settle…' });
        await waitForDesktopConvergence(lease, { initialDelayMs: DESKTOP_SETUP_SETTLE_MS });
        completed = true;
        setSetupResult({ ok: true, message: 'Remote Desktop setup is installed and verified ready.' });
      } else {
        setSetupResult({
          ok: false,
          message: describeSetupFailure(data, 'Setup finished with issues.'),
        });
      }
    } catch (err: any) {
      const payload = err?.response?.data;
      setSetupResult({
        ok: false,
        message: describeSetupFailure(
          payload,
          payload?.message
            || payload?.error
            || err?.message
            || 'Auto-setup request failed.',
        ),
      });
    } finally {
      if (setupActionRef.current === lease) setupActionRef.current = null;
      if (mountedRef.current) {
        setSetupRunning(false);
        setSetupPhase(null);
        if (completed) setPendingMutation(null);
      }
    }
  }, [describeSetupFailure, waitForDesktopConvergence]);

  const runRecovery = useCallback(async (confirmation: string) => {
    if (setupActionRef.current) return;
    const lease: DesktopOperationLease = { kind: 'recover', phase: 'submitting' };
    setupActionRef.current = lease;
    setSetupRunning(true);
    setSetupPhase('submitting');
    setSetupResult(null);
    let restartPromptRequired = false;
    let completed = false;
    try {
      const { data } = await client.post('/remote-desktop/recover', { confirmation });
      if (!data?.ok) throw new Error(data?.error || 'Remote Desktop recovery failed.');
      if (data?.mode === 'in-place' && data?.disrupted === false) {
        await waitForDesktopConvergence(lease);
        completed = true;
        setSetupResult({
          ok: true,
          message: data?.note || 'Remote Desktop was repaired without interrupting the connection.',
        });
        return;
      }
      setSetupResult({ ok: true, message: data?.note || 'Remote Desktop services restarted. Verifying the VNC reconnection…' });
      setLoading(true);
      setError(null);
      connectionStatusRef.current = 'connecting';
      setConnectionStatus('connecting');
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      if (iframeRef.current && configState.kind === 'ok') {
        iframeRef.current.src = configState.url.toString();
      }
      await waitForDesktopConvergence(lease, { requireConnected: true });
      completed = true;
      setLoading(false);
      setError(null);
      setSetupResult({ ok: true, message: data?.note || 'Remote Desktop services restarted and the VNC session reconnected.' });
    } catch (err: any) {
      const payload = err?.response?.data;
      if (payload?.restartRequired && !confirmation) {
        restartPromptRequired = true;
        setRecoveryConfirmationPhrase(String(payload?.confirmationPhrase || DEFAULT_RECOVERY_CONFIRMATION));
        setSetupResult({
          ok: false,
          message: payload?.note
            ? `${payload.note} A service restart is required to finish recovery.`
            : 'The safe repair could not restore the desktop. A confirmed service restart is required.',
        });
        setPendingMutation('recover');
        return;
      }
      setSetupResult({
        ok: false,
        message: payload?.note
          || payload?.message
          || payload?.error
          || err?.message
          || 'Remote Desktop recovery failed.',
      });
    } finally {
      if (setupActionRef.current === lease) setupActionRef.current = null;
      if (mountedRef.current) {
        setSetupRunning(false);
        setSetupPhase(null);
        if (completed || (!confirmation && !restartPromptRequired)) setPendingMutation(null);
      }
    }
  }, [configState, waitForDesktopConvergence]);

  const requestSetupConfirmation = useCallback(() => {
    if (setupActionRef.current) return;
    setPendingMutation('setup');
  }, []);

  useEffect(() => {
    let cancelled = false;

    const loadHealth = async () => {
      if (setupActionRef.current) return;
      if (configState.kind !== 'ok' && configState.kind !== 'unconfigured') {
        setHealthStatus(configState.kind === 'loading' ? 'loading' : 'unavailable');
        setHealthMessage(null);
        return;
      }

      setHealthStatus('loading');
      try {
        const { data } = await client.get('/remote-desktop/status');
        if (cancelled || setupActionRef.current) return;

        const checks = data?.diagnostics?.checks;
        if (checks) {
          setServicesInstalled(Boolean(checks.vncServiceUnitPresent || checks.websockifyUnitPresent));
        }
        setSetupConfirmationPhrase(String(data?.actions?.setup?.confirmationPhrase || DEFAULT_SETUP_CONFIRMATION));
        setRecoveryConfirmationPhrase(String(data?.actions?.recover?.confirmationPhrase || DEFAULT_RECOVERY_CONFIRMATION));

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

    const pollHealth = () => { if (!document.hidden) void loadHealth(); };
    void loadHealth();
    const interval = window.setInterval(pollHealth, 30000);
    document.addEventListener('visibilitychange', pollHealth);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', pollHealth);
    };
  }, [configState]);

  const setupTimeout = (ms: number) => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      setError('Remote desktop backend is unavailable or not responding.');
      connectionStatusRef.current = 'error';
      setConnectionStatus('error');
      setLoading(false);
    }, ms);
  };

  useEffect(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);

    if (configState.kind !== 'ok') {
      setLoading(false);
      connectionStatusRef.current = 'error';
      setConnectionStatus('error');
      setError(configState.kind === 'invalid' ? configState.reason : null);
      return;
    }

    setLoading(true);
    connectionStatusRef.current = 'connecting';
    setConnectionStatus('connecting');
    setError(null);
    setupTimeout(20000);

    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [configState]);

  const toggleFullscreen = () => {
    const operation = document.fullscreenElement
      ? document.exitFullscreen?.()
      : document.documentElement.requestFullscreen?.();
    Promise.resolve(operation).catch(() => {
      setSetupResult({ ok: false, message: 'The browser denied fullscreen mode.' });
    });
  };

  // Portal-native clipboard sync. The noVNC clipboard panel is opaque and only
  // works when the in-session bridge is healthy; these buttons talk straight
  // to the desktop's X selections through the backend instead.
  const [clipboardStatus, setClipboardStatus] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const clipboardStatusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashClipboardStatus = useCallback((kind: 'ok' | 'error', text: string) => {
    if (clipboardStatusTimer.current) clearTimeout(clipboardStatusTimer.current);
    setClipboardStatus({ kind, text });
    clipboardStatusTimer.current = setTimeout(() => setClipboardStatus(null), kind === 'ok' ? 2500 : 6000);
  }, []);

  const sendClipboardToDesktop = useCallback(async () => {
    let text = '';
    try {
      text = await navigator.clipboard.readText();
    } catch {
      flashClipboardStatus('error', 'Browser blocked clipboard access — allow clipboard permission for this site and try again.');
      return;
    }
    if (!text) {
      flashClipboardStatus('error', 'Your clipboard is empty (only text can be sent).');
      return;
    }
    try {
      await client.post('/remote-desktop/clipboard', { text, selection: 'both' });
      flashClipboardStatus('ok', `Sent ${text.length.toLocaleString()} characters — paste inside the desktop with Ctrl+V.`);
    } catch (err: any) {
      flashClipboardStatus('error', err?.response?.data?.error || 'Failed to send clipboard to the desktop.');
    }
  }, [flashClipboardStatus]);

  const fetchClipboardFromDesktop = useCallback(async () => {
    let text = '';
    try {
      const { data } = await client.get('/remote-desktop/clipboard', { params: { selection: 'clipboard' } });
      text = typeof data?.text === 'string' ? data.text : '';
    } catch (err: any) {
      flashClipboardStatus('error', err?.response?.data?.error || 'Failed to read the desktop clipboard.');
      return;
    }
    if (!text) {
      flashClipboardStatus('error', 'The desktop clipboard is empty — copy something inside the desktop first.');
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      flashClipboardStatus('error', 'Browser blocked clipboard access — allow clipboard permission for this site and try again.');
      return;
    }
    flashClipboardStatus('ok', `Copied ${text.length.toLocaleString()} characters from the desktop to your clipboard.`);
  }, [flashClipboardStatus]);
  useEffect(() => () => { if (clipboardStatusTimer.current) clearTimeout(clipboardStatusTimer.current); }, []);

  const postViewportToIframe = useCallback((reason: string) => {
    const iframe = iframeRef.current;
    const host = desktopViewportRef.current;
    if (!iframe?.contentWindow || !host) return;
    const rect = host.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));
    iframe.contentWindow.postMessage(
      {
        type: 'bridgesllm.remoteDesktopViewport',
        width,
        height,
        reason,
      },
      window.location.origin,
    );
  }, []);

  useEffect(() => {
    const onFullscreenChange = () => {
      setFullscreen(Boolean(document.fullscreenElement));
      window.setTimeout(() => postViewportToIframe('fullscreen-toggle'), 300);
      window.setTimeout(() => postViewportToIframe('fullscreen-settled'), 900);
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, [postViewportToIframe]);

  const reload = () => {
    if (configState.kind !== 'ok' || setupActionRef.current) return;
    if (iframeRef.current) {
      setLoading(true);
      setError(null);
      connectionStatusRef.current = 'connecting';
      setConnectionStatus('connecting');
      setupTimeout(15000);
      iframeRef.current.src = configState.url.toString();
    }
  };

  const handleLoad = () => {
    iframeEverLoaded.current = true;
    if (configState.kind === 'ok' && !configState.portalManaged) {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      setLoading(false);
      setError(null);
      connectionStatusRef.current = 'external';
      setConnectionStatus('external');
    }
    setTimeout(() => {
      iframeRef.current?.focus();
      postViewportToIframe('load');
    }, 100);
  };

  const handleError = () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setLoading(false);
    setError('Failed to load remote desktop endpoint. Check backend/proxy availability.');
    connectionStatusRef.current = 'error';
    setConnectionStatus('error');
  };

  useEffect(() => {
    if (configState.kind !== 'ok' || !configState.portalManaged) return;
    const onRemoteDesktopStatus = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== iframeRef.current?.contentWindow) return;
      const data = event.data as { type?: unknown; state?: unknown; message?: unknown } | null;
      if (!data || data.type !== 'bridgesllm.remoteDesktopStatus') return;
      const message = typeof data.message === 'string' ? data.message.slice(0, 300) : '';
      if (data.state === 'connected') {
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
        setLoading(false);
        setError(null);
        connectionStatusRef.current = 'connected';
        setConnectionStatus('connected');
      } else if (data.state === 'connecting' || data.state === 'reconnecting') {
        setLoading(true);
        setError(null);
        connectionStatusRef.current = 'connecting';
        setConnectionStatus('connecting');
      } else if (data.state === 'error' || data.state === 'disconnected') {
        setLoading(false);
        setError(message || 'Remote desktop connection was lost.');
        connectionStatusRef.current = 'error';
        setConnectionStatus('error');
      }
    };
    window.addEventListener('message', onRemoteDesktopStatus);
    return () => window.removeEventListener('message', onRemoteDesktopStatus);
  }, [configState]);

  useEffect(() => {
    const host = desktopViewportRef.current;
    if (!host) return;

    const push = (reason: string) => postViewportToIframe(reason);
    const observer = new ResizeObserver(() => push('container-resize'));
    observer.observe(host);

    const onWindowResize = () => push('window-resize');
    const onVisibility = () => { if (!document.hidden) push('tab-visible'); };
    window.addEventListener('resize', onWindowResize);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', onWindowResize);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [postViewportToIframe, configState.kind]);

  const openCurrentBrowserInDesktop = useCallback(async () => {
    setOpeningInDesktop(true);
    setSharedBrowserMessage(null);
    try {
      await client.post('/agent-browser/open-in-desktop');
      if (!mountedRef.current) return;
      setSharedBrowserMessage({ ok: true, text: 'Shared Chrome opened in the Remote Desktop.' });
      setTimeout(() => postViewportToIframe('open-shared-browser'), 500);
    } catch (err: any) {
      if (!mountedRef.current) return;
      setSharedBrowserMessage({ ok: false, text: err?.response?.data?.error || 'Shared Chrome could not be opened.' });
    } finally {
      if (mountedRef.current) {
        setOpeningInDesktop(false);
        if (sharedBrowserMessageTimer.current) clearTimeout(sharedBrowserMessageTimer.current);
        sharedBrowserMessageTimer.current = setTimeout(() => setSharedBrowserMessage(null), 5000);
      }
    }
  }, [postViewportToIframe]);

  const configUrl = configState.kind === 'ok' ? configState.url.toString() : '';
  const desktopBusyLabel = setupPhase === 'settling'
    ? 'Waiting for services…'
    : setupPhase === 'reconnecting'
      ? 'Verifying reconnection…'
      : setupPhase === 'verifying'
        ? 'Verifying desktop…'
        : setupActionRef.current?.kind === 'recover'
          ? 'Repairing desktop…'
          : 'Installing desktop…';

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className={`flex min-h-0 flex-col ${fullscreen ? 'fixed inset-0 z-50 bg-[#0A0E27]' : 'h-full'}`}
    >
      <div className="flex flex-col gap-2 border-b border-white/5 bg-[#0D1130]/80 px-2 py-2 backdrop-blur-xl sm:px-4 sm:py-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <Monitor size={16} className="text-emerald-400 flex-shrink-0" />
          <div className="min-w-0">
            <div className="text-sm font-semibold text-white">Remote Desktop</div>
            <div className="text-[11px] text-slate-500">Shared graphical workspace on your server</div>
          </div>
        </div>

        <div className="flex max-w-full flex-wrap items-center gap-1 sm:gap-2 lg:justify-end">
          <div className="flex items-center gap-1.5 sm:gap-3 min-w-0">
            <span className={`inline-flex items-center gap-1 px-1.5 sm:px-2 py-0.5 rounded-full text-[10px] font-medium flex-shrink-0 ${connectionStatus === 'connected' ? 'bg-emerald-500/10 text-emerald-400' : connectionStatus === 'external' ? 'bg-blue-500/10 text-blue-300' : connectionStatus === 'error' ? 'bg-red-500/10 text-red-400' : 'bg-amber-500/10 text-amber-400'}`} role="status">
              {connectionStatus === 'connected' || connectionStatus === 'external' ? <Wifi size={10} /> : connectionStatus === 'error' ? <WifiOff size={10} /> : <div className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />}
              <span className="hidden sm:inline">{connectionStatus === 'connected' ? 'Connected' : connectionStatus === 'external' ? 'External view loaded' : connectionStatus === 'error' ? 'Disconnected' : 'Connecting...'}</span>
            </span>
            <span className={`inline-flex items-center gap-1 px-1.5 sm:px-2 py-0.5 rounded-full text-[10px] font-medium flex-shrink-0 ${healthStatus === 'ready' ? 'bg-emerald-500/10 text-emerald-400' : healthStatus === 'degraded' ? 'bg-amber-500/10 text-amber-400' : 'bg-red-500/10 text-red-400'}`}>
              {healthStatus === 'ready' ? <Wifi size={10} /> : <AlertTriangle size={10} />}
              <span className="hidden sm:inline">{healthStatus === 'ready' ? 'Desktop ready' : healthStatus === 'degraded' ? 'Desktop degraded' : healthStatus === 'loading' ? 'Checking desktop...' : 'Desktop unavailable'}</span>
            </span>
          </div>
          <div className="hidden sm:flex items-center gap-1 mr-2 px-2 py-1 rounded-md bg-white/5 text-slate-400 text-xs">
            <Globe size={12} />
            <span>Fit to container</span>
          </div>
          <button onClick={reload} className="p-2 rounded-lg hover:bg-white/5 text-slate-400 hover:text-white transition-colors min-w-[44px] min-h-[44px] flex items-center justify-center disabled:opacity-50" title="Reload" aria-label="Reload remote desktop" disabled={configState.kind !== 'ok' || setupRunning}><RefreshCw size={16} className={loading ? 'animate-spin' : ''} /></button>
          {configState.kind === 'ok' && configState.portalManaged && servicesInstalled !== false && (
            <button
              onClick={() => void runRecovery('')}
              disabled={setupRunning}
              aria-busy={setupRunning && setupActionRef.current?.kind === 'recover'}
              className="inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-slate-300 transition-colors hover:bg-white/5 hover:text-white disabled:cursor-wait disabled:opacity-60"
              title="Repair the desktop session without interruption; asks before a service restart if needed"
              aria-label="Repair remote desktop"
            >
              <Wrench size={15} className={setupRunning && setupActionRef.current?.kind === 'recover' ? 'animate-pulse' : ''} />
              <span className="hidden lg:inline">{setupRunning && setupActionRef.current?.kind === 'recover' ? desktopBusyLabel : 'Repair'}</span>
            </button>
          )}
          {configState.kind === 'ok' && (
            <a href={configUrl} target="_blank" rel="noopener noreferrer" className="p-2 rounded-lg hover:bg-white/5 text-slate-400 hover:text-white transition-colors min-w-[44px] min-h-[44px] items-center justify-center hidden sm:flex" title="Open in new tab" aria-label="Open remote desktop in a new tab"><ExternalLink size={16} /></a>
          )}
          <div className="flex items-center gap-1 border-l border-white/10 pl-2 ml-1">
            <button
              onClick={toggleAudio}
              className={`p-2 rounded-lg transition-colors min-w-[44px] min-h-[44px] flex items-center justify-center ${audioEnabled ? (audioConnected ? 'bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20' : 'bg-amber-500/10 text-amber-400 hover:bg-amber-500/20') : 'hover:bg-white/5 text-slate-400 hover:text-white'}`}
              title={audioEnabled ? (audioConnected ? 'Audio on (click to mute)' : 'Audio connecting...') : 'Enable audio'}
              aria-label={audioEnabled ? 'Disable remote desktop audio' : 'Enable remote desktop audio'}
              aria-pressed={audioEnabled}
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
                aria-label="Remote desktop audio volume"
                aria-valuetext={`${Math.round(audioVolume * 100)} percent`}
              />
            )}
          </div>
          <button
            onClick={() => void sendClipboardToDesktop()}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg hover:bg-white/5 text-slate-400 hover:text-white transition-colors min-h-[44px] text-xs font-medium"
            title="Send your computer's clipboard into the remote desktop (then paste there with Ctrl+V)"
            aria-label="Send clipboard to remote desktop"
          >
            <ClipboardPaste size={15} />
            <span className="hidden md:inline">Send clipboard</span>
          </button>
          <button
            onClick={() => void fetchClipboardFromDesktop()}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg hover:bg-white/5 text-slate-400 hover:text-white transition-colors min-h-[44px] text-xs font-medium"
            title="Copy whatever was last copied inside the remote desktop onto your computer's clipboard"
            aria-label="Get clipboard from remote desktop"
          >
            <ClipboardCopy size={15} />
            <span className="hidden md:inline">Get clipboard</span>
          </button>
          <button onClick={toggleFullscreen} className="p-2 rounded-lg hover:bg-white/5 text-slate-400 hover:text-white transition-colors min-w-[44px] min-h-[44px] flex items-center justify-center" title="Fullscreen" aria-label={fullscreen ? 'Exit remote desktop fullscreen' : 'Open remote desktop fullscreen'}>{fullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button>
          <button
            onClick={() => void openCurrentBrowserInDesktop()}
            disabled={openingInDesktop}
            className="inline-flex items-center gap-2 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-3 py-1.5 text-sm text-emerald-200 transition-colors hover:bg-emerald-500/20 hover:text-white disabled:opacity-60"
            aria-label={openingInDesktop ? 'Opening shared Chrome' : 'Open shared Chrome'}
          >
            <Monitor size={16} />
            <span className="hidden sm:inline">{openingInDesktop ? 'Opening shared Chrome…' : 'Open shared Chrome'}</span>
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-hidden bg-[#0a0d18]">
        <div className="flex h-full w-full flex-col gap-0 p-0">
          <div ref={desktopViewportRef} className="relative flex-1 min-h-[70vh] overflow-hidden bg-black">
            {configState.kind === 'loading' && (
              <div className="absolute inset-0 flex items-center justify-center bg-[#0A0E27] z-10"><div className="text-center space-y-3"><div className="w-14 h-14 border-2 border-emerald-500/30 border-t-emerald-400 rounded-full animate-spin mx-auto" /><p className="text-sm text-slate-400">Loading remote desktop settings...</p></div></div>
            )}

            {(configState.kind === 'unconfigured' || (configState.kind === 'ok' && configState.portalManaged && healthStatus === 'unavailable' && servicesInstalled === false)) && (
              <div className="absolute inset-0 flex items-center justify-center bg-[#0A0E27] z-10">
                <div className="text-center space-y-5 max-w-lg px-6">
                  <div className="w-16 h-16 rounded-2xl bg-slate-800 border border-slate-700 flex items-center justify-center mx-auto">
                    <Monitor size={28} className="text-slate-400" />
                  </div>
                  <h3 className="text-xl font-semibold text-white">Remote Desktop needs setup</h3>
                  <p className="text-sm text-slate-400">Remote Desktop gives you a full graphical desktop on your server, accessible from your browser. It takes about a minute to install.</p>
                  {setupResult && (
                    <div className={`rounded-xl border p-3 text-sm ${setupResult.ok ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' : 'border-amber-500/30 bg-amber-500/10 text-amber-300'}`}>
                      {setupResult.message}
                    </div>
                  )}
                  <div className="flex flex-col sm:flex-row gap-3 justify-center">
                    <button onClick={requestSetupConfirmation} disabled={setupRunning} aria-busy={setupRunning && setupActionRef.current?.kind === 'setup'} className="inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-500 px-5 py-3 text-sm font-medium text-white transition hover:bg-emerald-600 disabled:opacity-60 disabled:cursor-not-allowed">
                      {setupRunning && setupActionRef.current?.kind === 'setup' ? <><div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> {desktopBusyLabel}</> : <><Play size={16} /> Set Up Remote Desktop</>}
                    </button>
                    <button onClick={() => { if (!setupActionRef.current) navigate('/settings'); }} disabled={setupRunning} className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-700 bg-slate-900 px-5 py-3 text-sm font-medium text-slate-300 transition hover:bg-slate-800 hover:text-white disabled:opacity-50">
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

            {clipboardStatus && (
              <div className={`absolute top-3 left-1/2 -translate-x-1/2 z-20 max-w-lg px-4 py-2 rounded-xl border text-sm shadow-lg ${clipboardStatus.kind === 'ok' ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-200' : 'bg-red-500/15 border-red-500/30 text-red-200'}`}>
                {clipboardStatus.text}
              </div>
            )}
            {sharedBrowserMessage && (
              <div className={`absolute top-14 left-1/2 -translate-x-1/2 z-20 max-w-lg px-4 py-2 rounded-xl border text-sm shadow-lg ${sharedBrowserMessage.ok ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-200' : 'bg-red-500/15 border-red-500/30 text-red-200'}`} role="status">
                {sharedBrowserMessage.text}
              </div>
            )}
            {setupResult && !error && configState.kind === 'ok' && (
              <div className={`absolute top-3 right-3 z-20 max-w-lg rounded-xl border px-4 py-2 text-sm shadow-lg ${setupResult.ok ? 'border-emerald-500/30 bg-emerald-500/15 text-emerald-200' : 'border-amber-500/30 bg-amber-500/15 text-amber-200'}`} role="status">
                {setupResult.message}
              </div>
            )}
            {configState.kind === 'ok' && loading && !error && (
              <div className="absolute inset-0 flex items-center justify-center bg-[#0A0E27] z-10"><div className="text-center space-y-3"><div className="w-14 h-14 border-2 border-emerald-500/30 border-t-emerald-400 rounded-full animate-spin mx-auto" /><p className="text-sm text-slate-400">{healthStatus === 'degraded' ? 'Remote desktop is degraded. Attempting connection...' : 'Connecting to remote desktop...'}</p></div></div>
            )}

            {configState.kind === 'ok' && error && (!configState.portalManaged || servicesInstalled !== false) && (
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
                    <button onClick={reload} disabled={setupRunning} className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-sm font-medium hover:bg-emerald-500/20 transition-colors disabled:opacity-50"><RefreshCw size={14} /> Retry Connection</button>
                    <button onClick={() => void runRecovery('')} disabled={setupRunning} aria-busy={setupRunning && setupActionRef.current?.kind === 'recover'} className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-400 text-sm font-medium hover:bg-amber-500/20 transition-colors disabled:opacity-60">
                      <Wrench size={14} className={setupRunning && setupActionRef.current?.kind === 'recover' ? 'animate-pulse' : ''} />
                      {setupRunning && setupActionRef.current?.kind === 'recover' ? desktopBusyLabel : 'Repair Desktop'}
                    </button>
                    <button onClick={requestSetupConfirmation} disabled={setupRunning} className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-red-500/25 bg-red-500/10 text-red-300 text-sm font-medium hover:bg-red-500/20 transition-colors disabled:opacity-60">
                      Reinstall Desktop Runtime
                    </button>
                  </div>
                </div>
              </div>
            )}

            {configState.kind === 'ok' && (!configState.portalManaged || healthStatus === 'ready' || healthStatus === 'degraded' || iframeEverLoaded.current) && (
              <iframe
                ref={iframeRef}
                src={configUrl}
                onLoad={handleLoad}
                onError={handleError}
                className="w-full h-full border-0"
                data-iframe-state={iframeEverLoaded.current ? 'iframeEverLoaded' : 'initial'}
                title="Remote desktop session"
                referrerPolicy="no-referrer"
                sandbox={configState.portalManaged ? undefined : 'allow-scripts allow-forms allow-same-origin allow-pointer-lock allow-downloads'}
                allow={configState.portalManaged ? 'clipboard-read; clipboard-write; fullscreen' : 'fullscreen'}
              />
            )}
          </div>

        </div>
      </div>
      <TypedConfirmationDialog
        open={pendingMutation === 'setup'}
        title="Install or repair Remote Desktop?"
        description="This installs host packages, rewrites managed launcher units, and restarts the graphical desktop. Active desktop work will be interrupted."
        confirmationPhrase={setupConfirmationPhrase}
        confirmLabel="Install and restart"
        busyLabel={desktopBusyLabel}
        busy={setupRunning}
        tone="danger"
        onCancel={() => { if (!setupActionRef.current) setPendingMutation(null); }}
        onConfirm={(confirmation) => { void runAutoSetup(confirmation); }}
        details={setupResult && !setupResult.ok ? (
          <div role="alert" className="rounded-xl border border-red-500/25 bg-red-500/10 px-3 py-2 text-sm text-red-100">
            {setupResult.message}
          </div>
        ) : null}
      />
      <TypedConfirmationDialog
        open={pendingMutation === 'recover'}
        title="Restart Remote Desktop services?"
        description="The non-disruptive repair could not restore a usable XFCE session. This restarts VNC and the browser bridge, briefly disconnecting the current desktop."
        confirmationPhrase={recoveryConfirmationPhrase}
        confirmLabel="Restart desktop services"
        busyLabel={desktopBusyLabel}
        busy={setupRunning}
        onCancel={() => { if (!setupActionRef.current) setPendingMutation(null); }}
        onConfirm={(confirmation) => { void runRecovery(confirmation); }}
        details={setupResult && !setupResult.ok ? (
          <div role="alert" className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">
            {setupResult.message}
          </div>
        ) : null}
      />
    </motion.div>
  );
}
