import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import postcss, { type Root, type Rule } from 'postcss';
import tailwind from '@tailwindcss/postcss';
import { beforeAll, describe, expect, it } from 'vitest';

let compiled: Root;
beforeAll(async () => {
  const entry = fileURLToPath(new URL('../index.css', import.meta.url));
  compiled = (await postcss([tailwind()]).process(readFileSync(entry, 'utf8'), { from: entry })).root;
}, 30_000);

function declarations(selector: string, property: string): string[] {
  const values: string[] = [];
  compiled.walkRules(selector, (rule) => {
    rule.walkDecls(property, (decl) => { values.push(decl.value); });
  });
  return values;
}

describe('shipping Tailwind 4 compatibility output', () => {
  it('emits the existing palette concretely for semantic contrast consumers', () => {
    expect(declarations('.bg-emerald-400', 'background-color')).toContain('#34d399');
    expect(declarations('.text-slate-950', 'color')).toContain('#020617');
    expect(declarations('.bg-theme-surface-raised', 'background-color')).toContain('var(--color-surface-raised)');
    expect(declarations('.text-theme-text', 'color')).toContain('var(--color-text)');
  });

  it('keeps utility rules outside layers so element resets cannot override them', () => {
    let utility: Rule | undefined;
    compiled.walkRules('.p-4', (rule) => { utility = rule; });
    expect(utility).toBeDefined();
    expect(utility!.parent?.type).toBe('root');
    expect(declarations('.flex-shrink-0', 'flex-shrink')).toContain('0');
    expect(declarations('.flex-grow', 'flex-grow')).toContain('1');
  });

  it('retains the old small radius and blur scales instead of accepting renamed defaults', () => {
    expect(declarations('.rounded-sm', 'border-radius')).toContain('0.125rem');
    expect(declarations('.blur-sm', '--tw-blur')).toContain('blur(4px)');
    expect(declarations('.backdrop-blur-sm', '--tw-backdrop-blur')).toContain('blur(4px)');
  });

  it('preserves spacing and divider ownership across hidden form children', () => {
    expect(declarations('.space-y-4 > :not([hidden]) ~ :not([hidden])', 'margin-top'))
      .toContain('calc(1rem * calc(1 - var(--tw-space-y-reverse)))');
    expect(declarations('.divide-y > :not([hidden]) ~ :not([hidden])', 'border-top-width'))
      .toContain('calc(1px * calc(1 - var(--tw-divide-y-reverse)))');
    expect(declarations('.space-y-4', 'margin-block-end')).toEqual([]);
  });

  it('keeps a transparent focus outline after the built-in outline-none rule', () => {
    const outlines: string[] = [];
    compiled.walkRules((rule) => {
      if (!rule.selector.split(/,\s*/).includes('.outline-none')) return;
      rule.walkDecls(/outline(?:-style)?$/, (decl) => { outlines.push(decl.value); });
    });
    expect(outlines[outlines.length - 1]).toBe('2px solid transparent');
  });
});
