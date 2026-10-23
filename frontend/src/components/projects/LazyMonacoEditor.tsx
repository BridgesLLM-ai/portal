import Editor from '@monaco-editor/react';
import type { editor } from 'monaco-editor';
import '../../lib/monaco';

export default function LazyMonacoEditor(props: {
  height: string;
  language?: string;
  value: string;
  onChange: (value: string | undefined) => void;
  theme?: string;
  options?: editor.IStandaloneEditorConstructionOptions;
}) {
  // Native EditContext can drop rapid keystrokes while React mirrors the value.
  return <Editor {...props} options={{ editContext: false, ...props.options }} />;
}
