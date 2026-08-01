// ── Mail Types ─────────────────────────────────────────────────

export interface MailboxInfo {
  id: string;
  name: string;
  role: string | null;
  totalEmails: number;
  unreadEmails: number;
}

export interface EmailSummary {
  id: string;
  threadId: string;
  mailboxIds: Record<string, boolean>;
  from: { name: string; email: string }[];
  to: { name: string; email: string }[];
  subject: string;
  receivedAt: string;
  size: number;
  preview: string;
  hasAttachment: boolean;
  isUnread: boolean;
  isFlagged: boolean;
}

export interface EmailFull extends EmailSummary {
  htmlBody: { partId: string; type: string }[];
  textBody: { partId: string; type: string }[];
  bodyValues: Record<string, { value: string; isEncodingProblem: boolean }>;
  attachments: {
    partId: string;
    blobId: string;
    name: string | null;
    type: string;
    size: number;
    isDangerous: boolean;
    downloadToken: string | null;
  }[];
  cc?: { name: string; email: string }[];
  replyTo?: { name: string; email: string }[];
  messageId?: string[];
  inReplyTo?: string[];
  references?: string[];
}

export interface ComposeState {
  mode: 'new' | 'reply' | 'replyAll' | 'forward';
  replyTo?: EmailFull | null;
}

export interface AttachmentFile {
  file: File;
  id: string;
}

/**
 * A deliberately small, content-free signal that lets the Mail page keep its
 * account and navigation boundary stable while a child owns a mutation. The
 * child remains the sole progress/error surface; this is only coordination.
 */
export interface MailMutationActivity {
  kind: string;
  label: string;
  account?: string;
}

export type MailMutationChangeHandler = (
  activity: Readonly<MailMutationActivity> | null,
) => void;
