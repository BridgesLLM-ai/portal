// @vitest-environment jsdom
import '../../test/setup';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import MermaidDiagram from './MermaidDiagram';
const mocks = vi.hoisted(() => ({ render: vi.fn(), initialize: vi.fn() }));
vi.mock('mermaid', () => ({ default: mocks }));
describe('Mermaid diagram boundaries', () => {
  it('isolates rendered SVG without scripts, links, foreign objects, or network access', async () => {
    mocks.render.mockResolvedValue({ svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 120"><script>alert(1)</script><foreignObject><div>bad</div></foreignObject><image href="https://invalid.example/private"/><a href="javascript:alert(1)"><text>Diagram label</text></a></svg>' });
    render(<MermaidDiagram source={'flowchart LR\n A --> B'} />);
    const frame = await screen.findByTitle('Mermaid diagram');
    await waitFor(() => expect(frame.getAttribute('srcdoc')).toContain('Diagram label'));
    expect(mocks.initialize).toHaveBeenCalledWith(expect.objectContaining({ htmlLabels: false }));
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.getAttribute('srcdoc')).toContain("default-src 'none'");
    expect(frame.getAttribute('srcdoc')).not.toMatch(/<script|<foreignObject|<image|javascript:|https:\/\/invalid/);
  });
  it('keeps malformed diagram source available and does not throw out the message', async () => {
    mocks.render.mockRejectedValue(new Error('parse error'));
    render(<MermaidDiagram source="not a valid diagram" />);
    expect(await screen.findByText('not a valid diagram')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('could not be rendered');
  });
  it('waits for the completed stream before asking Mermaid to parse', () => {
    mocks.render.mockClear();
    render(<MermaidDiagram source="flowchart" isStreaming />);
    expect(screen.getByRole('status')).toHaveTextContent('being written');
    expect(mocks.render).not.toHaveBeenCalled();
  });
});
