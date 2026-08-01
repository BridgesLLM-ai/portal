// @vitest-environment jsdom
import '../test/setup';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AnchoredPopover, { computeAnchoredPopoverLayout } from './AnchoredPopover';
import ViewportModal, {
  VIEWPORT_MODAL_Z_INDEX,
  VIEWPORT_TRANSIENT_Z_INDEX,
} from './ViewportModal';

const originalInnerWidth = window.innerWidth;
const originalInnerHeight = window.innerHeight;
const originalVisualViewport = window.visualViewport;

afterEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalInnerWidth });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalInnerHeight });
  Object.defineProperty(window, 'visualViewport', {
    configurable: true,
    value: originalVisualViewport,
  });
});

describe('computeAnchoredPopoverLayout', () => {
  it('flips above a low trigger and remains inside the visual viewport', () => {
    const layout = computeAnchoredPopoverLayout({
      anchor: { left: 1200, right: 1350, top: 500, bottom: 530 },
      viewport: { left: 0, top: 0, width: 1366, height: 600 },
      requestedWidth: 352,
      align: 'end',
      gap: 8,
      margin: 8,
      mobileBreakpoint: 639,
      preferredMinimumHeight: 240,
    });

    expect(layout).toMatchObject({ mode: 'anchored', placement: 'top', width: 352 });
    expect(layout.left).toBeGreaterThanOrEqual(8);
    expect(layout.left + layout.width).toBeLessThanOrEqual(1358);
    expect(layout.bottom).toBe(108);
    expect(layout.maxHeight).toBe(484);
  });

  it('uses a viewport-contained bottom sheet on narrow screens', () => {
    const layout = computeAnchoredPopoverLayout({
      anchor: { left: 300, right: 365, top: 40, bottom: 70 },
      viewport: { left: 0, top: 0, width: 375, height: 600 },
      requestedWidth: 352,
      align: 'end',
      gap: 8,
      margin: 8,
      mobileBreakpoint: 639,
      preferredMinimumHeight: 240,
    });

    expect(layout).toEqual({
      mode: 'sheet',
      placement: 'bottom',
      left: 8,
      bottom: 8,
      width: 352,
      maxHeight: 584,
    });
  });

  it('accounts for a shifted visual viewport at browser zoom', () => {
    const layout = computeAnchoredPopoverLayout({
      anchor: { left: 640, right: 700, top: 210, bottom: 240 },
      viewport: { left: 300, top: 120, width: 420, height: 360 },
      requestedWidth: 352,
      align: 'end',
      gap: 8,
      margin: 8,
      mobileBreakpoint: 375,
      preferredMinimumHeight: 160,
    });

    expect(layout.left).toBe(48);
    expect(layout.left + layout.width).toBeLessThanOrEqual(412);
    expect(layout.top).toBe(128);
    expect(layout.maxHeight).toBe(224);
  });

  it('clamps anchors that have scrolled above or below the visual viewport', () => {
    const aboveViewport = computeAnchoredPopoverLayout({
      anchor: { left: 20, right: 80, top: -100, bottom: -60 },
      viewport: { left: 0, top: 0, width: 1024, height: 600 },
      requestedWidth: 352,
      align: 'start',
      gap: 8,
      margin: 8,
      mobileBreakpoint: 639,
      preferredMinimumHeight: 240,
    });
    const belowViewport = computeAnchoredPopoverLayout({
      anchor: { left: 20, right: 80, top: 700, bottom: 730 },
      viewport: { left: 0, top: 0, width: 1024, height: 600 },
      requestedWidth: 352,
      align: 'start',
      gap: 8,
      margin: 8,
      mobileBreakpoint: 639,
      preferredMinimumHeight: 240,
    });

    expect(aboveViewport).toMatchObject({
      placement: 'bottom',
      top: 16,
      maxHeight: 576,
    });
    expect(belowViewport).toMatchObject({
      placement: 'top',
      bottom: 16,
      maxHeight: 576,
    });
  });

  it('portals narrow layouts behind a click-blocking sheet backdrop', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 667 });

    function Harness() {
      const anchorRef = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button
            ref={anchorRef}
            type="button"
            data-testid="anchor"
          >
            Open
          </button>
          <AnchoredPopover open anchorRef={anchorRef} onDismiss={onDismiss}>
            <div role="dialog">Sheet content</div>
          </AnchoredPopover>
        </>
      );
    }

    render(<Harness />);

    const root = document.querySelector<HTMLElement>('[data-anchored-popover-root="true"]');
    const backdrop = document.querySelector<HTMLElement>('[data-anchored-popover-backdrop="true"]');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(root).toHaveStyle({ pointerEvents: 'auto' });
    expect(backdrop).not.toBeNull();

    await user.pointer({ keys: '[MouseLeft]', target: backdrop as HTMLElement });
    expect(onDismiss).toHaveBeenCalledWith('outside');
  });

  it('gives anchored content a definite flex-column height context so long menus scroll instead of clipping', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });

    function Harness() {
      const anchorRef = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button ref={anchorRef} type="button">Open</button>
          <AnchoredPopover open anchorRef={anchorRef} onDismiss={() => {}}>
            <div role="dialog">Anchored content</div>
          </AnchoredPopover>
        </>
      );
    }

    render(<Harness />);

    const content = document.querySelector<HTMLElement>('[data-anchored-popover-mode="anchored"]');
    expect(content).not.toBeNull();
    // Without a flex column, a child's percentage max-height resolves to none
    // against the wrapper's auto height; oversized menus then clip and wheel
    // input scroll-chains into the surface behind the popover.
    expect(content).toHaveStyle({
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
    });
    expect(content!.style.maxHeight).not.toBe('');
  });

  it('gives sheet content the same flex-column height context on narrow screens', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 667 });

    function Harness() {
      const anchorRef = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button ref={anchorRef} type="button">Open</button>
          <AnchoredPopover open anchorRef={anchorRef} onDismiss={() => {}}>
            <div role="dialog">Sheet content</div>
          </AnchoredPopover>
        </>
      );
    }

    render(<Harness />);

    const content = document.querySelector<HTMLElement>('[data-anchored-popover-mode="sheet"]');
    expect(content).not.toBeNull();
    expect(content).toHaveStyle({
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
    });
  });

  it('makes the mobile sheet modal, traps focus, locks scroll, and dismisses only after click', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    const pageClick = vi.fn();
    const pageWheel = vi.fn();
    const pageTouchMove = vi.fn();
    const pagePointerDown = vi.fn();
    const pagePointerUp = vi.fn();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 667 });

    function Harness() {
      const [open, setOpen] = useState(false);
      const anchorRef = useRef<HTMLButtonElement>(null);
      return (
        <div
          role="presentation"
          onClick={pageClick}
          onWheel={pageWheel}
          onTouchMove={pageTouchMove}
          onPointerDown={pagePointerDown}
          onPointerUp={pagePointerUp}
        >
          <button ref={anchorRef} type="button" onClick={() => setOpen(true)}>
            Open mobile sheet
          </button>
          <button type="button">Behind sheet</button>
          <AnchoredPopover
            open={open}
            anchorRef={anchorRef}
            ariaLabel="Mobile options"
            onDismiss={(reason) => {
              onDismiss(reason);
              setOpen(false);
            }}
          >
            <div>
              <button type="button">First sheet action</button>
              <button type="button">Last sheet action</button>
            </div>
          </AnchoredPopover>
        </div>
      );
    }

    const { container } = render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Open mobile sheet' });
    await user.click(opener);
    pageClick.mockClear();
    pagePointerDown.mockClear();
    pagePointerUp.mockClear();

    const dialog = await screen.findByRole('dialog', { name: 'Mobile options' });
    const first = screen.getByRole('button', { name: 'First sheet action' });
    const last = screen.getByRole('button', { name: 'Last sheet action' });
    const backdrop = document.querySelector<HTMLElement>(
      '[data-anchored-popover-backdrop="true"]',
    )!;
    await waitFor(() => expect(first).toHaveFocus());
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(container).toHaveAttribute('inert');
    expect(document.body.style.overflow).toBe('hidden');
    expect(document.documentElement.style.overflow).toBe('hidden');

    await user.keyboard('{Shift>}{Tab}{/Shift}');
    expect(last).toHaveFocus();
    await user.keyboard('{Tab}');
    expect(first).toHaveFocus();

    fireEvent.wheel(backdrop);
    fireEvent.touchMove(backdrop);
    fireEvent.pointerDown(backdrop);
    fireEvent.pointerUp(backdrop);
    expect(onDismiss).not.toHaveBeenCalled();
    expect(dialog).toBeInTheDocument();
    expect(pageWheel).not.toHaveBeenCalled();
    expect(pageTouchMove).not.toHaveBeenCalled();
    expect(pagePointerDown).not.toHaveBeenCalled();
    expect(pagePointerUp).not.toHaveBeenCalled();

    fireEvent.click(backdrop);
    expect(onDismiss).toHaveBeenCalledWith('outside');
    expect(pageClick).not.toHaveBeenCalled();
    await waitFor(() => expect(opener).toHaveFocus());
    expect(document.body.style.overflow).toBe('');
  });

  it('uses safe-area-aware sheet geometry', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 667 });

    function Harness() {
      const anchorRef = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button ref={anchorRef} type="button">Anchor</button>
          <AnchoredPopover open anchorRef={anchorRef} onDismiss={vi.fn()}>
            <button type="button">Sheet action</button>
          </AnchoredPopover>
        </>
      );
    }

    render(<Harness />);
    const content = await screen.findByRole('dialog', { name: 'Options' });
    const style = content.getAttribute('style') || '';
    expect(style).toContain('safe-area-inset-top');
    expect(style).toContain('safe-area-inset-right');
    expect(style).toContain('safe-area-inset-bottom');
    expect(style).toContain('safe-area-inset-left');
  });

  it('repositions after visualViewport resize and scroll events', async () => {
    const listeners = new Map<string, Set<EventListener>>();
    const viewportState = { left: 40, top: 20, width: 900, height: 600 };
    const visualViewport = {
      get offsetLeft() { return viewportState.left; },
      get offsetTop() { return viewportState.top; },
      get width() { return viewportState.width; },
      get height() { return viewportState.height; },
      addEventListener: vi.fn((type: string, listener: EventListener) => {
        const group = listeners.get(type) || new Set<EventListener>();
        group.add(listener);
        listeners.set(type, group);
      }),
      removeEventListener: vi.fn((type: string, listener: EventListener) => {
        listeners.get(type)?.delete(listener);
      }),
    } as unknown as VisualViewport;
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: visualViewport,
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 700,
      right: 760,
      top: 200,
      bottom: 230,
      width: 60,
      height: 30,
      x: 700,
      y: 200,
      toJSON: () => ({}),
    });

    function Harness() {
      const anchorRef = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button ref={anchorRef} type="button">Viewport anchor</button>
          <AnchoredPopover
            open
            anchorRef={anchorRef}
            mobileBreakpoint={300}
            onDismiss={vi.fn()}
          >
            <button type="button">Viewport action</button>
          </AnchoredPopover>
        </>
      );
    }

    render(<Harness />);
    const root = await waitFor(() => {
      const candidate = document.querySelector<HTMLElement>(
        '[data-anchored-popover-root="true"]',
      );
      expect(candidate).not.toBeNull();
      return candidate!;
    });
    expect(root).toHaveStyle({ left: '40px', top: '20px', width: '900px', height: '600px' });

    viewportState.left = 180;
    viewportState.top = 90;
    viewportState.width = 500;
    viewportState.height = 360;
    act(() => {
      listeners.get('resize')?.forEach((listener) => listener(new Event('resize')));
      listeners.get('scroll')?.forEach((listener) => listener(new Event('scroll')));
    });

    await waitFor(() =>
      expect(root).toHaveStyle({
        left: '180px',
        top: '90px',
        width: '500px',
        height: '360px',
      }),
    );
  });

  it('contains desktop portal events before they reach React ancestors', async () => {
    const pagePointerUp = vi.fn();
    const pageMouseUp = vi.fn();
    const pageClick = vi.fn();
    const pageContextMenu = vi.fn();
    const pageKeyUp = vi.fn();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });

    function Harness() {
      const anchorRef = useRef<HTMLButtonElement>(null);
      return (
        <div
          role="presentation"
          onPointerUp={pagePointerUp}
          onMouseUp={pageMouseUp}
          onClick={pageClick}
          onContextMenu={pageContextMenu}
          onKeyUp={pageKeyUp}
        >
          <button ref={anchorRef} type="button">Desktop anchor</button>
          <AnchoredPopover open anchorRef={anchorRef} onDismiss={vi.fn()}>
            <button type="button">Desktop portal target</button>
          </AnchoredPopover>
        </div>
      );
    }

    render(<Harness />);
    const target = await screen.findByRole('button', { name: 'Desktop portal target' });
    fireEvent.pointerUp(target);
    fireEvent.mouseUp(target);
    fireEvent.click(target);
    fireEvent.contextMenu(target);
    fireEvent.keyUp(target, { key: 'Enter' });

    expect(pagePointerUp).not.toHaveBeenCalled();
    expect(pageMouseUp).not.toHaveBeenCalled();
    expect(pageClick).not.toHaveBeenCalled();
    expect(pageContextMenu).not.toHaveBeenCalled();
    expect(pageKeyUp).not.toHaveBeenCalled();
  });

  it('portals a desktop popover into its top modal interaction layer', async () => {
    const user = userEvent.setup();
    const action = vi.fn();
    const modalDismiss = vi.fn();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });

    function Harness() {
      const [open, setOpen] = useState(false);
      const anchorRef = useRef<HTMLButtonElement>(null);
      return (
        <ViewportModal open onDismiss={modalDismiss}>
          <div role="dialog" aria-label="Popover owner modal">
            <button ref={anchorRef} type="button" onClick={() => setOpen(true)}>
              Open owned popover
            </button>
            <AnchoredPopover
              open={open}
              anchorRef={anchorRef}
              onDismiss={(reason) => {
                setOpen(false);
                if (reason === 'escape') anchorRef.current?.focus();
              }}
            >
              <button type="button" onClick={action}>Owned popover action</button>
            </AnchoredPopover>
          </div>
        </ViewportModal>
      );
    }

    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Open owned popover' }));
    const actionButton = await screen.findByRole('button', { name: 'Owned popover action' });
    const root = actionButton.closest<HTMLElement>('[data-anchored-popover-root="true"]')!;
    const modalLayer = screen
      .getByRole('dialog', { name: 'Popover owner modal' })
      .closest<HTMLElement>('[data-viewport-modal-layer="true"]')!;

    expect(root.parentElement).toBe(modalLayer);
    expect(root).not.toHaveAttribute('hidden');
    expect(root).not.toHaveAttribute('inert');
    expect(root).not.toHaveAttribute('aria-hidden');
    expect(root).toHaveStyle({ zIndex: String(VIEWPORT_TRANSIENT_Z_INDEX) });
    await user.click(actionButton);
    expect(action).toHaveBeenCalledTimes(1);

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Owned popover action' })).not.toBeInTheDocument());
    expect(screen.getByRole('dialog', { name: 'Popover owner modal' })).toBeVisible();
    expect(modalDismiss).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Open owned popover' })).toHaveFocus();

    await user.click(screen.getByRole('button', { name: 'Open owned popover' }));
    await screen.findByRole('button', { name: 'Owned popover action' });
    await user.click(modalLayer);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Owned popover action' })).not.toBeInTheDocument());
    expect(screen.getByRole('dialog', { name: 'Popover owner modal' })).toBeVisible();
    expect(modalDismiss).not.toHaveBeenCalled();
  });

  it('suppresses a body popover while an async modal owns the page and restores it afterward', async () => {
    const user = userEvent.setup();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });

    function Harness() {
      const [popoverOpen, setPopoverOpen] = useState(true);
      const [modalOpen, setModalOpen] = useState(false);
      const anchorRef = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button ref={anchorRef} type="button">Body popover anchor</button>
          <AnchoredPopover
            open={popoverOpen}
            anchorRef={anchorRef}
            onDismiss={() => setPopoverOpen(false)}
          >
            <button type="button" onClick={() => setTimeout(() => setModalOpen(true), 0)}>
              Start async modal
            </button>
          </AnchoredPopover>
          <ViewportModal open={modalOpen} onDismiss={() => setModalOpen(false)}>
            <div role="dialog" aria-label="Async modal">
              <button type="button">Async modal action</button>
            </div>
          </ViewportModal>
        </>
      );
    }

    render(<Harness />);
    const openModal = await screen.findByRole('button', { name: 'Start async modal' });
    const root = openModal.closest<HTMLElement>('[data-anchored-popover-root="true"]')!;
    await user.click(openModal);
    const modal = await screen.findByRole('dialog', { name: 'Async modal' });
    const modalRoot = modal.closest<HTMLElement>('[data-viewport-overlay-root="true"]')!;

    await waitFor(() => expect(root).toHaveAttribute('data-viewport-transient-suppressed', 'true'));
    expect(root.hidden).toBe(true);
    expect(root).toHaveAttribute('inert');
    expect(root).toHaveAttribute('aria-hidden', 'true');
    expect(Number(modalRoot.style.zIndex)).toBeGreaterThan(Number(root.style.zIndex));

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Async modal' })).not.toBeInTheDocument());
    await waitFor(() => expect(root).not.toHaveAttribute('data-viewport-transient-suppressed'));
    expect(root.hidden).toBe(false);
    expect(root).not.toHaveAttribute('inert');
    expect(root).not.toHaveAttribute('aria-hidden');
    expect(screen.getByRole('button', { name: 'Start async modal' })).toBeVisible();
  });

  it('suppresses an outer-modal popover for a nested modal and restores top ownership in LIFO order', async () => {
    const user = userEvent.setup();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });

    function Harness() {
      const [popoverOpen, setPopoverOpen] = useState(false);
      const [innerOpen, setInnerOpen] = useState(false);
      const anchorRef = useRef<HTMLButtonElement>(null);
      return (
        <ViewportModal open onDismiss={vi.fn()}>
          <div role="dialog" aria-label="Outer owner modal">
            <button ref={anchorRef} type="button" onClick={() => setPopoverOpen(true)}>
              Open outer popover
            </button>
            <AnchoredPopover
              open={popoverOpen}
              anchorRef={anchorRef}
              onDismiss={() => setPopoverOpen(false)}
            >
              <button type="button" onClick={() => setInnerOpen(true)}>Open nested modal</button>
            </AnchoredPopover>
            <ViewportModal open={innerOpen} onDismiss={() => setInnerOpen(false)}>
              <div role="dialog" aria-label="Nested owner modal">
                <button type="button">Nested action</button>
              </div>
            </ViewportModal>
          </div>
        </ViewportModal>
      );
    }

    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Open outer popover' }));
    const openNested = await screen.findByRole('button', { name: 'Open nested modal' });
    const root = openNested.closest<HTMLElement>('[data-anchored-popover-root="true"]')!;
    const outerLayer = screen
      .getByRole('dialog', { name: 'Outer owner modal' })
      .closest<HTMLElement>('[data-viewport-modal-layer="true"]')!;
    expect(root.parentElement).toBe(outerLayer);

    await user.click(openNested);
    await screen.findByRole('dialog', { name: 'Nested owner modal' });
    await waitFor(() => expect(root).toHaveAttribute('data-viewport-transient-suppressed', 'true'));

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Nested owner modal' })).not.toBeInTheDocument());
    await waitFor(() => expect(root).not.toHaveAttribute('data-viewport-transient-suppressed'));
    expect(root.parentElement).toBe(outerLayer);
    expect(screen.getByRole('button', { name: 'Open nested modal' })).toBeVisible();
  });

  it('cleans transient ownership on teardown without leaking suppression to the next popover', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });

    function Harness({ mounted, modalOpen }: { mounted: boolean; modalOpen: boolean }) {
      const anchorRef = useRef<HTMLButtonElement>(null);
      if (!mounted) return null;
      return (
        <>
          <button ref={anchorRef} type="button">Teardown anchor</button>
          <AnchoredPopover open anchorRef={anchorRef} onDismiss={vi.fn()}>
            <button type="button">Teardown action</button>
          </AnchoredPopover>
          <ViewportModal open={modalOpen} onDismiss={vi.fn()}>
            <div role="dialog" aria-label="Teardown modal" />
          </ViewportModal>
        </>
      );
    }

    const view = render(<Harness mounted modalOpen />);
    const suppressedRoot = document.querySelector<HTMLElement>('[data-anchored-popover-root="true"]')!;
    await waitFor(() => expect(suppressedRoot).toHaveAttribute('data-viewport-transient-suppressed', 'true'));

    view.rerender(<Harness mounted={false} modalOpen={false} />);
    await waitFor(() => expect(document.querySelector('[data-anchored-popover-root="true"]')).toBeNull());
    expect(document.body.style.overflow).toBe('');

    view.rerender(<Harness mounted modalOpen={false} />);
    const nextAction = await screen.findByRole('button', { name: 'Teardown action' });
    const nextRoot = nextAction.closest<HTMLElement>('[data-anchored-popover-root="true"]')!;
    expect(nextRoot).not.toHaveAttribute('data-viewport-transient-suppressed');
    expect(nextRoot.hidden).toBe(false);
    expect(nextRoot).not.toHaveAttribute('inert');
    expect(Number(nextRoot.style.zIndex)).toBeLessThan(VIEWPORT_MODAL_Z_INDEX);
  });
});
