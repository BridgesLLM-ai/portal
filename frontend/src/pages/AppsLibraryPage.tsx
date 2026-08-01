import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, Copy, ExternalLink, Globe, Loader2, PackageOpen, Plus, Share2, Trash2, Upload } from 'lucide-react';
import { appsAPI } from '../api/endpoints';

interface AppShareLink {
  id: string;
  token: string;
  isActive: boolean;
  isPublic?: boolean;
  currentUses?: number;
  maxUses?: number | null;
  expiresAt?: string | null;
  createdAt: string;
}

interface PortalApp {
  id: string;
  name: string;
  description?: string | null;
  createdAt: string;
  updatedAt: string;
  shareLinks?: AppShareLink[];
}

type AppShareAvailability = 'active' | 'disabled' | 'expired' | 'exhausted';

function appShareAvailability(link: AppShareLink, now = Date.now()): AppShareAvailability {
  if (link.expiresAt) {
    const expiresAt = new Date(link.expiresAt).getTime();
    if (!Number.isFinite(expiresAt) || expiresAt <= now) return 'expired';
  }
  if (link.maxUses !== null && link.maxUses !== undefined && (link.currentUses || 0) >= link.maxUses) return 'exhausted';
  return link.isActive ? 'active' : 'disabled';
}

function isUsableShareLink(link: AppShareLink, now = Date.now()): boolean {
  return appShareAvailability(link, now) === 'active';
}

function appShareAvailabilityLabel(availability: AppShareAvailability): string {
  if (availability === 'expired') return 'Expired';
  if (availability === 'exhausted') return 'Limit reached';
  if (availability === 'disabled') return 'Disabled';
  return 'Active';
}

