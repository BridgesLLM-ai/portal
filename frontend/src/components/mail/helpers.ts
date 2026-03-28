import {
  Mail, Inbox, Send, Trash2, Star, Archive, AlertTriangle,
} from 'lucide-react';
import { createElement } from 'react';

// ── Folder icon map ───────────────────────────────────────────

export function FolderIcon({ role, size = 16 }: { role: string | null; size?: number }) {
  switch (role) {
    case 'inbox': return createElement(Inbox, { size });
    case 'sent': return createElement(Send, { size });
    case 'trash': return createElement(Trash2, { size });
    case 'junk': return createElement(AlertTriangle, { size });
    case 'archive': return createElement(Archive, { size });
    case 'drafts': return createElement(Mail, { size });
    default: return createElement(Mail, { size });
  }
}

// ── Format helpers ────────────────────────────────────────────

export function formatDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday = d.toDateString() === yesterday.toDateString();

  if (isToday) return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (isYesterday) return 'Yesterday';
  if (now.getFullYear() === d.getFullYear()) return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

export function senderDisplay(from: { name: string; email: string }[]): string {
  if (!from.length) return 'Unknown';
  const f = from[0];
  return f.name || f.email;
}

export function senderInitials(from: { name: string; email: string }[]): string {
  const display = senderDisplay(from);
  const parts = display.split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return display.slice(0, 2).toUpperCase();
}
