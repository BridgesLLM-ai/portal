// @vitest-environment jsdom
import '../../test/setup';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SlashCommand } from '../../utils/slashCommands';
import SlashCommandMenu from './SlashCommandMenu';

const commands: SlashCommand[] = [
  { command: '/new', description: 'Start a new session', category: 'Session', executeLocal: true },
  { command: '/model', description: 'Switch model', category: 'Model', argsHint: '<model-id>', executeLocal: true },
  { command: '/status', description: 'Show session status', category: 'Debug', executeLocal: true },
];

const originalInnerWidth = window.innerWidth;
const originalInnerHeight = window.innerHeight;
const originalVisualViewport = window.visualViewport;

afterEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalInnerWidth });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalInnerHeight });
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: originalVisualViewport });
});

function Harness({ onSelect = vi.fn() }: { onSelect?: (command: SlashCommand) => void }) {
  const anchorRef = useRef<HTMLTextAreaElement>(null);
  const [open, setOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);

  return (
    <div data-testid="clipped-rail" className="overflow-hidden" style={{ width: 448 }}>
      <textarea
        ref={anchorRef}
        aria-label="Composer"
        onClick={() => setOpen(true)}
      />
      <SlashCommandMenu
        id="slash-menu"
        open={open}
        anchorRef={anchorRef}
        commands={commands}
        selectedIndex={selectedIndex}
        onNavigate={setSelectedIndex}
        onSelect={(command) => {
          onSelect(command);
          setOpen(false);
        }}
        onDismiss={() => setOpen(false)}
      />
    </div>
  );
}

function setAnchorRect(anchor: HTMLElement) {
  vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue({
    left: 420,
    right: 620,
    top: 650,
    bottom: 690,
    width: 200,
    height: 40,
    x: 420,
    y: 650,
    toJSON: () => ({}),
  });
}

describe('SlashCommandMenu viewport ownership', () => {
  it('portals outside a clipped 448px rail and keeps desktop keyboard focus in the composer', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 768 });
    render(<Harness onSelect={onSelect} />);

    const composer = screen.getByRole('textbox', { name: 'Composer' });
    setAnchorRect(composer);
    await user.click(composer);

    const menu = await screen.findByRole('listbox', { name: 'Slash commands' });
    const transientRoot = menu.closest('[data-anchored-popover-root="true"]');
    expect(transientRoot?.parentElement).toBe(document.body);
    expect(screen.getByTestId('clipped-rail').contains(menu)).toBe(false);
    expect(document.querySelector('[data-anchored-popover-mode="anchored"]')).toHaveAttribute('data-anchored-popover-placement', 'top');
    expect(composer).toHaveFocus();

    const modelOption = screen.getByRole('option', { name: /model/i });
    fireEvent.mouseDown(modelOption);
    fireEvent.click(modelOption);
    expect(onSelect).toHaveBeenCalledWith(commands[1]);
    expect(screen.queryByRole('listbox', { name: 'Slash commands' })).not.toBeInTheDocument();
    expect(composer).toHaveFocus();
  });

  it('uses a modal sheet at a zoomed visual viewport and owns arrow-key focus and dismissal', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const visualViewport = new EventTarget() as VisualViewport;
    Object.assign(visualViewport, {
      width: 420,
      height: 360,
      offsetLeft: 300,
      offsetTop: 120,
      pageLeft: 300,
      pageTop: 120,
      scale: 2,
    });
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1366 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 768 });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: visualViewport });
    const { container } = render(<Harness onSelect={onSelect} />);

    const composer = screen.getByRole('textbox', { name: 'Composer' });
    setAnchorRect(composer);
    await user.click(composer);

    const dialog = await screen.findByRole('dialog', { name: 'Slash commands' });
    const first = screen.getByRole('option', { name: /new/i });
    const second = screen.getByRole('option', { name: /model/i });
    await waitFor(() => expect(first).toHaveFocus());
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(container).toHaveAttribute('inert');
    expect(document.body.style.overflow).toBe('hidden');

    await user.keyboard('{ArrowDown}');
    expect(second).toHaveFocus();
    expect(second).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledWith(commands[1]);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Slash commands' })).not.toBeInTheDocument());
    expect(document.body.style.overflow).toBe('');
  });

  it('repositions after visual viewport changes and consumes Escape without leaking it', async () => {
    const onSelect = vi.fn();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 900 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 700 });
    render(<Harness onSelect={onSelect} />);
    const composer = screen.getByRole('textbox', { name: 'Composer' });
    setAnchorRect(composer);
    fireEvent.click(composer);
    expect(await screen.findByRole('listbox', { name: 'Slash commands' })).toBeInTheDocument();

    act(() => window.dispatchEvent(new Event('resize')));
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => document.dispatchEvent(escape));
    expect(escape.defaultPrevented).toBe(true);
    await waitFor(() => expect(screen.queryByRole('listbox', { name: 'Slash commands' })).not.toBeInTheDocument());
    expect(onSelect).not.toHaveBeenCalled();
  });
});
