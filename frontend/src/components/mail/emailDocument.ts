const REMOTE_CONTENT_PATTERN = /(?:\b(?:src|srcset|poster|background)\s*=\s*["']?\s*(?:https?:)?\/\/|<link\b(?=[^>]*\brel\s*=\s*["']?stylesheet["']?)(?=[^>]*\bhref\s*=\s*["']?\s*(?:https?:)?\/\/)[^>]*>|url\s*\(\s*["']?\s*(?:https?:)?\/\/|@import\b)/i;

export function containsRemoteMailContent(content: string): boolean {
  return REMOTE_CONTENT_PATTERN.test(content);
}

function escapePlainText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function buildEmailDocument(
  content: string,
  isHtml: boolean,
  allowRemoteContent: boolean,
): string {
  const contentSecurityPolicy = allowRemoteContent
    ? "default-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'; script-src 'none'; connect-src 'none'; img-src http: https: data: blob: cid:; style-src 'unsafe-inline' http: https:; font-src data: http: https:"
    : "default-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'; script-src 'none'; connect-src 'none'; img-src data: blob: cid:; style-src 'unsafe-inline'; font-src data:";
  const commonHead = `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy}">`;

  if (isHtml) {
    return `<!DOCTYPE html><html><head>${commonHead}<style>
      body { margin: 0; padding: 16px; font-family: system-ui, sans-serif; font-size: 14px; line-height: 1.6; overflow-wrap: break-word; word-break: break-word; }
      a { color: #6366f1; }
      img { max-width: 100% !important; height: auto !important; }
      table { max-width: 100% !important; }
      @media (max-width: 640px) {
        body { padding: 12px; font-size: 15px; }
        table { width: 100% !important; }
        td { display: block !important; width: 100% !important; box-sizing: border-box; }
      }
    </style></head><body>${content}</body></html>`;
  }

  return `<!DOCTYPE html><html><head>${commonHead}<style>
    body { margin: 0; padding: 16px; background: #0a0e1a; color: #e2e8f0; font-family: system-ui, sans-serif; font-size: 14px; line-height: 1.6; overflow-wrap: break-word; word-break: break-word; }
    a { color: #818cf8; }
    blockquote { border-left: 3px solid #334155; padding-left: 12px; margin-left: 0; color: #94a3b8; }
    @media (max-width: 640px) { body { padding: 12px; font-size: 15px; } }
  </style></head><body><pre style="white-space:pre-wrap;font:inherit;margin:0;">${escapePlainText(content)}</pre></body></html>`;
}
