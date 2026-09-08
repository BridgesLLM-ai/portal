declare module 'js-yaml' {
  export interface LoadOptions {
    schema?: unknown;
    json?: boolean;
    maxAliasCount?: number;
  }

  export interface DumpOptions {
    schema?: unknown;
    noRefs?: boolean;
    noCompatMode?: boolean;
    sortKeys?: boolean;
    lineWidth?: number;
  }

  export const JSON_SCHEMA: unknown;
  export function load(source: string, options?: LoadOptions): unknown;
  export function dump(value: unknown, options?: DumpOptions): string;
}
