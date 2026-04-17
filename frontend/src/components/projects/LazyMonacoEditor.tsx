import Editor from '@monaco-editor/react';
import type { editor } from 'monaco-editor';

export default function LazyMonacoEditor(props: {
  height: string;
  language?: string;
  value: string;
  onChange: (value: string | undefined) => void;
  theme?: string;
  options?: editor.IStandaloneEditorConstructionOptions;
}) {
  return <Editor {...props} />;
}
