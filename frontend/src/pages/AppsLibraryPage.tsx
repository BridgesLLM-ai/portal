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
    setWorkingAppId(app.id);
    setError('');
    setNotice('');
    try {
      const data = await appsAPI.createShareLink(app.id);
      const fullUrl = `${window.location.origin}${data.url}`;
      await navigator.clipboard.writeText(fullUrl);
      setNotice(`Share link copied for ${app.name}`);
      await loadApps();
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Failed to create share link');
    } finally {
      setWorkingAppId(null);
    }
  };

  const copyShareLink = async (token: string) => {
    const fullUrl = `${window.location.origin}/share/${token}`;
    await navigator.clipboard.writeText(fullUrl);
    setNotice('Share link copied');
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
                  const activeShare = app.shareLinks?.find((link) => link.isActive);
                  const working = workingAppId === app.id;
                  const shareUrl = activeShare ? `${window.location.origin}/share/${activeShare.token}` : null;
                  return (
                    <div key={app.id} className="px-5 py-4">
                      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <h3 className="text-base font-medium text-white break-all">{app.name}</h3>
                            {activeShare && (
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
                            {app.shareLinks?.length ? <span>{app.shareLinks.length} active share link{app.shareLinks.length === 1 ? '' : 's'}</span> : null}
                          </div>
                          {shareUrl && (
                            <div className="mt-3 flex items-center gap-2 rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-xs text-slate-300 overflow-hidden">
                              <span className="truncate flex-1">{shareUrl}</span>
                              <button onClick={() => copyShareLink(activeShare!.token)} className="rounded-lg p-1.5 text-slate-300 hover:bg-white/10 hover:text-white" title="Copy share link">
                                <Copy size={14} />
                              </button>
                              <a href={shareUrl} target="_blank" rel="noopener noreferrer" className="rounded-lg p-1.5 text-slate-300 hover:bg-white/10 hover:text-white" title="Open share link">
                                <ExternalLink size={14} />
                              </a>
                            </div>
                          )}
                        </div>

                        <div className="flex flex-wrap gap-2 lg:justify-end">
                          <button
                            onClick={() => handleCreateShare(app)}
                            disabled={working}
                            className="inline-flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-100 hover:bg-emerald-500/15 disabled:opacity-50"
                          >
                            {working ? <Loader2 size={15} className="animate-spin" /> : <Share2 size={15} />}
                            {activeShare ? 'New share link' : 'Create share link'}
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
                <label className="block text-sm font-medium text-slate-200 mb-2">Name</label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Optional, defaults to the ZIP filename"
                  className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-200 mb-2">Description</label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={3}
                  placeholder="Optional notes for this uploaded app"
                  className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-200 mb-2">ZIP package</label>
                <label className="flex cursor-pointer items-center justify-between gap-3 rounded-2xl border border-dashed border-white/15 bg-black/20 px-4 py-3 text-sm text-slate-300 hover:border-emerald-400/40 hover:bg-white/[0.04]">
                  <span className="truncate">{file ? file.name : 'Choose a .zip file'}</span>
                  <span className="inline-flex items-center gap-2 rounded-lg bg-white/[0.06] px-3 py-1.5 text-xs text-slate-200">
                    <Upload size={14} /> Browse
                  </span>
                  <input
                    type="file"
                    accept=".zip,application/zip"
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
