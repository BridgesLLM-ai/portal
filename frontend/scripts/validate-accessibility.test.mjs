import { describe, expect, it } from 'vitest';
import { analyzeSource } from './validate-accessibility.mjs';

describe('accessibility source gate', () => {
  it('rejects icon-only controls and placeholder-only fields', () => {
    const diagnostics = analyzeSource(`
      export function Broken() {
        return <><button><TrashIcon /></button><input placeholder="Search" /></>;
      }
    `);

    expect(diagnostics.map((issue) => issue.kind)).toEqual(['control-name', 'form-label']);
  });

  it('accepts explicit names, associated labels, and visible control text', () => {
    const diagnostics = analyzeSource(`
      export function Sound() {
        return <>
          <button aria-label="Delete"><TrashIcon /></button>
          <button>Save changes</button>
          <label htmlFor="query">Search</label>
          <input id="query" placeholder="Search" />
          <label>Notes<textarea /></label>
        </>;
      }
    `);

    expect(diagnostics).toEqual([]);
  });

  it('rejects icon-only conditional expressions while accepting text labels', () => {
    const diagnostics = analyzeSource(`
      export function Conditional({ ready }) {
        return <>
          <button>{ready ? <CheckIcon /> : <ClockIcon />}</button>
          <button>{ready ? 'Ready' : 'Waiting'}</button>
        </>;
      }
    `);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].kind).toBe('control-name');
  });
});
