/**
 * Render model for one tool call. Builders in toolCardRegistry.ts produce it
 * from the existing ToolCall payload; ToolCard.tsx renders it. Every string in
 * a model has already passed through safeDisplay (redacted and bounded).
 */

export type ToolCardKind =
  | 'shell'
  | 'code'
  | 'process'
  | 'read'
  | 'write'
  | 'edit'
  | 'patch'
  | 'search'
  | 'web'
  | 'browser'
  | 'progress'
  | 'goal'
  | 'session'
  | 'media'
  | 'question'
  | 'parallel'
  | 'generic';

/** Verbatim ToolCall status; cards never derive a different lifecycle. */
export type ToolCardStatus = 'running' | 'done' | 'error';

/** How the arguments arrived: absent, structured, free text, still streaming, or unusable. */
export type ToolCardArgsState = 'none' | 'object' | 'text' | 'partial' | 'malformed';

export type ToolCardTone = 'neutral' | 'info' | 'good' | 'warn' | 'bad';

export interface ToolCardChip {
  label: string;
  tone: ToolCardTone;
}

export interface ToolCardField {
  label: string;
  value: string;
  redacted?: boolean;
  mono?: boolean;
}

export type ToolCardStepStatus = 'pending' | 'in_progress' | 'completed' | 'unknown';

export type ToolCardDiffLineKind = 'add' | 'del' | 'ctx' | 'meta';

export interface ToolCardLink {
  title: string;
  /** http(s) only; null renders the label as plain text. */
  href: string | null;
  host: string | null;
  snippet?: string;
}

export interface ToolCardNestedRef {
  name: string;
  namespace: string | null;
  count: number;
}

export type ToolCardSection =
  | { type: 'code'; label: string; text: string; truncated: boolean }
  | { type: 'text'; label: string; text: string; truncated: boolean }
  | { type: 'fields'; label?: string; rows: ToolCardField[]; truncated: boolean }
  | { type: 'diff'; label: string; lines: Array<{ kind: ToolCardDiffLineKind; text: string }>; truncated: boolean }
  | { type: 'steps'; label: string; steps: Array<{ text: string; status: ToolCardStepStatus }>; truncated: boolean }
  | { type: 'links'; label: string; items: ToolCardLink[]; truncated: boolean }
  | { type: 'refs'; label: string; items: ToolCardNestedRef[]; truncated: boolean }
  | { type: 'nested'; label: string; cards: ToolCardModel[]; truncated: boolean };

export interface ToolCardModel {
  /** ToolCall.id verbatim (the upstream toolCallId when one was provided). */
  id: string;
  /** Exact upstream tool name, display-bounded. Always shown somewhere on the card. */
  rawName: string;
  canonicalName: string;
  /** Human name for the tool; never empty. */
  displayName: string;
  namespace: string | null;
  kind: ToolCardKind;
  brand?: 'bridgesllm';
  status: ToolCardStatus;
  argsState: ToolCardArgsState;
  /** One line describing the call, e.g. "Run git status". */
  title: string;
  subtitle: string | null;
  chips: ToolCardChip[];
  sections: ToolCardSection[];
  durationMs: number | null;
}

/** The ToolCall fields the registry reads. Extra fields are ignored. */
export interface ToolCardInput {
  id: string;
  name: string;
  status: ToolCardStatus;
  arguments?: unknown;
  result?: string;
  startedAt?: number;
  endedAt?: number;
}
