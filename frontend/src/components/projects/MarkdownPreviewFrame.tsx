import { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

export default function MarkdownPreviewFrame({ language, content }: { language: string; content: string }) {
  const srcDoc = useMemo(() => {
    if (language === 'html') return content;

    if (language === 'markdown') {
      marked.setOptions({ gfm: true, breaks: true });
      const rawHtml = marked.parse(content) as string;
      const safeHtml = DOMPurify.sanitize(rawHtml);
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
      color: #e2e8f0;
      background: #0a0a0a;
      padding: 3rem;
      max-width: 56rem;
      margin: 0 auto;
    }
    h1, h2, h3, h4, h5, h6 { font-weight: 700; color: #fff; margin-top: 2rem; margin-bottom: 1rem; }
    h1 { font-size: 2.25rem; border-bottom: 2px solid rgba(255,255,255,0.1); padding-bottom: 0.5rem; }
    h2 { font-size: 1.875rem; border-bottom: 1px solid rgba(255,255,255,0.05); padding-bottom: 0.5rem; margin-top: 3rem; }
    h3 { font-size: 1.5rem; margin-top: 2rem; }
    h4 { font-size: 1.25rem; }
    h5 { font-size: 1.125rem; }
    h6 { font-size: 1rem; }
    p { margin-bottom: 1rem; color: #cbd5e1; }
    a { color: #60a5fa; text-decoration: none; }
    a:hover { text-decoration: underline; }
    strong { font-weight: 600; color: #fff; }
    em { font-style: italic; }
    code {
      background: rgba(255,255,255,0.05);
      color: #34d399;
      padding: 0.125rem 0.375rem;
      border-radius: 0.25rem;
      font-family: 'Courier New', monospace;
      font-size: 0.875em;
    }
    pre {
      background: #0d1117;
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 0.5rem;
      padding: 1rem;
      overflow-x: auto;
      margin: 1rem 0;
    }
    pre code { background: none; padding: 0; color: #c9d1d9; }
    blockquote {
      border-left: 4px solid #34d399;
      padding-left: 1rem;
      margin: 1.5rem 0;
      color: #94a3b8;
      font-style: italic;
    }
    ul, ol { margin: 1rem 0 1rem 2rem; color: #cbd5e1; }
    li { margin-bottom: 0.5rem; }
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 1.5rem 0;
      background: rgba(255,255,255,0.02);
      border-radius: 0.5rem;
      overflow: hidden;
    }
    th, td {
      padding: 0.75rem 1rem;
      text-align: left;
      border-bottom: 1px solid rgba(255,255,255,0.05);
    }
    th { background: rgba(255,255,255,0.05); font-weight: 600; color: #fff; }
    hr { border: none; border-top: 1px solid rgba(255,255,255,0.1); margin: 2rem 0; }
    img { max-width: 100%; height: auto; border-radius: 0.5rem; margin: 1rem 0; }
  </style>
</head>
<body>${safeHtml}</body>
</html>`;
    }

    return content;
  }, [language, content]);

  return <iframe srcDoc={srcDoc} className="w-full h-full border-0" sandbox="allow-same-origin" title="Preview" />;
}
