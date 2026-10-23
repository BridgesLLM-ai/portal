import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker?worker';
import CssWorker from 'monaco-editor/language/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/language/html/html.worker?worker';
import TypeScriptWorker from 'monaco-editor/language/typescript/ts.worker?worker';

// Use the installed, version-matched runtime and Vite-emitted same-origin assets.
// Configuring the wrapper with this instance prevents its default CDN AMD loader.
self.MonacoEnvironment = {
  getWorker(_moduleId, label) {
    switch (label) {
      case 'json': return new JsonWorker();
      case 'css':
      case 'scss':
      case 'less': return new CssWorker();
      case 'html':
      case 'handlebars':
      case 'razor': return new HtmlWorker();
      case 'typescript':
      case 'javascript': return new TypeScriptWorker();
      default: return new EditorWorker();
    }
  },
};
loader.config({ monaco });
