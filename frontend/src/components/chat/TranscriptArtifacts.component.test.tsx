// @vitest-environment jsdom
import '../../test/setup';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MarkdownRenderer from './MarkdownRenderer';
import { AssistantJson } from './TranscriptArtifacts';
import { JSON_TREE_LIMITS } from './jsonPresentation';
import { useAuthStore } from '../../contexts/AuthContext';

const copy = vi.fn();
beforeEach(() => {
  copy.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } });
});
const mount = (content: string, props = {}) => render(<MemoryRouter><MarkdownRenderer content={content} {...props} /></MemoryRouter>);
function Route() { const location = useLocation(); return <output data-testid="route">{location.pathname}{location.search}</output>; }

describe('assistant JSON interaction boundary', () => {
  it('copies the original standalone source and shows both duplicate entries and exact large numbers', async () => {
    const raw = ' \r\n{"a":900719925474099312345,"a":"\\u0041\\n"}  \n';
    mount(raw, { assistantArtifacts: true });
    expect(screen.getByRole('region', { name: 'JSON tree' })).toHaveTextContent('900719925474099312345');
    expect(screen.getByText('"a" (duplicate key, occurrence 2):')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Copy original JSON' }));
    await waitFor(() => expect(copy).toHaveBeenCalledWith(raw));
    fireEvent.click(screen.getByRole('button', { name: 'Raw' }));
    expect(screen.getByRole('region', { name: 'Original JSON' }).querySelector('pre')?.textContent).toBe(raw);
  });
  it('copies exact mixed fenced source rather than highlighted/reconstructed Markdown', async () => {
    const raw = '{"x":900719925474099300001,"x":"\\u0041"}  \n';
    mount('Intro\n\n```json\n' + raw + '```\n\nDone', { assistantArtifacts: true });
    fireEvent.click(screen.getByRole('button', { name: 'Copy original JSON' }));
    await waitFor(() => expect(copy).toHaveBeenCalledWith(raw));
    expect(screen.getByText('Intro')).toBeInTheDocument();
    expect(screen.getByText('Done')).toBeInTheDocument();
  });
  it.each([false, undefined])('does not grant structured artifacts to user/tool/unclassified content (%j)', (assistantArtifacts) => {
    mount('```json\n{"x":1}\n```', { assistantArtifacts });
    expect(screen.queryByRole('region', { name: 'Assistant JSON' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Tree' })).not.toBeInTheDocument();
  });
  it('does not interpret an assistant Markdown link as JSON', () => {
    mount('[Files section](/files)', { assistantArtifacts: true });
    expect(screen.getByRole('link', { name: 'Files section' })).toHaveAttribute('href', '/files');
    expect(screen.queryByRole('button', { name: 'Tree' })).not.toBeInTheDocument();
  });
  it('keeps complete-looking streaming JSON raw until final, then exposes a tree', () => {
    const { rerender } = render(<AssistantJson raw='{"x":1}' isStreaming />);
    expect(screen.getByRole('button', { name: 'Tree' })).toBeDisabled();
    expect(screen.getByRole('region', { name: 'Original JSON' })).toBeInTheDocument();
    rerender(<AssistantJson raw='{"x":1}' />);
    expect(screen.getByRole('region', { name: 'JSON tree' })).toBeInTheDocument();
  });
  it.each([
    ['incomplete', '{"x":'],
    ['oversized', ' '.repeat(JSON_TREE_LIMITS.characters) + '{}'],
    ['overdeep', '['.repeat(18) + '0' + ']'.repeat(18)],
  ])('preserves %s JSON as exact raw', async (_label, raw) => {
    render(<AssistantJson raw={raw} />);
    expect(screen.getByRole('button', { name: 'Tree' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Copy original JSON' }));
    await waitFor(() => expect(copy).toHaveBeenCalledWith(raw));
  });
  it.each(['null', 'true', '900719925474099312345', '"escaped\\u0041"', '[1,]'])('renders standalone JSON scalar or unsupported container %s', (raw) => {
    mount(raw, { assistantArtifacts: true });
    expect(screen.getByRole('button', { name: 'Copy original JSON' })).toBeInTheDocument();
  });
  it.each([
    '[1] First point\n[2] Second point',
    '- first item\n- second item',
    '2 things changed.',
    '"Quoted" opening line.',
  ])('keeps finished prose that only starts like JSON as Markdown %j', (raw) => {
    mount(raw, { assistantArtifacts: true });
    expect(screen.queryByRole('button', { name: 'Copy original JSON' })).not.toBeInTheDocument();
  });
  it('renders hostile JSON strings as text, never HTML', () => {
    const { container } = render(<AssistantJson raw='{"__proto__":"<img src=x onerror=alert(1)>"}' />);
    expect(container.querySelector('img,script,iframe')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
  });
  it('reports clipboard rejection without losing source or raising an unhandled promise', async () => {
    copy.mockRejectedValue(new Error('denied'));
    render(<AssistantJson raw='{"x":1}' />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy original JSON' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Copy failed');
  });
});

describe('Markdown table interactions', () => {
  const content = '| Name | Detail |\n| --- | --- |\n| **Ada** | [workspace](/files) |\n| `x` | &amp; "quoted" |';
  it('copies only exact visible cell text as TSV, with escaping for delimiter/quote cells', async () => {
    mount(content);
    fireEvent.click(screen.getByRole('button', { name: 'Copy table as TSV' }));
    await waitFor(() => expect(copy).toHaveBeenCalledWith('Name\tDetail\nAda\tworkspace\nx\t"& ""quoted"""'));
  });
  it('expands dense content, traps focus, escapes and restores focus to its trigger', async () => {
    const user = userEvent.setup();
    mount(content);
    const trigger = screen.getByRole('button', { name: 'Expand table' });
    await user.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Expanded table' });
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Close expanded table' })).toHaveFocus());
    await user.tab();
    expect(within(dialog).getByRole('region', { name: 'Expanded table content' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(trigger).toHaveFocus());
  });
  it('retains authenticated opaque file-link handling in the expanded table', async () => {
    useAuthStore.setState({ user: { id: 'actor', role: 'OWNER', authorizationVersion: 4 } } as any);
    render(<MemoryRouter initialEntries={['/agent-chats']}><MarkdownRenderer content={'| File |\n| --- |\n| [Open file](/api/files/private-file) |'} /><Route /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'Expand table' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('link', { name: 'Open file' }));
    await waitFor(() => expect(screen.getByTestId('route').textContent).toMatch(/^\/files\?open=[a-f0-9]{32}$/));
    expect(screen.getByTestId('route').textContent).not.toContain('private-file');
    useAuthStore.setState({ user: null });
  });
  it('keeps hostile table markup inert in both views', () => {
    const { container } = mount('| Value |\n| --- |\n| <script>alert(1)</script> |');
    fireEvent.click(screen.getByRole('button', { name: 'Expand table' }));
    expect(container.querySelector('script')).toBeNull();
    expect(screen.getByRole('dialog').querySelector('script')).toBeNull();
  });
});
