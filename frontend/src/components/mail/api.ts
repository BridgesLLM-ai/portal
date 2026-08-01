// ── Mail API helpers ───────────────────────────────────────────

/** Append ?account=... param when an explicit account is selected */
function withAccount(path: string, account?: string): string {
  if (!account) return path;
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}account=${encodeURIComponent(account)}`;
}

export async function apiFetch(path: string, opts?: RequestInit & { account?: string }) {
  const { account, ...fetchOpts } = opts || {};
  const url = `/api/mail${withAccount(path, account)}`;
  const res = await fetch(url, {
    ...fetchOpts,
    headers: { 'Content-Type': 'application/json', ...fetchOpts?.headers },
    credentials: 'include',
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export async function apiDownloadAttachment(
  blobId: string,
  capability: string,
  account?: string,
): Promise<Blob> {
  if (!capability) throw new Error('Attachment authorization is unavailable. Refresh the message and try again.');
  const url = `/api/mail${withAccount(`/attachments/${encodeURIComponent(blobId)}`, account)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { 'X-Mail-Attachment-Capability': capability },
    credentials: 'include',
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(error.error || `HTTP ${res.status}`);
  }
  return res.blob();
}

export async function apiSendWithAttachments(
  path: string,
  data: any,
  files: File[],
  account?: string
): Promise<any> {
  const formData = new FormData();
  formData.append('data', JSON.stringify(data));
  for (const file of files) {
    formData.append('attachments', file);
  }
  const url = `/api/mail${withAccount(path, account)}`;
  const res = await fetch(url, {
    method: 'POST',
    body: formData,
    credentials: 'include',
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export interface MailAccount {
  id: string;
  label: string;
  email: string;
  kind?: 'personal' | 'shared';
  isPrimary?: boolean;
}

export async function fetchMailAccounts(): Promise<{ accounts: MailAccount[]; hasMailbox: boolean }> {
  const res = await fetch('/api/mail/accounts', { credentials: 'include' });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(error.error || `HTTP ${res.status}`);
  }
  return res.json();
}