function timeAgo(dateStr: string) {
  const d = new Date(dateStr);
  const now = new Date();
  const mins = Math.floor((now.getTime() - d.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString();
}

export default function AppsLibraryPage() {
  const [apps, setApps] = useState<PortalApp[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [workingAppId, setWorkingAppId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [shareExpiresAt, setShareExpiresAt] = useState('');
  const [shareMaxUses, setShareMaxUses] = useState('');

  const loadApps = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await appsAPI.list();
      setApps(data.apps || []);
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Failed to load apps');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadApps();
  }, [loadApps]);

  const sortedApps = useMemo(
    () => [...apps].sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt)),
    [apps],
  );

  const resetComposer = () => {
    setName('');
    setDescription('');
    setFile(null);
  };

  const handleUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) {
      setError('Choose a ZIP file to upload');
      return;
    }
    if (name.trim().length > 120 || description.trim().length > 4_000) {
      setError('App names are limited to 120 characters and descriptions to 4000 characters');
      return;
    }

    setUploading(true);
    setError('');
    setNotice('');
    try {
      const formData = new FormData();
      formData.append('file', file);
      if (name.trim()) formData.append('name', name.trim());
      if (description.trim()) formData.append('description', description.trim());
      await appsAPI.create(formData);
      resetComposer();
      setNotice('App uploaded successfully');
      await loadApps();
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Failed to upload app');
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async (app: PortalApp) => {
    if (!window.confirm(`Delete ${app.name}? This removes the uploaded app package.`)) return;
    setWorkingAppId(app.id);
    setError('');
    setNotice('');
    try {
      await appsAPI.delete(app.id);
      setNotice(`Deleted ${app.name}`);
      await loadApps();
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Failed to delete app');
    } finally {
      setWorkingAppId(null);
    }
  };

  const handleCreateShare = async (app: PortalApp) => {
    const expiresAt = shareExpiresAt ? new Date(shareExpiresAt) : null;
    if (expiresAt && (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now())) {
      setError('Share expiration must be in the future');
      return;
    }
    const maxUses = shareMaxUses ? Number(shareMaxUses) : null;
    if (maxUses !== null && (!Number.isSafeInteger(maxUses) || maxUses < 1 || maxUses > 1_000_000)) {
      setError('Share visit limit must be a whole number from 1 to 1,000,000');
      return;
    }
    setWorkingAppId(app.id);
    setError('');
    setNotice('');
    try {
      const data = await appsAPI.createShareLink(app.id, {
        ...(expiresAt ? { expiresAt: expiresAt.toISOString() } : {}),
        ...(maxUses !== null ? { maxUses } : {}),
      });
      const fullUrl = `${window.location.origin}${data.url}`;
      await loadApps();
      setShareExpiresAt('');
      setShareMaxUses('');
      try {
        await navigator.clipboard.writeText(fullUrl);
        setNotice(`Share link created and copied for ${app.name}`);
      } catch {
        setNotice(`Share link created for ${app.name}. Use its Copy button to copy it.`);
      }
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Failed to create share link');
    } finally {
      setWorkingAppId(null);
    }
  };

  const copyShareLink = async (token: string) => {
    const fullUrl = `${window.location.origin}/share/${token}`;
    try {
      await navigator.clipboard.writeText(fullUrl);
      setNotice('Share link copied');
    } catch {
      setError('Clipboard access is unavailable. Copy the visible link manually.');
    }
  };

  const handleToggleShare = async (app: PortalApp, link: AppShareLink) => {
    const availability = appShareAvailability(link);
    if (availability === 'expired' || availability === 'exhausted') {
      setError(availability === 'expired'
        ? 'Expired links cannot be reactivated; create a new link.'
        : 'Links that reached their visit limit cannot be reactivated; create a new link.');
      return;
    }
    setWorkingAppId(app.id);
    setError('');
    setNotice('');
    try {
      await appsAPI.updateShareLink(app.id, link.id, !link.isActive);
      setNotice(link.isActive ? 'Share link disabled' : 'Share link enabled');
      await loadApps();
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Failed to update share link');
    } finally {
      setWorkingAppId(null);
    }
  };

  const handleDeleteShare = async (app: PortalApp, link: AppShareLink) => {
    if (!window.confirm('Delete this share link permanently? Existing recipients will lose access.')) return;
    setWorkingAppId(app.id);
    setError('');
    setNotice('');
    try {
      await appsAPI.deleteShareLink(app.id, link.id);
      setNotice('Share link deleted');
      await loadApps();
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Failed to delete share link');
    } finally {
      setWorkingAppId(null);
    }
  };

  return (
    <div className="h-full overflow-y-auto p-4 md:p-6 lg:p-8 bg-theme-bg text-white">
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="text-[11px] uppercase tracking-[0.24em] text-emerald-300/70 mb-2">Apps</p>
            <h1 className="text-2xl md:text-3xl font-semibold text-white">Upload and manage packaged apps</h1>
            <p className="text-sm text-slate-400 mt-2 max-w-3xl">
              This route now uses the mounted Apps API instead of the Projects workspace. Upload a ZIP package,
              keep track of existing apps, and create share links from one dedicated surface.
            </p>
          </div>
          <button
            onClick={loadApps}
            disabled={loading}
            className="inline-flex items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-4 py-2 text-sm text-slate-200 hover:bg-white/[0.07] disabled:opacity-50"
          >
            {loading ? <Loader2 size={16} className="animate-spin" /> : <PackageOpen size={16} />}
            Refresh apps
          </button>
        </div>

        {(error || notice) && (
          <div className={`rounded-2xl border px-4 py-3 text-sm ${error ? 'border-red-500/30 bg-red-500/10 text-red-100' : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-100'}`}>
            <div className="flex items-start gap-2">
              {error ? <AlertCircle size={16} className="mt-0.5 shrink-0" /> : <Globe size={16} className="mt-0.5 shrink-0" />}
              <span>{error || notice}</span>
            </div>
          </div>
        )}

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.15fr)_minmax(320px,0.85fr)]">
          <section className="rounded-3xl border border-white/10 bg-white/[0.03] backdrop-blur-sm overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-white/10">
              <div>
                <h2 className="text-lg font-medium text-white">Your apps</h2>
                <p className="text-sm text-slate-400 mt-1">A dedicated Apps index instead of the Projects shell.</p>
              </div>
              <div className="rounded-full bg-white/[0.06] px-3 py-1 text-xs text-slate-300">
                {sortedApps.length} {sortedApps.length === 1 ? 'app' : 'apps'}
              </div>
            </div>
            <div className="grid gap-3 border-b border-white/10 bg-black/10 px-5 py-4 sm:grid-cols-2">
              <label className="space-y-1.5 text-xs text-slate-400">
                <span>New-link expiration (optional)</span>
                <input
                  aria-label="New app share expiration"
                  type="datetime-local"
                  value={shareExpiresAt}
                  onChange={(event) => setShareExpiresAt(event.target.value)}
                  className="min-h-[44px] w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                />
              </label>
              <label className="space-y-1.5 text-xs text-slate-400">
                <span>New-link visit limit (optional)</span>
                <input
                  aria-label="New app share visit limit"
                  type="number"
                  min={1}
                  max={1_000_000}
                  step={1}
                  value={shareMaxUses}
                  onChange={(event) => setShareMaxUses(event.target.value)}
                  placeholder="Unlimited"
                  className="min-h-[44px] w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                />
              </label>
              <p className="text-xs text-slate-500 sm:col-span-2">
                These controls apply to the next link you create. Visit limits count granted browser visits, not page views.
              </p>
            </div>

            {loading ? (
              <div className="flex items-center justify-center py-20 text-slate-400 gap-3">
                <Loader2 size={18} className="animate-spin" /> Loading apps…
              </div>
            ) : sortedApps.length === 0 ? (
              <div className="px-6 py-16 text-center">
                <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-dashed border-white/15 bg-white/[0.03]">
                  <Upload size={24} className="text-emerald-300" />
                </div>
                <h3 className="text-lg font-medium text-white">No apps uploaded yet</h3>
                <p className="mt-2 text-sm text-slate-400 max-w-md mx-auto">
                  Upload a ZIP package to create your first app. This page stays app-specific so `/apps` no longer falls back to the Projects empty state.
                </p>
              </div>
            ) : (
              <div className="divide-y divide-white/8">
                {sortedApps.map((app) => {
                  const usableShares = app.shareLinks?.filter((link) => isUsableShareLink(link)) || [];
                  const working = workingAppId === app.id;
                  return (
                    <div key={app.id} className="px-5 py-4">
                      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <h3 className="text-base font-medium text-white break-all">{app.name}</h3>
                            {usableShares.length > 0 && (
                              <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-200">
                                Shared
                              </span>
                            )}
                          </div>
                          <p className="mt-2 text-sm text-slate-400 break-words">
                            {app.description?.trim() || 'No description provided yet.'}
                          </p>
                          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
                            <span>Updated {timeAgo(app.updatedAt)}</span>
                            <span>Created {new Date(app.createdAt).toLocaleDateString()}</span>
                            {app.shareLinks?.length ? (
                              <span>{usableShares.length} usable / {app.shareLinks.length} total share link{app.shareLinks.length === 1 ? '' : 's'}</span>
                            ) : null}
                          </div>
                          {app.shareLinks?.length ? (
                            <div className="mt-3 space-y-2" aria-label={`Share links for ${app.name}`}>
                              {app.shareLinks.map((link) => {
                                const availability = appShareAvailability(link);
                                const usable = availability === 'active';
                                const shareUrl = `${window.location.origin}/share/${link.token}`;
                                return (
                                  <div key={link.id} className="rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-xs text-slate-300">
                                    <div className="flex min-w-0 items-center gap-2">
                                      <span className="min-w-0 flex-1 truncate">{shareUrl}</span>
                                      <span className={usable ? 'text-emerald-300' : 'text-amber-300'}>{appShareAvailabilityLabel(availability)}</span>
                                      <button
                                        type="button"
                                        onClick={() => copyShareLink(link.token)}
                                        disabled={!usable || working}
                                        className="inline-flex size-9 items-center justify-center rounded-lg text-slate-300 hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                                        aria-label="Copy app share link"
                                      >
                                        <Copy size={14} />
                                      </button>
                                      {usable && (
                                        <a
                                          href={shareUrl}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          className="inline-flex size-9 items-center justify-center rounded-lg text-slate-300 hover:bg-white/10 hover:text-white"
                                          aria-label="Open app share link"
                                        >
                                          <ExternalLink size={14} />
                                        </a>
                                      )}
                                    </div>
                                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500">
                                      <span>
                                        {link.currentUses || 0} visits{link.maxUses ? ` / ${link.maxUses} max` : ''}
                                        {link.expiresAt ? ` • expires ${new Date(link.expiresAt).toLocaleString()}` : ''}
                                      </span>
                                      <span className="flex items-center gap-2">
                                        <button
                                          type="button"
                                          onClick={() => handleToggleShare(app, link)}
                                          disabled={working || availability === 'expired' || availability === 'exhausted'}
                                          className="min-h-[36px] rounded-lg border border-white/10 px-2.5 text-slate-300 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
                                        >
                                          {link.isActive ? 'Disable' : 'Enable'}
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() => handleDeleteShare(app, link)}
                                          disabled={working}
                                          className="inline-flex min-h-[36px] items-center gap-1 rounded-lg border border-red-500/20 px-2.5 text-red-200 hover:bg-red-500/10 disabled:opacity-40"
                                        >
                                          <Trash2 size={12} /> Delete link
                                        </button>
                                      </span>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          ) : null}
                        </div>

                        <div className="flex flex-wrap gap-2 lg:justify-end">
                          <button
                            onClick={() => handleCreateShare(app)}
                            disabled={working}
                            className="inline-flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-100 hover:bg-emerald-500/15 disabled:opacity-50"
                          >
                            {working ? <Loader2 size={15} className="animate-spin" /> : <Share2 size={15} />}
                            {app.shareLinks?.length ? 'New share link' : 'Create share link'}
                          </button>
                          <button
                            onClick={() => handleDelete(app)}
                            disabled={working}
                            className="inline-flex items-center gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-100 hover:bg-red-500/15 disabled:opacity-50"
                          >
                            {working ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />}
                            Delete
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <section className="rounded-3xl border border-white/10 bg-white/[0.03] p-5 backdrop-blur-sm h-fit">
            <div className="flex items-center gap-3 mb-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-emerald-500/15 text-emerald-200">
                <Plus size={18} />
              </div>
              <div>
                <h2 className="text-lg font-medium text-white">Upload a new app</h2>
                <p className="text-sm text-slate-400">Package the app as a ZIP and add it to the mounted Apps library.</p>
              </div>
            </div>

            <form onSubmit={handleUpload} className="space-y-4">
              <div>
                <label htmlFor="app-upload-name" className="block text-sm font-medium text-slate-200 mb-2">Name</label>
                <input
                  id="app-upload-name"
                  maxLength={120}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Optional, defaults to the ZIP filename"
                  className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                />
              </div>

              <div>
                <label htmlFor="app-upload-description" className="block text-sm font-medium text-slate-200 mb-2">Description</label>
                <textarea
                  id="app-upload-description"
                  maxLength={4_000}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={3}
                  placeholder="Optional notes for this uploaded app"
                  className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                />
              </div>

              <div>
                <p className="block text-sm font-medium text-slate-200 mb-2">ZIP package</p>
                <label className="flex cursor-pointer items-center justify-between gap-3 rounded-2xl border border-dashed border-white/15 bg-black/20 px-4 py-3 text-sm text-slate-300 hover:border-emerald-400/40 hover:bg-white/[0.04]">
                  <span className="truncate">{file ? file.name : 'Choose a .zip file'}</span>
                  <span className="inline-flex items-center gap-2 rounded-lg bg-white/[0.06] px-3 py-1.5 text-xs text-slate-200">
                    <Upload size={14} /> Browse
                  </span>
                  <input
                    type="file"
                    accept=".zip,application/zip"
                    aria-label="Choose app ZIP package"
                    className="hidden"
                    onChange={(e) => setFile(e.target.files?.[0] || null)}
                  />
                </label>
              </div>

              <button
                type="submit"
                disabled={uploading}
                className="inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-emerald-500 px-4 py-3 text-sm font-medium text-white hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {uploading ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />}
                Upload app
              </button>
            </form>
          </section>
        </div>
      </div>
    </div>
  );
}
