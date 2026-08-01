import { useState, useRef, useCallback, useEffect, useId } from 'react';
import { X, ZoomIn, ZoomOut, Upload, Trash2, Loader2, Wrench } from 'lucide-react';
import client from '../api/client';
import ViewportModal from './ViewportModal';
import { useSettingsMutationCoordinator } from './settings/SettingsMutationContext';

interface ImagePickerCropperProps {
  isOpen: boolean;
  onClose: () => void;
  onSaved: (assetUrl: string | null) => void;
  currentImageUrl: string | null;
  uploadEndpoint: string;
  fieldName?: string;
  title?: string;
  shape?: 'circle' | 'square';
  accept?: string;
  deleteEndpoint?: string;
  responseKey?: string;
}

export default function ImagePickerCropper({
  isOpen,
  onClose,
  onSaved,
  currentImageUrl,
  uploadEndpoint,
  fieldName = 'avatar',
  title = 'Edit Image',
  shape = 'circle',
  accept = 'image/gif,image/png,image/jpeg,image/webp',
  deleteEndpoint,
  responseKey = 'avatarUrl',
}: ImagePickerCropperProps) {
  const settingsMutation = useSettingsMutationCoordinator();
  const settingsClaim = settingsMutation?.claim;
  const settingsRelease = settingsMutation?.release;
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [pendingAction, setPendingAction] = useState<'save' | 'remove' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [repairUrl, setRepairUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const actionLockRef = useRef(false);
  const settingsMutationOwnerRef = useRef<string | null>(null);
  const titleId = useId();

  const resetState = useCallback(() => {
    setFile(null);
    setPreview(null);
    setZoom(1);
    setOffset({ x: 0, y: 0 });
    setPendingAction(null);
    setError(null);
    setRepairUrl(null);
  }, []);

  useEffect(() => { if (!isOpen) resetState(); }, [isOpen, resetState]);

  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview);
  }, [preview]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setFile(f);
    setZoom(1);
    setOffset({ x: 0, y: 0 });
    setError(null);
    setRepairUrl(null);
    setPreview(URL.createObjectURL(f));
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (!preview) return;
    e.preventDefault();
    setDragging(true);
    setDragStart({ x: e.clientX - offset.x, y: e.clientY - offset.y });
  };

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!dragging) return;
    setOffset({ x: e.clientX - dragStart.x, y: e.clientY - dragStart.y });
  }, [dragging, dragStart]);

  const handleMouseUp = useCallback(() => setDragging(false), []);

  useEffect(() => {
    if (dragging) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
      return () => {
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [dragging, handleMouseMove, handleMouseUp]);

  const handleTouchStart = (e: React.TouchEvent) => {
    if (!preview) return;
    const t = e.touches[0];
    setDragging(true);
    setDragStart({ x: t.clientX - offset.x, y: t.clientY - offset.y });
  };

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: TouchEvent) => {
      const t = e.touches[0];
      setOffset({ x: t.clientX - dragStart.x, y: t.clientY - dragStart.y });
    };
    const onEnd = () => setDragging(false);
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onEnd);
    return () => {
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
    };
  }, [dragging, dragStart]);

  const handleSave = async () => {
    if (!file || actionLockRef.current) return;
    const settingsOwner = `settings:image:${uploadEndpoint}:save`;
    if (settingsClaim && !settingsClaim(settingsOwner)) return;
    settingsMutationOwnerRef.current = settingsOwner;
    actionLockRef.current = true;
    setPendingAction('save');
    setError(null);
    setRepairUrl(null);
    try {
      const formData = new FormData();
      formData.append(fieldName, file);
      formData.append('zoom', zoom.toString());
      formData.append('offsetX', offset.x.toString());
      formData.append('offsetY', offset.y.toString());
      formData.append('previewSize', '240');

      // Use the portal's canonical API client so cookie/session auth works (withCredentials).
      const resp = await client.post(uploadEndpoint, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });

      const data = resp.data;
      const url = data?.[responseKey] || data?.avatarUrl || data?.logoUrl;
      onSaved(url ? `${url}?t=${Date.now()}` : null);
      onClose();
    } catch (err: any) {
      const failure = err?.response?.data;
      const msg = failure?.error || err?.message || 'Upload failed';
      console.error('Image save error:', err);
      setError(msg);
      setRepairUrl(typeof failure?.repairUrl === 'string' ? failure.repairUrl : null);
    } finally {
      actionLockRef.current = false;
      setPendingAction(null);
      if (settingsMutationOwnerRef.current === settingsOwner) {
        settingsMutationOwnerRef.current = null;
        settingsRelease?.(settingsOwner);
      }
    }
  };

  const handleRemove = async () => {
    if (!deleteEndpoint || actionLockRef.current) return;
    const settingsOwner = `settings:image:${deleteEndpoint}:remove`;
    if (settingsClaim && !settingsClaim(settingsOwner)) return;
    settingsMutationOwnerRef.current = settingsOwner;
    actionLockRef.current = true;
    setPendingAction('remove');
    setError(null);
    setRepairUrl(null);
    try {
      await client.delete(deleteEndpoint);
      onSaved(null);
      onClose();
    } catch (err: any) {
      const msg = err?.response?.data?.error || err?.message || 'Remove failed';
      setError(msg);
    } finally {
      actionLockRef.current = false;
      setPendingAction(null);
      if (settingsMutationOwnerRef.current === settingsOwner) {
        settingsMutationOwnerRef.current = null;
        settingsRelease?.(settingsOwner);
      }
    }
  };

  useEffect(() => () => {
    const owner = settingsMutationOwnerRef.current;
    if (owner) settingsRelease?.(owner);
    settingsMutationOwnerRef.current = null;
  }, [settingsRelease]);

  const handleRequestClose = () => {
    if (actionLockRef.current) return;
    onClose();
  };

  if (!isOpen) return null;

  const roundedClass = shape === 'circle' ? 'rounded-full' : 'rounded-2xl';

  const busy = pendingAction !== null;

  return (
    <ViewportModal
      open={isOpen}
      onDismiss={handleRequestClose}
      dismissible={!busy}
      initialFocusRef={closeButtonRef}
      className="overflow-y-auto bg-black/70 p-4 backdrop-blur-sm"
    >
      <div className="max-h-[calc(100dvh-2rem)] w-[420px] max-w-[95vw] overflow-y-auto overscroll-contain rounded-2xl border border-theme-border bg-theme-surface text-theme-text shadow-2xl" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-theme-border">
          <h2 id={titleId} className="text-lg font-bold text-theme-text">{title}</h2>
          <button ref={closeButtonRef} type="button" aria-label="Close image editor" onClick={handleRequestClose} disabled={busy} className="min-h-[44px] min-w-[44px] rounded-lg text-theme-text-muted transition hover:bg-theme-surface-hover hover:text-theme-text disabled:cursor-wait disabled:opacity-50"><X size={20} className="mx-auto" /></button>
        </div>

        <div className="px-6 py-6 flex flex-col items-center gap-5">
          <button
            type="button"
            disabled={busy}
            aria-label="Reposition image crop. Use the arrow keys or drag the image."
            className={`theme-fixed-dark w-[240px] h-[240px] ${roundedClass} overflow-hidden border-4 border-white/20 bg-[#0B0F1A] cursor-grab active:cursor-grabbing select-none relative disabled:cursor-wait disabled:opacity-80`}
            onMouseDown={handleMouseDown}
            onTouchStart={handleTouchStart}
            onKeyDown={(event) => {
              const delta = event.shiftKey ? 10 : 2;
              if (event.key === 'ArrowLeft') setOffset((current) => ({ ...current, x: current.x - delta }));
              else if (event.key === 'ArrowRight') setOffset((current) => ({ ...current, x: current.x + delta }));
              else if (event.key === 'ArrowUp') setOffset((current) => ({ ...current, y: current.y - delta }));
              else if (event.key === 'ArrowDown') setOffset((current) => ({ ...current, y: current.y + delta }));
              else return;
              event.preventDefault();
            }}
          >
            {preview ? (
              <img
                src={preview}
                alt="Preview"
                draggable={false}
                className="absolute pointer-events-none"
                style={{
                  left: '50%', top: '50%',
                  transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px)) scale(${zoom})`,
                  width: '100%', height: '100%',
                  objectFit: 'cover',
                }}
              />
            ) : currentImageUrl ? (
              <img src={currentImageUrl} alt="Current" className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-slate-500"><Upload size={48} /></div>
            )}
          </button>

          {preview && (
            <div className="flex items-center gap-3 w-full max-w-[280px]">
              <ZoomOut size={16} className="text-slate-400" />
              <input type="range" min="0.5" max="3" step="0.05" value={zoom}
                onChange={e => setZoom(parseFloat(e.target.value))}
                disabled={busy}
                aria-label="Image zoom"
                className="flex-1 accent-emerald-500 h-1.5" />
              <ZoomIn size={16} className="text-slate-400" />
            </div>
          )}

          {file && (
            <p className="text-xs text-slate-400">
              {file.name} • {(file.size / 1024 / 1024).toFixed(1)}MB
              {file.type === 'image/gif' && <span className="text-emerald-400"> • Animated GIF</span>}
            </p>
          )}

          {error && (
            <div role="alert" className="w-full text-xs text-red-300 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
              <p>{error}</p>
              {repairUrl && (
                <a
                  href={repairUrl}
                  className="mt-2 inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-1.5 font-medium text-amber-200 transition hover:bg-amber-400/20"
                >
                  <Wrench size={13} aria-hidden="true" />
                  Open repair tools
                </a>
              )}
            </div>
          )}

          <button type="button" onClick={() => fileInputRef.current?.click()} disabled={busy}
            className="px-5 py-2.5 rounded-xl bg-white/5 border border-white/10 text-slate-300 hover:bg-white/10 hover:text-white transition-all text-sm font-medium disabled:cursor-wait disabled:opacity-50">
            {preview ? 'Choose Different Image' : 'Choose Image'}
          </button>
          <input ref={fileInputRef} type="file" accept={accept} aria-label="Choose image" className="hidden" onChange={handleFileSelect} disabled={busy} />
        </div>

        <div className="flex items-center justify-between px-6 py-4 border-t border-theme-border bg-theme-surface-raised">
          <button type="button" onClick={() => { void handleRemove(); }} disabled={busy || !deleteEndpoint || !currentImageUrl} aria-busy={pendingAction === 'remove'}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-red-400 hover:bg-red-500/10 disabled:opacity-30 disabled:cursor-not-allowed text-sm">
            {pendingAction === 'remove' ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Trash2 size={14} />}
            {pendingAction === 'remove' ? 'Removing…' : 'Remove'}
          </button>
          <div className="flex gap-2">
            <button type="button" onClick={handleRequestClose} disabled={busy} className="px-4 py-2 rounded-lg text-slate-400 hover:text-white text-sm disabled:cursor-wait disabled:opacity-50">Cancel</button>
            <button type="button" onClick={() => { void handleSave(); }} disabled={!file || busy} aria-busy={pendingAction === 'save'}
              className="px-5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-medium disabled:opacity-40 disabled:cursor-not-allowed text-sm">
              <span className="inline-flex items-center gap-2">
                {pendingAction === 'save' && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
                {pendingAction === 'save' ? 'Saving…' : 'Save'}
              </span>
            </button>
          </div>
        </div>
      </div>
    </ViewportModal>
  );
}
