// @vitest-environment jsdom
import '../../../test/setup';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ToolCard, ToolCardBoundary } from './ToolCard';
import type { ToolCardInput } from './toolCardModel';

function input(overrides: Partial<ToolCardInput>): ToolCardInput {
  return { id: 'call_1', name: 'exec', status: 'done', startedAt: 1_000, endedAt: 1_400, ...overrides };
}

function expand(container: HTMLElement) {
  const button = container.querySelector('button[aria-expanded]');
  expect(button).not.toBeNull();
  fireEvent.click(button as HTMLElement);
  return button as HTMLElement;
}

function eventHandlerAttributes(container: HTMLElement): string[] {
  const found: string[] = [];
  container.querySelectorAll('*').forEach((element) => {
    for (const attribute of Array.from(element.attributes)) {
      if (/^on/i.test(attribute.name)) found.push(`${element.tagName}.${attribute.name}`);
    }
  });
  return found;
}

describe('ToolCard', () => {
  it('renders hostile names, arguments and results as inert text', () => {
    const { container } = render(
      <ToolCard
        tool={input({
          name: '<img src=x onerror=alert(1)>',
          arguments: { command: '<script>alert(1)</script>', note: '<svg onload=alert(1)>' },
          result: '<iframe src="javascript:alert(1)"></iframe><img src=x onerror=alert(2)>',
        })}
      />,
    );
    expand(container);
    expect(container.querySelector('script, iframe, img, object, embed')).toBeNull();
    expect(eventHandlerAttributes(container)).toEqual([]);
    expect(container.textContent).toContain('<iframe src="javascript:alert(1)"></iframe>');
    expect(container.textContent).toContain('<svg onload=alert(1)>');
  });

  it('links only http(s) URLs, opened safely', () => {
    const { container, unmount } = render(<ToolCard tool={input({ name: 'web_fetch', arguments: { url: 'javascript:alert(1)' } })} />);
    expand(container);
    expect(container.querySelectorAll('a')).toHaveLength(0);
    expect(container.textContent).toContain('javascript:alert(1)');
    unmount();

    const safe = render(<ToolCard tool={input({ name: 'web_fetch', arguments: { url: 'https://docs.example/page' } })} />);
    expand(safe.container);
    const anchor = safe.container.querySelector('a');
    expect(anchor?.getAttribute('href')).toBe('https://docs.example/page');
    expect(anchor?.getAttribute('target')).toBe('_blank');
    expect(anchor?.getAttribute('rel')).toContain('noopener');
    expect(anchor?.getAttribute('rel')).toContain('noreferrer');
  });

  it('names unknown tools and keeps the raw name on the card', () => {
    const { container } = render(<ToolCard tool={input({ name: 'mcp__acme__frobnicate', arguments: { target: 'x' } })} />);
    expect(screen.getByRole('button', { name: /Frobnicate/ })).toBeInTheDocument();
    expand(container);
    expect(container.textContent).toContain('mcp__acme__frobnicate');
    expect(container.textContent).not.toMatch(/^Tool$/m);
  });

  it('keeps the tool call id and shows verbatim running and failed states', () => {
    const running = render(<ToolCard tool={input({ id: 'toolu_42', status: 'running', endedAt: undefined, arguments: { command: 'sleep 5' } })} />);
    expect(running.container.querySelector('[data-tool-call-id="toolu_42"]')).not.toBeNull();
    expect(screen.getByLabelText('Running')).toBeInTheDocument();
    running.unmount();

    const failed = render(<ToolCard tool={input({ status: 'error', arguments: { command: 'false' }, result: 'boom' })} />);
    expect(failed.container.textContent).toContain('Failed');
    const button = expand(failed.container);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(failed.container.textContent).toContain('boom');
  });

  it('nests parallel calls under the parent card', () => {
    const { container } = render(
      <ToolCard
        tool={input({
          name: 'multi_tool_use.parallel',
          arguments: { tool_uses: [{ recipient_name: 'functions.exec', parameters: { command: 'pwd' } }, { recipient_name: 'functions.mystery' }] },
        })}
      />,
    );
    expand(container);
    expect(container.querySelectorAll('[data-tool-card-kind="shell"]')).toHaveLength(1);
    expect(container.textContent).toContain('Run pwd');
    expect(container.textContent).toContain('Mystery');
  });

  it('falls back to a name-only pill when a card fails to render', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // jsdom reports the (expected) render error as an uncaught window error.
    const silence = (event: ErrorEvent) => event.preventDefault();
    window.addEventListener('error', silence);
    function Broken(): React.JSX.Element {
      throw new Error('render failure');
    }
    const { container } = render(
      <ToolCardBoundary tool={{ id: 'b1', name: 'weird_tool', status: 'done' }}>
        <Broken />
      </ToolCardBoundary>,
    );
    expect(container.querySelector('[data-tool-card-kind="fallback"]')).not.toBeNull();
    expect(container.textContent).toContain('Weird tool');
    expect(container.textContent).toContain('weird_tool');
    window.removeEventListener('error', silence);
  });
});
