import { useState, useRef, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X, ZoomIn, ZoomOut, Upload, Trash2 } from 'lucide-react';
import client from '../api/client';

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
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const resetState = useCallback(() => {
    setFile(null);
    setPreview(null);
    setZoom(1);
    setOffset({ x: 0, y: 0 });
    setSaving(false);
    setError(null);
  }, []);

  useEffect(() => { if (!isOpen) resetState(); }, [isOpen, resetState]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setFile(f);
    setZoom(1);
    setOffset({ x: 0, y: 0 });
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
    if (!file) return;
    setSaving(true);
    setError(null);
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
      const msg = err?.response?.data?.error || err?.message || 'Upload failed';
      console.error('Image save error:', err);
      setError(msg);
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async () => {
    if (!deleteEndpoint) return;
    setSaving(true);
    setError(null);
    try {
      await client.delete(deleteEndpoint);
      onSaved(null);
      onClose();
    } catch (err: any) {
      const msg = err?.response?.data?.error || err?.message || 'Remove failed';
      setError(msg);
    } finally {
      setSaving(false);
    }
  };

  if (!isOpen) return null;

  const roundedClass = shape === 'circle' ? 'rounded-full' : 'rounded-2xl';

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-[#1a1f36] rounded-2xl shadow-2xl border border-white/10 w-[420px] max-w-[95vw]" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
          <h2 className="text-lg font-bold text-white">{title}</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white"><X size={20} /></button>
        </div>

        <div className="px-6 py-6 flex flex-col items-center gap-5">
          <div
            className={`w-[240px] h-[240px] ${roundedClass} overflow-hidden border-4 border-white/20 bg-[#0B0F1A] cursor-grab active:cursor-grabbing select-none relative`}
            onMouseDown={handleMouseDown}
            onTouchStart={handleTouchStart}
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
          </div>

          {preview && (
            <div className="flex items-center gap-3 w-full max-w-[280px]">
              <ZoomOut size={16} className="text-slate-400" />
              <input type="range" min="0.5" max="3" step="0.05" value={zoom}
                onChange={e => setZoom(parseFloat(e.target.value))}
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
            <div className="w-full text-xs text-red-300 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          <button onClick={() => fileInputRef.current?.click()}
            className="px-5 py-2.5 rounded-xl bg-white/5 border border-white/10 text-slate-300 hover:bg-white/10 hover:text-white transition-all text-sm font-medium">
            {preview ? 'Choose Different Image' : 'Choose Image'}
          </button>
          <input ref={fileInputRef} type="file" accept={accept} className="hidden" onChange={handleFileSelect} />
        </div>

        <div className="flex items-center justify-between px-6 py-4 border-t border-white/10 bg-black/20">
          <button onClick={handleRemove} disabled={saving || !deleteEndpoint || !currentImageUrl}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-red-400 hover:bg-red-500/10 disabled:opacity-30 disabled:cursor-not-allowed text-sm">
            <Trash2 size={14} /> Remove
          </button>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-4 py-2 rounded-lg text-slate-400 hover:text-white text-sm">Cancel</button>
            <button onClick={handleSave} disabled={!file || saving}
              className="px-5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-medium disabled:opacity-40 disabled:cursor-not-allowed text-sm">
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
