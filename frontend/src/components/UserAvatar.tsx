import { useState, useEffect } from 'react';
import { Pencil } from 'lucide-react';
import AvatarEditor from './AvatarEditor';
import client from '../api/client';
import { useAuthStore } from '../contexts/AuthContext';
import { isElevated } from '../utils/authz';
import { setCachedUserAvatarUrl, useUserAvatarUrl } from '../hooks/useUserAvatarUrl';
import {
  AGENT_HARNESS_PREFERENCE_EVENT,
  agentHarnessPreferenceStorageKey,
  loadDefaultAgentHarness,
} from '../api/agentHarnessPreference';
import {
  loadAgentChatProviderCatalog,
  type AgentChatHarnessCatalogEntry,
} from '../utils/agentChatProviderCatalog';

interface UserAvatarProps {
  size?: string;
  ringColor?: string;
  editable?: boolean;
  username?: string;
  assistant?: boolean;
}

type HarnessStatus = 'ready' | 'unavailable' | 'checking';

interface HarnessIndicator {
  state: HarnessStatus;
  label: string;
}

export function resolveAssistantHarnessIndicator(
  harnessId: string,
  entry: AgentChatHarnessCatalogEntry | undefined,
  openClawConnected?: boolean,
): HarnessIndicator {
  const displayName = entry?.displayName || harnessId;
  if (!entry || entry.checking === true || entry.availabilityState === 'checking') {
    return { state: 'checking', label: `${displayName}: Checking readiness…` };
  }
  if (entry.implemented !== true || entry.selectable !== true) {
    return {
      state: 'unavailable',
      label: `${displayName}: ${entry.unavailableReason || entry.reason || 'Not available'}`,
    };
  }
  if (entry.usable !== true || entry.availabilityState === 'stale' || entry.availabilityState === 'error') {
    return {
      state: 'unavailable',
      label: `${displayName}: ${entry.nativeAuthMessage || entry.reason || entry.unavailableReason || 'Unavailable'}`,
    };
  }
  if (harnessId === 'OPENCLAW') {
    return openClawConnected
      ? { state: 'ready', label: 'OpenClaw Gateway: Connected' }
      : { state: 'unavailable', label: 'OpenClaw Gateway: Disconnected' };
  }
  return { state: 'ready', label: `${displayName}: Ready` };
}

