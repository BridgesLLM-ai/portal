export type ChatResponseFormat = 'auto' | 'mermaid' | 'widget' | 'code' | 'file';
export const RESPONSE_FORMAT_LABELS: Record<ChatResponseFormat, string> = {
  auto: 'Automatic', mermaid: 'Diagram', widget: 'Interactive widget', code: 'Code Preview', file: 'Downloadable file',
};
