// @vitest-environment jsdom
import '../../test/setup';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AssistantBubble } from './ChatInterface';
import { ChatCanvasColumn } from './chatCanvas';
import { ToolActivityScope, resetToolActivityChoices } from './toolActivity/toolActivityDisclosure';
import type { ChatMessage, ToolCall } from '../../contexts/ChatStateProvider';

vi.mock('./MarkdownRenderer', () => ({ default: ({ content }: { content: string }) => <span>{content}</span> }));
vi.mock('./richContent/ChatWidgetCard', () => ({
  ChatWidgetCard: ({ tool }: { tool: ToolCall }) => <div data-testid="widget-card">{tool.id}</div>,
}));

const agent = { name: 'OpenClaw', initials: 'OC', providerName: 'OPENCLAW', color: '', bgLight: '', borderColor: '', avatarBg: '', avatarText: '', accentRing: '', sendBg: '', sendHover: '', sendShadow: '', provenance: 'verified' } as any;
const widget: ToolCall = { id: 'widget-1', name: 'show_widget', status: 'done', arguments: { title: 'Timer' }, result: 'shown', startedAt: 1000, endedAt: 1001, order: 1 };
const message: ChatMessage = { id: 'canvas-1', role: 'assistant', content: 'Here is the timer.', createdAt: new Date(1000), toolCalls: [widget] };

beforeEach(() => { resetToolActivityChoices(); vi.spyOn(window, 'scrollTo').mockImplementation(() => {}); });

function chatCanvasCss(): string {
  // Vitest does not load CSS; read the stylesheet source itself.
  const css = readFileSync(join(process.cwd(), 'src/index.css'), 'utf8');
  const start = css.indexOf('/* Chat working canvas');
  expect(start).toBeGreaterThan(-1);
  return css.slice(start);
}

describe('chat working canvas', () => {
  it('widens transcript rows and lets the reply column use them', () => {
    const view = render(<ToolActivityScope scope="agent:OPENCLAW:canvas"><AssistantBubble agent={agent} message={message} isLast isStreaming={false} /></ToolActivityScope>);
    const row = view.container.firstElementChild as HTMLElement;
    expect(row.className).toContain('max-w-[88rem]');
    expect(row.className).not.toContain('max-w-3xl');
    expect(view.container.querySelector('[class*="max-w-[80%]"]')).toBeNull();
    expect(screen.getByText('Here is the timer.')).toBeInTheDocument();
  });

  it('keeps a widget card in the tool-card column instead of full-bleed', () => {
    render(<ToolActivityScope scope="agent:OPENCLAW:canvas"><AssistantBubble agent={agent} message={message} isLast isStreaming={false} /></ToolActivityScope>);
    const column = screen.getByTestId('widget-card').closest('[data-chat-canvas-column]');
    expect(column).not.toBeNull();
    expect(column?.firstElementChild?.className).toContain('max-w-[80rem]');
    expect(column?.firstElementChild?.className).toContain('min-w-0');
  });

  it('wraps any child in the same centred column', () => {
    render(<ChatCanvasColumn><p>card</p></ChatCanvasColumn>);
    const column = screen.getByText('card').closest('[data-chat-canvas-column]') as HTMLElement;
    expect(column.className).toContain('justify-center');
  });

  it('keeps an 80ch prose measure, theme-coloured focus outlines and a reduced-motion rule', () => {
    const rules = chatCanvasCss();
    expect(rules).toMatch(/\.chat-markdown > :is\(p, ul, ol, blockquote, h1, h2, h3, h4, h5, h6\) \{\s*max-width: 80ch;/);
    expect(rules).toMatch(/\.chat-canvas [^{]*:focus-visible \{\s*outline: 2px solid var\(--accent-light, currentColor\);/);
    expect(rules).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.chat-canvas \*,/);
    expect(rules).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
  });
});
