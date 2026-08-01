import { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

export default function MarkdownPreviewFrame({ language, content, theme = 'dark' }: { language: string; content: string; theme?: 'dark' | 'light' }) {
  const srcDoc = useMemo(() => {
    if (language === 'html') return content;

    if (language === 'markdown') {
      marked.setOptions({ gfm: true, breaks: true });
      const rawHtml = marked.parse(content) as string;
      const safeHtml = DOMPurify.sanitize(rawHtml);
      const palette = theme === 'light'
        ? {
            page: '#ffffff', text: '#334155', heading: '#172033', muted: '#64748b',
            link: '#1d4ed8', accent: '#047857', border: '#d5deea', raised: '#f2f5f9', code: '#172033',
          }
        : {
            page: '#0a0a0a', text: '#cbd5e1', heading: '#ffffff', muted: '#94a3b8',
            link: '#60a5fa', accent: '#34d399', border: 'rgba(255,255,255,0.1)', raised: '#0d1117', code: '#c9d1d9',
          };
      return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Helvetica', 'Arial', sans-serif;
      line-height: 1.6;
      color: ${palette.text};
      background: ${palette.page};
      padding: 3rem;
      max-width: 56rem;
      margin: 0 auto;
    }
    h1, h2, h3, h4, h5, h6 { font-weight: 700; color: ${palette.heading}; margin-top: 2rem; margin-bottom: 1rem; }
    h1 { font-size: 2.25rem; border-bottom: 2px solid ${palette.border}; padding-bottom: 0.5rem; }
    h2 { font-size: 1.875rem; border-bottom: 1px solid ${palette.border}; padding-bottom: 0.5rem; margin-top: 3rem; }
    h3 { font-size: 1.5rem; margin-top: 2rem; }
    h4 { font-size: 1.25rem; }
    h5 { font-size: 1.125rem; }
    h6 { font-size: 1rem; }
    p { margin-bottom: 1rem; color: ${palette.text}; }
    a { color: ${palette.link}; text-decoration: none; }
    a:hover { text-decoration: underline; }
    strong { font-weight: 600; color: ${palette.heading}; }
    em { font-style: italic; }
    code {
      background: ${palette.raised};
      color: ${palette.accent};
      padding: 0.125rem 0.375rem;
      border-radius: 0.25rem;
      font-family: 'Courier New', monospace;
      font-size: 0.875em;
    }
    pre {
      background: ${palette.raised};
      border: 1px solid ${palette.border};
      border-radius: 0.5rem;
      padding: 1rem;
      overflow-x: auto;
      margin: 1rem 0;
    }
    pre code { background: none; padding: 0; color: ${palette.code}; }
    blockquote {
      border-left: 4px solid ${palette.accent};
      padding-left: 1rem;
      margin: 1.5rem 0;
      color: ${palette.muted};
      font-style: italic;
    }
    ul, ol { margin: 1rem 0 1rem 2rem; color: ${palette.text}; }
    li { margin-bottom: 0.5rem; }
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 1.5rem 0;
      background: ${palette.page};
      border-radius: 0.5rem;
      overflow: hidden;
    }
    th, td {
      padding: 0.75rem 1rem;
      text-align: left;
      border-bottom: 1px solid ${palette.border};
    }
    th { background: ${palette.raised}; font-weight: 600; color: ${palette.heading}; }
    hr { border: none; border-top: 1px solid ${palette.border}; margin: 2rem 0; }
    img { max-width: 100%; height: auto; border-radius: 0.5rem; margin: 1rem 0; }
  </style>
</head>
<body>${safeHtml}</body>
</html>`;
    }

    return content;
  }, [language, content, theme]);

  return <iframe srcDoc={srcDoc} className="w-full h-full border-0" sandbox="allow-same-origin" title="Preview" />;
}