export default function UserAvatar({ size = 'w-10 h-10', ringColor = 'ring-purple-500/50', editable = true, username, assistant = false }: UserAvatarProps) {
  const userAvatarUrl = useUserAvatarUrl({ enabled: !assistant });
  const [assistantAvatarUrl, setAssistantAvatarUrl] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const [defaultHarness, setDefaultHarness] = useState<{ userId: string; harnessId: string } | null>(null);
  const [harnessIndicator, setHarnessIndicator] = useState<HarnessIndicator>({
    state: 'checking',
    label: 'Assistant harness: Checking readiness…',
  });
  const { user, isAuthenticated } = useAuthStore();
  const assistantHarness = defaultHarness?.userId === user?.id ? defaultHarness?.harnessId : null;
  // Main Agent Chat is an intentional host-operator surface (Owner/Sub Admin)
  // at both the route and backend execution boundaries. Keep its readiness
  // indicator on the same eligibility boundary; Project Chat exposes its own
  // separately confined provider readiness to ordinary approved users.
  const userCanViewHarnessStatus = isElevated(user);
  const avatarUrl = assistant ? assistantAvatarUrl : userAvatarUrl;

  useEffect(() => {
    if (!assistant) return;
    if (!isAuthenticated) {
      setAssistantAvatarUrl(null);
      return;
    }

    const cacheKey = 'cached_assistantAvatar';
    const cached = sessionStorage.getItem(cacheKey);
    if (cached) {
      setAssistantAvatarUrl(cached);
      return;
    }

    client.get('/users/assistant-avatar', { _silent: true } as any)
      .then(({ data }) => {
        if (data?.avatarUrl) {
          setAssistantAvatarUrl(data.avatarUrl);
          sessionStorage.setItem(cacheKey, data.avatarUrl);
        }
      })
      .catch(() => {
        // No fallback file — the initial-based circle renders automatically
      });
  }, [assistant, isAuthenticated]);

  useEffect(() => {
    if (!assistant || !isAuthenticated || !user?.id) return undefined;
    let cancelled = false;
    let request = 0;
    const refreshDefault = async () => {
      const generation = ++request;
      try {
        const preference = await loadDefaultAgentHarness(user.id);
        if (!cancelled && request === generation) {
          setDefaultHarness({ userId: user.id, harnessId: preference.defaultHarness });
        }
      } catch {
        if (!cancelled && request === generation) {
          setDefaultHarness(null);
          setHarnessIndicator({ state: 'unavailable', label: 'Default Assistant harness could not be verified' });
        }
      }
    };
    const handlePreference = (event: Event) => {
      const detail = (event as CustomEvent<{ userId?: string; defaultHarness?: string }>).detail;
      if (detail?.userId !== user.id || !detail.defaultHarness) return;
      ++request; // A pending read cannot overwrite a later confirmed Settings save.
      setDefaultHarness({ userId: user.id, harnessId: detail.defaultHarness });
    };
    const handleStorage = (event: StorageEvent) => {
      if (event.key === agentHarnessPreferenceStorageKey(user.id) || event.key === null) {
        void refreshDefault();
      }
    };
    const handleFocus = () => { void refreshDefault(); };
    window.addEventListener(AGENT_HARNESS_PREFERENCE_EVENT, handlePreference);
    window.addEventListener('storage', handleStorage);
    window.addEventListener('focus', handleFocus);
    void refreshDefault();
    return () => {
      cancelled = true;
      window.removeEventListener(AGENT_HARNESS_PREFERENCE_EVENT, handlePreference);
      window.removeEventListener('storage', handleStorage);
      window.removeEventListener('focus', handleFocus);
    };
  }, [assistant, isAuthenticated, user?.id]);

  // Global readiness belongs to the saved default, not the selected chat. OpenClaw alone
  // additionally requires its authenticated Gateway WebSocket health probe.
  useEffect(() => {
    if (!assistant) return;
    if (!isAuthenticated || !userCanViewHarnessStatus) {
      setHarnessIndicator({ state: 'checking', label: 'Harness status is available to Portal operators' });
      return;
    }

    if (!assistantHarness) {
      setHarnessIndicator({ state: 'checking', label: 'Default Assistant harness: Checking preference…' });
      return;
    }
    let cancelled = false;

    const checkHarnessStatus = async () => {
      try {
        const catalog = await loadAgentChatProviderCatalog({
          force: true,
          timeoutMs: 10_000,
          requestTimeoutMs: 5_000,
        });
        if (cancelled) return;
        const entry = catalog.find((candidate) => (
          String(candidate.harnessId || candidate.name || '').toUpperCase() === assistantHarness
        ));
        if (assistantHarness === 'OPENCLAW') {
          const { data } = await client.get('/gateway/health', {
            timeout: 5000,
            _silent: true,
          } as any);
          if (!cancelled) {
            setHarnessIndicator(resolveAssistantHarnessIndicator(
              assistantHarness,
              entry,
              data?.wsConnected === true,
            ));
          }
          return;
        }
        setHarnessIndicator(resolveAssistantHarnessIndicator(assistantHarness, entry));
      } catch {
        if (!cancelled) {
          setHarnessIndicator({
            state: 'unavailable',
            label: `${assistantHarness}: Readiness could not be verified`,
          });
        }
      }
    };

    setHarnessIndicator({ state: 'checking', label: `${assistantHarness}: Checking readiness…` });
    void checkHarnessStatus();
    const interval = setInterval(() => { void checkHarnessStatus(); }, 30000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [assistant, assistantHarness, isAuthenticated, userCanViewHarnessStatus]);

  const initial = assistant ? 'A' : (username || 'U')[0].toUpperCase();
  const defaultRing = assistant ? 'accent-avatar' : ringColor;
  const defaultBg = assistant ? '' : 'bg-purple-500/20';
  const defaultText = assistant ? '' : 'text-purple-400';

  return (
    <>
      <button
        type="button"
        disabled={!editable}
        aria-label={editable ? `Change ${assistant ? 'assistant' : 'user'} avatar` : `${assistant ? 'Assistant' : username || 'User'} avatar`}
        className="relative flex-shrink-0 group"
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onClick={() => {
          if (editable) setEditorOpen(true);
        }}
        style={editable ? { cursor: 'pointer' } : undefined}
      >
        {avatarUrl ? (
          <img
            src={avatarUrl}
            alt={assistant ? 'Assistant' : username || 'User'}
            className={`avatar-hq ${size} rounded-full object-cover ring-2 ${defaultRing}`}
            onError={() => {
              if (assistant) setAssistantAvatarUrl(null);
              else setCachedUserAvatarUrl(null);
            }}
          />
        ) : (
          <div className={`${size} rounded-full ring-2 ${defaultRing} ${defaultBg} flex items-center justify-center ${defaultText} font-bold text-sm`}>
            {initial}
          </div>
        )}
        {assistant && userCanViewHarnessStatus && (
          <div 
            className={`absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-full border-2 border-[#0D1130] ${
              harnessIndicator.state === 'ready' ? 'bg-emerald-500' :
              harnessIndicator.state === 'checking' ? 'bg-yellow-400 animate-pulse' :
              'bg-red-500'
            }`}
            style={{
              backgroundColor: harnessIndicator.state === 'ready'
                ? '#10b981'
                : harnessIndicator.state === 'checking'
                ? '#facc15'
                : '#ef4444',
              boxShadow: harnessIndicator.state === 'ready'
                ? '0 0 8px rgba(16, 185, 129, 0.6), 0 0 12px rgba(16, 185, 129, 0.4)'
                : harnessIndicator.state === 'checking'
                ? '0 0 8px rgba(250, 204, 21, 0.6), 0 0 12px rgba(250, 204, 21, 0.4)'
                : '0 0 8px rgba(239, 68, 68, 0.6), 0 0 12px rgba(239, 68, 68, 0.4)'
            }}
            title={harnessIndicator.label}
            aria-label={harnessIndicator.label}
          />
        )}
        {editable && hover && (
          <div className="theme-fixed-dark absolute inset-0 rounded-full bg-black/60 flex items-center justify-center">
            <Pencil size={14} className="text-white" />
          </div>
        )}
      </button>
      {editable && (
        <AvatarEditor
          isOpen={editorOpen}
          onClose={() => setEditorOpen(false)}
          onSaved={(url) => {
            const cleanUrl = url ? url.replace(/[?&]t=\d+/, '') : null;
            if (assistant) {
              setAssistantAvatarUrl(url);
              if (cleanUrl) sessionStorage.setItem('cached_assistantAvatar', cleanUrl);
              else sessionStorage.removeItem('cached_assistantAvatar');
            } else {
              setCachedUserAvatarUrl(url, cleanUrl);
            }
          }}
          currentAvatarUrl={avatarUrl}
          uploadEndpoint={assistant ? '/users/assistant-avatar' : '/users/me/avatar'}
        />
      )}
    </>
  );
}
