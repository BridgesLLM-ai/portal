import { buildDeferredFileReference } from './workspaceNavigation';

export interface PersistedChatAttachment {
  name: string;
  size: number;
  type: 'image' | 'text' | 'other';
  textContent?: string;
  fileId?: string;
  fileRevision?: string;
  serverPath?: string;
  toolUrl?: string;
  uploadStatus?: 'uploading' | 'done' | 'error';
  uploadError?: string;
}

function deferredPortalReference(fileId: string | undefined): string | null {
  if (!fileId) return null;
  try {
    return buildDeferredFileReference(fileId);
  } catch {
    return null;
  }
}

/**
 * Formats the attachment preamble persisted with an Agent Chat message.
 *
 * File IDs use the non-query API reference understood by MarkdownRenderer.
 * Path-only attachments retain the existing server_path metadata and never
 * mint an opaque navigation token before a user actually clicks a link.
 */
export function buildPersistedChatAttachmentText(
  attachments: readonly PersistedChatAttachment[],
  options: { nativeImages?: boolean } = {},
): string {
  if (attachments.length === 0) return '';
  const parts: string[] = [];
  for (const attachment of attachments) {
    if (options.nativeImages && attachment.type === 'image') {
      if (attachment.uploadStatus !== 'done' || !attachment.fileId || !attachment.fileRevision) {
        throw new Error('Wait for the photo upload to finish, or remove the failed photo.');
      }
      parts.push(`[portal-chat-image:${JSON.stringify({ fileId: attachment.fileId, revision: attachment.fileRevision })}]`);
      continue;
    }
    const portalReference = deferredPortalReference(attachment.fileId);
    const diskPathLine = attachment.serverPath
      ? `- server_path: ${attachment.serverPath}`
      : null;
    const toolUrlLine = attachment.toolUrl ? `- tool_url: ${attachment.toolUrl}` : null;
    const portalLine = portalReference ? `- portal_url: ${portalReference}` : null;

    if (attachment.type === 'text' && attachment.textContent) {
      parts.push([
        `Attached text file: ${attachment.name}`,
        diskPathLine,
        portalLine,
        'The file content is inlined below.',
        `\`\`\`${attachment.name}\n${attachment.textContent}\n\`\`\``,
      ].filter(Boolean).join('\n'));
      continue;
    }

    if (attachment.uploadStatus === 'error') {
      parts.push(
        `[File attached: ${attachment.name} (upload failed: ${
          attachment.uploadError || 'unknown error'
        })]`,
      );
      continue;
    }

    const typeHint = attachment.type === 'image'
      ? [
          'This is an image attachment.',
          'IMPORTANT: prefer tool_url when present because the gateway host may differ from the portal host.',
          attachment.toolUrl
            ? `Use the image tool with image="${attachment.toolUrl}".`
            : attachment.serverPath
              ? `Use the image tool with image="${attachment.serverPath}".`
              : 'Use the image tool on tool_url or server_path.',
          'Do not say you cannot access the image unless the tool itself returns an error.',
        ].join(' ')
      : /\.pdf$/i.test(attachment.name)
        ? [
            'This is a PDF attachment.',
            'IMPORTANT: prefer tool_url when present because the gateway host may differ from the portal host.',
            attachment.toolUrl
              ? `Use the pdf tool with pdf="${attachment.toolUrl}".`
              : attachment.serverPath
                ? `Use the pdf tool with pdf="${attachment.serverPath}".`
                : 'Use the pdf tool on tool_url or server_path.',
            'Do not say you cannot access the PDF unless the tool itself returns an error.',
          ].join(' ')
        : 'This file is attached on disk. Use tool_url or server_path to inspect it if needed.';

    parts.push([
      `Attached file: ${attachment.name}`,
      `- kind: ${attachment.type}`,
      `- size: ${attachment.size} bytes`,
      diskPathLine,
      toolUrlLine,
      portalLine,
      typeHint,
    ].filter(Boolean).join('\n'));
  }
  return `${parts.join('\n\n')}\n\n`;
}

/** Render persisted references as ordinary authorized Files links, never opaque protocol JSON. */
export function presentChatImageReferences(content: string): string {
  return content.replace(/^\[portal-chat-image:(\{[^\r\n]{1,256}\})\]$/gm, (marker, json: string) => {
    try {
      const ref = JSON.parse(json);
      if (!/^[a-f0-9-]{36}$/i.test(ref.fileId) || typeof ref.revision !== 'string') return marker;
      return `[Attached photo](/api/files/${encodeURIComponent(ref.fileId)})`;
    } catch { return marker; }
  });
}
