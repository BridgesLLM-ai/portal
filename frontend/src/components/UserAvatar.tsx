import { useState, useEffect } from 'react';
import { Pencil } from 'lucide-react';
import AvatarEditor from './AvatarEditor';
import client from '../api/client';
import { useAuthStore } from '../contexts/AuthContext';
import { isElevated } from '../utils/authz';
import { setCachedUserAvatarUrl, useUserAvatarUrl } from '../hooks/useUserAvatarUrl';

interface UserAvatarProps {
  size?: string;
  ringColor?: string;
  editable?: boolean;
  username?: string;
  assistant?: boolean;
}

type GatewayStatus = 'connected' | 'disconnected' | 'checking';

export default function UserAvatar({ size = 'w-10 h-10', ringColor = 'ring-purple-500/50', editable = true, username, assistant = false }: UserAvatarProps) {
  const userAvatarUrl = useUserAvatarUrl({ enabled: !assistant });
  const [assistantAvatarUrl, setAssistantAvatarUrl] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const [gatewayStatus, setGatewayStatus] = useState<GatewayStatus>('checking');
  const { user, isAuthenticated } = useAuthStore();
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

  // Check OpenClaw gateway connection status (Assistant only)
  useEffect(() => {
    if (!assistant) return;
    if (!isAuthenticated || !isElevated(user)) {
      setGatewayStatus('disconnected');
      return;
    }

    let cancelled = false;

    const checkGatewayStatus = async () => {
      try {
        const { data } = await client.get('/gateway/health', {
          timeout: 5000,
          _silent: true,
        } as any);

        if (cancelled) return;

        // Use wsConnected (authenticated persistent WS) — not just HTTP probe
        // This ensures the green dot only shows when agent chat actually works
        setGatewayStatus(data?.wsConnected ? 'connected' : 'disconnected');
      } catch {
        if (!cancelled) setGatewayStatus('disconnected');
      }
    };

    void checkGatewayStatus();
    const interval = setInterval(() => { void checkGatewayStatus(); }, 30000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [assistant, isAuthenticated, user]);

  const initial = assistant ? 'A' : (username || 'U')[0].toUpperCase();
  const defaultRing = assistant ? 'ring-emerald-500/50' : ringColor;
  const defaultBg = assistant ? 'bg-emerald-500/20' : 'bg-purple-500/20';
  const defaultText = assistant ? 'text-emerald-400' : 'text-purple-400';

  return (
    <>
      <div
        className="relative flex-shrink-0 group"
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onClick={editable ? () => setEditorOpen(true) : undefined}
        style={editable ? { cursor: 'pointer' } : undefined}
      >
        {avatarUrl ? (
          <img
            src={avatarUrl}
            alt={assistant ? 'Assistant' : username || 'User'}
            className={`avatar-hq ${size} rounded-full object-cover ring-2 ${defaultRing} ${assistant ? 'shadow-lg shadow-emerald-500/20' : ''}`}
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
        {assistant && (
          <div 
            className={`absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-full border-2 border-[#0D1130] ${
              gatewayStatus === 'connected' ? 'bg-emerald-500' :
              gatewayStatus === 'checking' ? 'bg-yellow-400 animate-pulse' :
              'bg-red-500'
            }`}
            style={{
              backgroundColor: gatewayStatus === 'connected' 
                ? '#10b981' 
                : gatewayStatus === 'checking'
                ? '#facc15'
                : '#ef4444',
              boxShadow: gatewayStatus === 'connected' 
                ? '0 0 8px rgba(16, 185, 129, 0.6), 0 0 12px rgba(16, 185, 129, 0.4)' 
                : gatewayStatus === 'checking'
                ? '0 0 8px rgba(250, 204, 21, 0.6), 0 0 12px rgba(250, 204, 21, 0.4)'
                : '0 0 8px rgba(239, 68, 68, 0.6), 0 0 12px rgba(239, 68, 68, 0.4)'
            }}
            title={
              gatewayStatus === 'connected' ? 'OpenClaw Gateway: Connected' :
              gatewayStatus === 'checking' ? 'OpenClaw Gateway: Checking...' :
              'OpenClaw Gateway: Disconnected'
            }
          />
        )}
        {editable && hover && (
          <div className="absolute inset-0 rounded-full bg-black/60 flex items-center justify-center">
            <Pencil size={14} className="text-white" />
          </div>
        )}
      </div>
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
