import React, { useRef, useEffect } from 'react';
import { Editor } from '@monaco-editor/react';
import { motion } from 'framer-motion';
import { Loader2 } from 'lucide-react';

interface CodeEditorProps {
  value: string;
  onChange: (value: string | undefined) => void;
  language?: string;
  height?: string;
  theme?: string;
  readOnly?: boolean;
}

export default function CodeEditor({
  value,
  onChange,
  language = 'javascript',
  height = '400px',
  theme = 'vs-dark',
  readOnly = false
}: CodeEditorProps) {
  const editorRef = useRef<any>(null);

  useEffect(() => {
    // Configure Monaco for dark theme
    if (editorRef.current) {
      const monaco = editorRef.current.monaco;
      monaco.editor.defineTheme('portal-dark', {
        base: 'vs-dark',
        inherit: true,
        rules: [
          { token: 'comment', foreground: '6A9955' },
          { token: 'keyword', foreground: '569CD6' },
          { token: 'string', foreground: 'CE9178' },
          { token: 'number', foreground: 'B5CEA8' },
          { token: 'function', foreground: 'DCDCAA' },
        ],
        colors: {
          'editor.background': '#0A0E27',
          'editor.foreground': '#F0F4F8',
          'editorCursor.foreground': '#10B981',
          'editor.selectionBackground': '#10B98120',
          'editorLineNumber.foreground': '#6B7280',
          'editor.lineHighlightBackground': '#1A1F3A20',
          'editorWidget.background': '#1A1F3A',
          'editorWidget.border': '#374151',
          'editorSuggestWidget.background': '#1A1F3A',
          'editorSuggestWidget.selectedBackground': '#10B98120',
        }
      });
      monaco.editor.setTheme('portal-dark');
    }
  }, []);

  const handleEditorDidMount = (editor: any, monaco: any) => {
    editorRef.current = { editor, monaco };
    
    // Configure editor options
    editor.updateOptions({
      fontSize: 14,
      fontFamily: 'Monaspace Neon, Consolas, monospace',
      fontLigatures: true,
      minimap: { enabled: false },
      scrollbar: {
        verticalScrollbarSize: 8,
        horizontalScrollbarSize: 8,
      },
      padding: { top: 16, bottom: 16 },
      bracketPairColorization: { enabled: true },
      guides: { bracketPairs: true },
      suggest: {
        showKeywords: true,
        showSnippets: true,
      },
      wordWrap: 'on',
      lineNumbers: 'on',
      rulers: [80, 120],
    });

    // Set dark theme
    monaco.editor.setTheme('portal-dark');
  };

  return (
    <motion.div 
      className="glass rounded-xl overflow-hidden border border-white/10"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
    >
      <Editor
        height={height}
        language={language}
        value={value}
        onChange={onChange}
        onMount={handleEditorDidMount}
        theme="portal-dark"
        loading={
          <div className="flex items-center justify-center h-full bg-slate-900">
            <div className="flex items-center gap-2 text-emerald-400">
              <Loader2 className="w-5 h-5 animate-spin" />
              <span>Loading editor...</span>
            </div>
          </div>
        }
        options={{
          readOnly,
          automaticLayout: true,
          scrollBeyondLastLine: false,
          smoothScrolling: true,
          cursorBlinking: 'smooth',
          renderValidationDecorations: 'on',
        }}
      />
    </motion.div>
  );
}