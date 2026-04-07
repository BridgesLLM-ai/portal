/**
 * MarkdownRenderer — Enhanced markdown rendering with:
 * - Syntax-highlighted code blocks (highlight.js via rehype-highlight)
 * - Copy button on code blocks
 * - Optional in-chat preview for HTML / SVG / Markdown blocks
 * - Tables, links, bold/italic via remark-gfm
 * - Dark-mode styling consistent with the portal theme
 */
import { Children, isValidElement, useState, useCallback, useEffect, useMemo, memo, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
// rehype-raw removed: allowing raw HTML in markdown is dangerous — agent responses
// with unfenced HTML (e.g. raw <!DOCTYPE html>) would inject into the portal DOM,
// breaking layout and creating XSS vectors. Code blocks handle HTML rendering safely.
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { Copy, Check, Eye, EyeOff, Maximize2, Minimize2 } from 'lucide-react';

function resolvePortalHref(rawHref?: string): { href: string; external?: boolean } {
  const href = String(rawHref || '').trim();
  if (!href) return { href: '#' };

  const portalAbsolute = href.match(/^https?:\/\/[^/]+(\/files\?(?:file|path)=[^\s#]+)/i);
  if (portalAbsolute?.[1]) return { href: portalAbsolute[1] };
  if (/^https?:\/\//i.test(href) || href.startsWith('mailto:') || href.startsWith('tel:')) return { href, external: true };

  const uploadedFile = href.match(/\/api\/files\/([^\s?#)]+)/i);
  if (uploadedFile?.[1]) return { href: `/files?file=${encodeURIComponent(uploadedFile[1])}` };

  const fileQuery = href.match(/^\/files\?file=([^\s#]+)/i);
  if (fileQuery?.[1]) return { href: `/files?file=${fileQuery[1]}` };
  const pathQuery = href.match(/^\/files\?path=([^\s#]+)/i);
  if (pathQuery?.[1]) return { href: `/files?path=${pathQuery[1]}` };

  const explicitPath = href.match(/(?:server(?:_|\s)path|path):\s*([^\]\n)]+)/i)?.[1]?.trim()
    || href.match(/^\/?var\/portal-files\/[^\s)]+/i)?.[0]
    || href.match(/^\/?(?:root\/)?\.openclaw\/media\/portal-files\/[^\s)]+/i)?.[0]
    || href.match(/^~\/?\.openclaw\/media\/portal-files\/[^\s)]+/i)?.[0];
  if (explicitPath) return { href: `/files?path=${encodeURIComponent(explicitPath)}` };

  if (/^\/files(?:[/?#]|$)/i.test(href)) return { href };
  return { href, external: !href.startsWith('/') };
}

/* ─── Helpers ─────────────────────────────────────────────────────────── */

function extractTextContent(children: ReactNode): string {
  if (typeof children === 'string') return children;
  if (typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(extractTextContent).join('');
  if (children && typeof children === 'object' && 'props' in children) {
    return extractTextContent((children as any).props?.children);
  }
  return '';
}

function getLanguage(className?: string): string {
  const match = className?.match(/language-([\w-]+)/i);
  return (match?.[1] || '').toLowerCase();
}

function buildPreviewDocument(code: string, language: string): string | null {
  if (!code.trim()) return null;

  if (language === 'html') {
    // If the code already has a full document structure, use it as-is.
    // Otherwise, wrap it in a minimal document with a clean reset.
    const hasDoctype = /<!doctype\s+html/i.test(code);
    const hasHtmlTag = /<html[\s>]/i.test(code);
    if (hasDoctype || hasHtmlTag) {
      return code;
    }
    // Wrap partial HTML in a clean document — no inherited portal styles
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; min-height: 100%; }
  </style>
</head>
<body>
${code}
</body>
</html>`;
  }

  if (language === 'svg') {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    html, body {
      margin: 0;
      min-height: 100%;
      background: #0b1220;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 16px;
    }
    svg {
      max-width: 100%;
      max-height: 100%;
      height: auto;
    }
  </style>
</head>
<body>
${code}
</body>
</html>`;
  }

  if (language === 'md' || language === 'markdown') {
    marked.setOptions({ gfm: true, breaks: true });
    const rawHtml = marked.parse(code) as string;
    const safeHtml = DOMPurify.sanitize(rawHtml);
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 24px;
      font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      line-height: 1.6;
      color: #e2e8f0;
      background: #020617;
    }
    a { color: #34d399; }
    pre, code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    pre {
      overflow-x: auto;
      padding: 12px;
      border-radius: 10px;
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.08);
    }
    code { background: rgba(255,255,255,0.06); padding: 2px 6px; border-radius: 6px; }
    pre code { background: transparent; padding: 0; }
    blockquote { border-left: 3px solid rgba(167,139,250,0.6); margin: 0; padding-left: 12px; color: #cbd5e1; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border: 1px solid rgba(255,255,255,0.08); padding: 8px 10px; text-align: left; }
    th { background: rgba(255,255,255,0.05); }
  </style>
</head>
<body>
${safeHtml}
</body>
</html>`;
  }

  return null;
}

function getCodeBlockMetadata(className: string | undefined, children: ReactNode) {
  const childArray = Children.toArray(children);
  const codeChild = childArray.find((child) => isValidElement(child)) as any;
  const codeClassName = className || codeChild?.props?.className || '';
  const language = getLanguage(codeClassName);
  const codeText = extractTextContent(codeChild?.props?.children ?? children).replace(/\n$/, '');

  return {
    codeChild,
    codeClassName,
    language,
    codeText,
  };
}

/* ─── Buttons / blocks ───────────────────────────────────────────────── */

function PreviewableCodeBlock({ className, children, isStreaming = false, ...props }: any) {
  const [copied, setCopied] = useState(false);
  const [activeView, setActiveView] = useState<'code' | 'preview'>('code');
  const [expanded, setExpanded] = useState(false);
  const { codeChild, codeClassName, language, codeText } = getCodeBlockMetadata(className, children);
  const previewDoc = useMemo(() => buildPreviewDocument(codeText, language), [codeText, language]);
  const canPreview = Boolean(previewDoc);
  const shouldDefaultToPreview = language === 'html' || language === 'svg';
  const shouldDeferIframe = isStreaming && activeView === 'preview' && ['html', 'svg', 'md', 'markdown'].includes(language);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(codeText).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [codeText]);

  useEffect(() => {
    if (!canPreview && activeView === 'preview') {
      setActiveView('code');
    }
  }, [activeView, canPreview]);

  useEffect(() => {
    if (canPreview && shouldDefaultToPreview) {
      setActiveView((view) => (view === 'code' ? 'preview' : view));
    }
  }, [canPreview, shouldDefaultToPreview]);

  const renderedCodeChild = isValidElement(codeChild)
    ? codeChild
    : <code className={codeClassName}>{codeText}</code>;

  return (
    <div className="group my-3 rounded-2xl border border-white/10 bg-[#090F26]/85 shadow-[0_12px_40px_rgba(0,0,0,0.28),inset_0_1px_0_rgba(255,255,255,0.04)]">
      <div className="sticky top-3 z-30 rounded-t-2xl border-b border-white/10 bg-[#0B132F]/95 backdrop-blur-md supports-[backdrop-filter]:bg-[#0B132F]/85">
        <div className="flex items-center justify-between gap-3 px-3 py-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-[10px] uppercase tracking-[0.08em] text-slate-400 font-semibold">{language || 'code'}</span>
            <span className="hidden sm:inline text-[10px] text-slate-500">Compact by default</span>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {canPreview && (
              <button
                onClick={() => setActiveView((view) => (view === 'preview' ? 'code' : 'preview'))}
                className={`inline-flex items-center justify-center h-8 w-8 sm:h-8 sm:w-auto sm:px-2.5 rounded-md border text-[11px] transition-colors ${
                  activeView === 'preview'
                    ? 'bg-blue-500/20 border-blue-400/30 text-blue-200'
                    : 'bg-white/[0.04] border-white/15 text-slate-300 hover:bg-white/[0.08] hover:text-white'
                }`}
                title={activeView === 'preview' ? 'Show code' : 'Show preview'}
                aria-label={activeView === 'preview' ? 'Show code' : 'Show preview'}
              >
                {activeView === 'preview' ? <EyeOff size={12} /> : <Eye size={12} />}
                <span className="hidden sm:inline sm:ml-1">{activeView === 'preview' ? 'Code' : 'Preview'}</span>
              </button>
            )}
            <button
              onClick={() => setExpanded((value) => !value)}
              className={`inline-flex items-center justify-center h-8 w-8 sm:h-8 sm:w-auto sm:px-2.5 rounded-md border text-[11px] transition-colors ${
                expanded
                  ? 'bg-violet-500/20 border-violet-400/30 text-violet-200'
                  : 'bg-white/[0.04] border-white/15 text-slate-300 hover:bg-white/[0.08] hover:text-white'
              }`}
              title={expanded ? 'Collapse block' : 'Expand block'}
              aria-label={expanded ? 'Collapse block' : 'Expand block'}
            >
              {expanded ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
              <span className="hidden sm:inline sm:ml-1">{expanded ? 'Collapse' : 'Expand'}</span>
            </button>
            <button
              onClick={handleCopy}
              className={`inline-flex items-center justify-center h-8 w-8 sm:h-8 sm:w-auto sm:px-2.5 rounded-md border text-[11px] transition-colors ${
                copied
                  ? 'bg-emerald-500/20 border-emerald-400/30 text-emerald-300'
                  : 'bg-white/[0.04] border-white/15 text-slate-300 hover:bg-white/[0.08] hover:text-white'
              }`}
              title={copied ? 'Copied' : 'Copy code'}
              aria-label={copied ? 'Copied' : 'Copy code'}
            >
              {copied ? <Check size={12} /> : <Copy size={12} />}
              <span className="hidden sm:inline sm:ml-1">{copied ? 'Copied' : 'Copy'}</span>
            </button>
          </div>
        </div>
      </div>

      <div className="overflow-hidden rounded-b-2xl">
        {activeView === 'preview' && previewDoc ? (
          <div className="bg-[#050816]">
            <div className="flex items-center justify-between px-4 py-2 text-[11px] text-slate-400 border-b border-white/10 bg-gradient-to-r from-blue-500/10 via-cyan-500/5 to-transparent">
              <span>{expanded ? 'Expanded preview' : 'Inline preview'}</span>
              <span className="text-slate-500">Sandboxed render</span>
            </div>
            {shouldDeferIframe ? (
              <div className={`flex items-center justify-center px-4 text-xs text-slate-400 bg-[#0A112B] ${expanded ? 'h-[75vh] min-h-[36rem]' : 'h-[24rem]'}`}>
                Preview will be available when the response completes.
              </div>
            ) : (
              <iframe
                title={`${language || 'code'} preview`}
                sandbox="allow-scripts"
                srcDoc={previewDoc}
                className={`w-full transition-[height] duration-200 ${expanded ? 'h-[75vh] min-h-[36rem]' : 'h-[24rem]'}`}
                style={{ background: 'transparent' }}
              />
            )}
          </div>
        ) : (
          <div className={expanded ? 'max-h-none overflow-visible' : 'max-h-[11rem] overflow-hidden'}>
            <pre className="relative m-0 overflow-x-auto bg-[#090F26] p-4 text-[12px] leading-relaxed" {...props}>
              {!expanded && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-[#090F26] to-transparent z-10" />}
              {renderedCodeChild}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── Component overrides ─────────────────────────────────────────────── */

const components = {
  code({ className, children, ...props }: any) {
    const isInline = !className;
    if (isInline) {
      return (
        <code
          className="text-emerald-300 bg-white/[0.06] px-1.5 py-0.5 rounded text-xs font-mono"
          {...props}
        >
          {children}
        </code>
      );
    }
    return (
      <code className={`${className || ''} font-mono`} {...props}>
        {children}
      </code>
    );
  },
  table({ children, ...props }: any) {
    return (
      <div className="overflow-x-auto my-2 rounded-lg border border-white/[0.06]">
        <table className="w-full text-sm" {...props}>
          {children}
        </table>
      </div>
    );
  },
  thead({ children, ...props }: any) {
    return (
      <thead className="bg-white/[0.04] border-b border-white/[0.06]" {...props}>
        {children}
      </thead>
    );
  },
  th({ children, ...props }: any) {
    return (
      <th className="text-left px-3 py-2 text-xs font-semibold text-slate-300" {...props}>
        {children}
      </th>
    );
  },
  td({ children, ...props }: any) {
    return (
      <td className="px-3 py-2 text-xs text-slate-400 border-t border-white/[0.04]" {...props}>
        {children}
      </td>
    );
  },
  a({ href, children, ...props }: any) {
    const resolved = resolvePortalHref(href);
    return (
      <a
        href={resolved.href}
        target={resolved.external ? '_blank' : undefined}
        rel={resolved.external ? 'noopener noreferrer' : undefined}
        className="text-emerald-400 hover:text-emerald-300 underline underline-offset-2 decoration-emerald-400/30 hover:decoration-emerald-400/60 transition-colors"
        {...props}
      >
        {children}
      </a>
    );
  },
  blockquote({ children, ...props }: any) {
    return (
      <blockquote
        className="border-l-2 border-violet-500/40 pl-3 my-2 text-slate-400 italic"
        {...props}
      >
        {children}
      </blockquote>
    );
  },
  ul({ children, ...props }: any) {
    return <ul className="list-disc list-inside space-y-0.5 my-1" {...props}>{children}</ul>;
  },
  ol({ children, ...props }: any) {
    return <ol className="list-decimal list-inside space-y-0.5 my-1" {...props}>{children}</ol>;
  },
  li({ children, ...props }: any) {
    return <li className="text-slate-200" {...props}>{children}</li>;
  },
  h1({ children, ...props }: any) {
    return <h1 className="text-lg font-bold text-white mt-3 mb-1" {...props}>{children}</h1>;
  },
  h2({ children, ...props }: any) {
    return <h2 className="text-base font-bold text-white mt-3 mb-1" {...props}>{children}</h2>;
  },
  h3({ children, ...props }: any) {
    return <h3 className="text-sm font-bold text-white mt-2 mb-1" {...props}>{children}</h3>;
  },
  p({ children, ...props }: any) {
    return <p className="my-1 leading-relaxed" {...props}>{children}</p>;
  },
  hr(props: any) {
    return <hr className="border-white/[0.06] my-3" {...props} />;
  },
};

/* ─── Main component ──────────────────────────────────────────────────── */

interface MarkdownRendererProps {
  content: string;
  className?: string;
  isStreaming?: boolean;
}

function closeUnclosedBacktickFence(content: string, isStreaming: boolean): string {
  if (!isStreaming) return content;
  const fenceCount = (content.match(/```/g) || []).length;
  if (fenceCount % 2 === 0) return content;
  return `${content}\n\`\`\``;
}

function splitTrailingPunctuation(raw: string): { core: string; trailing: string } {
  const match = raw.match(/^(.*?)([.,!?;:]+)?$/);
  return {
    core: match?.[1] || raw,
    trailing: match?.[2] || '',
  };
}

function buildPortalLinkNode(url: string, label: string) {
  return {
    type: 'link',
    url,
    title: null,
    children: [{ type: 'text', value: label }],
  };
}

function parsePortalTextToNodes(text: string): any[] | null {
  const pattern = /(Shared Browser|Files section|file section|\/api\/files\/[^\s?#)]+|\/files\?(?:file|path)=[^\s)]+|https?:\/\/[^\s)]+\/files\?(?:file|path)=[^\s)]+|\/?var\/portal-files\/[^\s)]+|\/?(?:root\/)?\.openclaw\/media\/portal-files\/[^\s)]+|~\/?\.openclaw\/media\/portal-files\/[^\s)]+)/gi;
  let match: RegExpExecArray | null;
  let lastIndex = 0;
  const nodes: any[] = [];

  while ((match = pattern.exec(text)) !== null) {
    const raw = match[0];
    const start = match.index;
    const end = start + raw.length;

    if (start > lastIndex) {
      nodes.push({ type: 'text', value: text.slice(lastIndex, start) });
    }

    const lower = raw.toLowerCase();
    if (lower === 'shared browser') {
      nodes.push(buildPortalLinkNode('/desktop', raw));
      lastIndex = end;
      continue;
    }

    if (lower === 'files section' || lower === 'file section') {
      nodes.push(buildPortalLinkNode('/files', raw));
      lastIndex = end;
      continue;
    }

    const { core, trailing } = splitTrailingPunctuation(raw);
    if (/^\/api\/files\//i.test(core)) {
      const fileId = core.replace(/^\/api\/files\//i, '').trim();
      if (fileId) {
        nodes.push(buildPortalLinkNode(`/files?file=${encodeURIComponent(fileId)}`, core));
      } else {
        nodes.push({ type: 'text', value: core });
      }
    } else if (/^\/files\?(?:file|path)=/i.test(core)) {
      nodes.push(buildPortalLinkNode(core, core));
    } else if (/^https?:\/\/[^/]+\/files\?(?:file|path)=/i.test(core)) {
      const resolved = resolvePortalHref(core);
      nodes.push(buildPortalLinkNode(resolved.href, core));
    } else {
      const normalizedPath = core.startsWith('/') ? core : `/${core}`;
      nodes.push(buildPortalLinkNode(`/files?path=${encodeURIComponent(normalizedPath)}`, core));
    }
    if (trailing) nodes.push({ type: 'text', value: trailing });
    lastIndex = end;
  }

  if (lastIndex === 0) return null;
  if (lastIndex < text.length) {
    nodes.push({ type: 'text', value: text.slice(lastIndex) });
  }
  return nodes;
}

function remarkPortalLinks() {
  return (tree: any) => {
    const visit = (node: any) => {
      if (!node || !Array.isArray(node.children)) return;
      for (let i = 0; i < node.children.length; i += 1) {
        const child = node.children[i];
        if (!child) continue;
        if (child.type === 'text') {
          const replacement = parsePortalTextToNodes(String(child.value || ''));
          if (replacement && replacement.length > 0) {
            node.children.splice(i, 1, ...replacement);
            i += replacement.length - 1;
          }
          continue;
        }
        if (['code', 'inlineCode', 'link', 'definition', 'image', 'imageReference', 'linkReference', 'html'].includes(child.type)) {
          continue;
        }
        visit(child);
      }
    };

    visit(tree);
  };
}

/** Memoized markdown renderer - prevents re-parsing identical content */
/**
 * Detect if content is a raw HTML document without markdown code fences.
 * Agents sometimes respond with bare HTML — wrap it in fences so the
 * PreviewableCodeBlock can render it with a sandboxed preview.
 */
function wrapBareHtmlInFences(text: string): string {
  const trimmed = text.trim();
  // Already has code fences — leave it alone
  if (trimmed.includes('```')) return text;
  // Check if it looks like a complete HTML document
  const looksLikeHtml = /^\s*<!doctype\s+html/i.test(trimmed) || /^\s*<html[\s>]/i.test(trimmed);
  if (looksLikeHtml) {
    return '```html\n' + trimmed + '\n```';
  }
  return text;
}

const MarkdownRenderer = memo(function MarkdownRenderer({ content, className, isStreaming = false }: MarkdownRendererProps) {
  const renderContent = useMemo(
    () => closeUnclosedBacktickFence(wrapBareHtmlInFences(content), isStreaming),
    [content, isStreaming]
  );

  const markdownComponents = useMemo(() => ({
    ...components,
    pre: ({ children, ...props }: any) => {
      const childArray = Children.toArray(children);
      const codeChild = childArray.find((child) => isValidElement(child)) as any;
      const className = codeChild?.props?.className;
      return (
        <PreviewableCodeBlock className={className} isStreaming={isStreaming} {...props}>
          {children}
        </PreviewableCodeBlock>
      );
    },
  }), [isStreaming]);

  return (
    <div className={`text-sm text-slate-200 leading-relaxed ${className || ''}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkPortalLinks]}
        rehypePlugins={[rehypeHighlight]}
        components={markdownComponents}
      >
        {renderContent}
      </ReactMarkdown>
    </div>
  );
});

export default MarkdownRenderer;
