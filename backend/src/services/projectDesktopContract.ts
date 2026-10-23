import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { readProjectTextFile, statProjectRegularFile } from './projectSurfacePolicy';

export const DESKTOP_PROJECT_DESCRIPTOR = 'portal-project.json';
export const DESKTOP_PROJECT_DATA_ENV = 'BRIDGESLLM_APP_DATA';
export const DESKTOP_LANGUAGES = ['typescript', 'rust', 'python', 'cpp'] as const;
export type DesktopProjectLanguage = typeof DESKTOP_LANGUAGES[number];
export type DesktopProjectInterface = 'terminal' | 'gui';

const relativeFile = z.string().min(1).max(240).refine(value => (
  !value.includes('\\') && !/[\x00-\x1f\x7f]/.test(value)
  && !path.posix.isAbsolute(value)
  && value.split('/').every(part => part !== '' && part !== '.' && part !== '..' && !part.startsWith('-'))
), 'Expected a contained relative file path');
const targetName = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$/);
const descriptorSchema = z.object({
  version: z.literal(1),
  target: z.literal('desktop'),
  language: z.enum(DESKTOP_LANGUAGES),
  interface: z.enum(['terminal', 'gui']),
  framework: z.enum(['node', 'electron', 'std', 'egui', 'python', 'tkinter', 'cmake', 'qt']),
  entry: relativeFile.optional(),
  binary: targetName.optional(),
  package: targetName.optional(),
}).strict().superRefine((value, ctx) => {
  const expected = {
    typescript: { terminal: 'node', gui: 'electron' },
    rust: { terminal: 'std', gui: 'egui' },
    python: { terminal: 'python', gui: 'tkinter' },
    cpp: { terminal: 'cmake', gui: 'qt' },
  }[value.language][value.interface];
  if (value.framework !== expected) ctx.addIssue({ code: 'custom', message: `Use ${expected} for this language and interface`, path: ['framework'] });
  const scripted = value.language === 'python' || value.language === 'typescript';
  if (scripted && (!value.entry || value.binary || value.package)) ctx.addIssue({ code: 'custom', message: 'Scripted projects require entry and cannot select a binary/package' });
  if (!scripted && (!value.binary || value.entry)) ctx.addIssue({ code: 'custom', message: 'Compiled projects require an explicit binary target, not an entry script' });
  if (value.language !== 'rust' && value.package) ctx.addIssue({ code: 'custom', message: 'Only Cargo projects select a package' });
  if (value.language === 'python' && value.entry && !value.entry.endsWith('.py')) ctx.addIssue({ code: 'custom', message: 'Python entry must end in .py' });
  if (value.language === 'typescript' && value.entry && !/\.(c?js|mjs)$/.test(value.entry)) ctx.addIssue({ code: 'custom', message: 'TypeScript entry must name compiled JavaScript output' });
});
export type DesktopProjectDescriptor = z.infer<typeof descriptorSchema>;

export class DesktopProjectContractError extends Error {
  readonly code = 'INVALID_DESKTOP_PROJECT';
  constructor(message: string) { super(message); this.name = 'DesktopProjectContractError'; }
}

export function parseDesktopProjectDescriptor(value: unknown): DesktopProjectDescriptor {
  const parsed = descriptorSchema.safeParse(value);
  if (!parsed.success) throw new DesktopProjectContractError(
    `${DESKTOP_PROJECT_DESCRIPTOR}: ${parsed.error.issues.map(issue => issue.message).join('; ')}`,
  );
  return Object.freeze(parsed.data);
}

/** An explicit malformed descriptor fails closed; it never falls through to web hosting. */
export function readDesktopProjectDescriptor(root: string): DesktopProjectDescriptor | null {
  const text = readProjectTextFile(root, DESKTOP_PROJECT_DESCRIPTOR, { optional: true, maxBytes: 16 * 1024 });
  if (text === null) return null;
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new DesktopProjectContractError(`${DESKTOP_PROJECT_DESCRIPTOR} is not valid JSON`); }
  return parseDesktopProjectDescriptor(value);
}

export function validateDesktopProjectSource(root: string, descriptor: DesktopProjectDescriptor): void {
  const required = descriptor.language === 'typescript' ? ['package.json', 'tsconfig.json']
    : descriptor.language === 'rust' ? ['Cargo.toml']
    : descriptor.language === 'cpp' ? ['CMakeLists.txt'] : [descriptor.entry!];
  for (const file of required) {
    if (!statProjectRegularFile(root, file, { optional: true, maxBytes: 1024 * 1024 })) {
      throw new DesktopProjectContractError(`Desktop ${descriptor.language} project requires ${file}`);
    }
  }
}

export function requireDesktopBuiltFile(root: string, relative: string, executable = false): string {
  if (!relativeFile.safeParse(relative).success) throw new DesktopProjectContractError('Build output escaped its deployment');
  const entry = statProjectRegularFile(root, relative, { optional: true });
  if (!entry || (executable && (entry.mode & 0o111) === 0)) {
    throw new DesktopProjectContractError(`Build did not produce ${relative}${executable ? ' as an executable' : ''}`);
  }
  return path.join(root, relative);
}

/** Descriptor-free Cargo imports are Desktop candidates, never static websites.
 * Actual binary selection is resolved by Cargo metadata inside the build sandbox. */
export function hasCargoProject(root: string): boolean {
  return Boolean(statProjectRegularFile(root, 'Cargo.toml', { optional: true, maxBytes: 1024 * 1024 }));
}

export function desktopSourceFileInventory(root: string, extensions: readonly string[], limit = 500): string[] {
  const result: string[] = [];
  const skipped = new Set(['.git', 'node_modules', '.venv', 'target', 'build', 'dist', '.portal', '.portal-build-cache', '.desktop-out']);
  let visited = 0;
  const walk = (directory: string, depth: number) => {
    if (depth > 20) throw new DesktopProjectContractError('Project source nesting exceeds the check limit');
    for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
      if (++visited > 20_000) throw new DesktopProjectContractError('Project source inventory exceeds the check limit');
      if (entry.isSymbolicLink()) throw new DesktopProjectContractError('Linked project source is not supported');
      const relative = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.isDirectory() && !skipped.has(entry.name)) walk(relative, depth + 1);
      else if (entry.isFile() && extensions.some(extension => entry.name.endsWith(extension))) {
        result.push(relative);
        if (result.length > limit) throw new DesktopProjectContractError('Project contains too many source files to check');
      }
    }
  };
  walk('', 0);
  return result.sort();
}
