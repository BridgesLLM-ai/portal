// @vitest-environment jsdom
import "../test/setup";
import { useRef, useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import ViewportModal, { registerViewportTransientOverlay } from "./ViewportModal";

function ModalHarness({ onDismiss = vi.fn() }: { onDismiss?: () => void }) {
  const [open, setOpen] = useState(false);
  const firstRef = useRef<HTMLButtonElement>(null);
  const dismiss = () => {
    onDismiss();
    setOpen(false);
  };

  return (
    <div
      data-testid="transformed-ancestor"
      style={{ transform: "translate3d(0, 0, 0)" }}
    >
      <button type="button" onClick={() => setOpen(true)}>
        Open modal
      </button>
      <ViewportModal
        open={open}
        onDismiss={dismiss}
        initialFocusRef={firstRef}
        className="bg-black/60 p-4"
      >
        <div role="dialog" aria-label="Test modal">
          <button ref={firstRef} type="button">
            First action
          </button>
          <button type="button">Last action</button>
        </div>
      </ViewportModal>
    </div>
  );
}

describe("ViewportModal", () => {
  it("owns a body portal outside transformed ancestors, inerts the page, and locks body scrolling", async () => {
    const user = userEvent.setup();
    const { container } = render(<ModalHarness />);

    await user.click(screen.getByRole("button", { name: "Open modal" }));
    const dialog = await screen.findByRole("dialog", { name: "Test modal" });
    const overlayRoot = dialog.closest<HTMLElement>(
      '[data-viewport-overlay-root="true"]',
    );

    expect(overlayRoot?.parentElement).toBe(document.body);
    expect(container.contains(dialog)).toBe(false);
    expect(container).toHaveAttribute("inert");
    expect(container).toHaveAttribute("aria-hidden", "true");
    expect(document.body.style.overflow).toBe("hidden");
    expect(document.body.style.overscrollBehavior).toBe("contain");
  });

  it("traps focus in both directions, closes on Escape, restores focus, and releases page locks", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    const { container } = render(<ModalHarness onDismiss={onDismiss} />);
    const opener = screen.getByRole("button", { name: "Open modal" });

    await user.click(opener);
    const first = await screen.findByRole("button", { name: "First action" });
    const last = screen.getByRole("button", { name: "Last action" });
    await waitFor(() => expect(first).toHaveFocus());

    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(last).toHaveFocus();
    await user.keyboard("{Tab}");
    expect(first).toHaveFocus();

    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Test modal" }),
      ).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(opener).toHaveFocus());
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(document.body.style.overflow).toBe("");
    expect(document.body.style.overscrollBehavior).toBe("");
    expect(container).not.toHaveAttribute("inert");
    expect(container).not.toHaveAttribute("aria-hidden");
  });

  it("contains the layer to the shifted visual viewport", async () => {
    const originalVisualViewport = window.visualViewport;
    const visualViewport = {
      offsetLeft: 18,
      offsetTop: 32,
      width: 375,
      height: 540,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as VisualViewport;
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: visualViewport,
    });

    const { unmount } = render(
      <ViewportModal open onDismiss={vi.fn()}>
        <div role="dialog" aria-label="Viewport modal" />
      </ViewportModal>,
    );

    const dialog = await screen.findByRole("dialog", {
      name: "Viewport modal",
    });
    const overlayRoot = dialog.closest<HTMLElement>(
      '[data-viewport-overlay-root="true"]',
    );
    await waitFor(() => {
      expect(overlayRoot).toHaveStyle({
        left: "18px",
        top: "32px",
        width: "375px",
        height: "540px",
      });
    });

    unmount();
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: originalVisualViewport,
    });
  });

  it("tracks post-mount visualViewport resize and scroll changes", async () => {
    const originalVisualViewport = window.visualViewport;
    const listeners = new Map<string, Set<EventListener>>();
    const viewportState = { left: 10, top: 20, width: 700, height: 500 };
    const visualViewport = {
      get offsetLeft() {
        return viewportState.left;
      },
      get offsetTop() {
        return viewportState.top;
      },
      get width() {
        return viewportState.width;
      },
      get height() {
        return viewportState.height;
      },
      addEventListener: vi.fn((type: string, listener: EventListener) => {
        const group = listeners.get(type) || new Set<EventListener>();
        group.add(listener);
        listeners.set(type, group);
      }),
      removeEventListener: vi.fn((type: string, listener: EventListener) => {
        listeners.get(type)?.delete(listener);
      }),
    } as unknown as VisualViewport;
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: visualViewport,
    });

    const { unmount } = render(
      <ViewportModal open onDismiss={vi.fn()}>
        <div role="dialog" aria-label="Responsive viewport modal" />
      </ViewportModal>,
    );
    const dialog = screen.getByRole("dialog", {
      name: "Responsive viewport modal",
    });
    const root = dialog.closest<HTMLElement>(
      '[data-viewport-overlay-root="true"]',
    )!;
    expect(root).toHaveStyle({
      left: "10px",
      top: "20px",
      width: "700px",
      height: "500px",
    });

    viewportState.left = 80;
    viewportState.top = 55;
    viewportState.width = 420;
    viewportState.height = 320;
    act(() => {
      listeners
        .get("resize")
        ?.forEach((listener) => listener(new Event("resize")));
      listeners
        .get("scroll")
        ?.forEach((listener) => listener(new Event("scroll")));
    });

    await waitFor(() =>
      expect(root).toHaveStyle({
        left: "80px",
        top: "55px",
        width: "420px",
        height: "320px",
      }),
    );

    unmount();
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: originalVisualViewport,
    });
  });

  it("dismisses only from the backdrop and does not bubble portal clicks into page handlers", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    const onPageClick = vi.fn();
    render(
      <div role="presentation" onClick={onPageClick}>
        <ViewportModal open onDismiss={onDismiss}>
          <div role="dialog" aria-label="Click-safe modal">
            <button type="button">Inside action</button>
          </div>
        </ViewportModal>
      </div>,
    );

    await user.click(
      await screen.findByRole("button", { name: "Inside action" }),
    );
    expect(onDismiss).not.toHaveBeenCalled();
    expect(onPageClick).not.toHaveBeenCalled();

    await user.click(
      document.querySelector('[data-viewport-modal-layer="true"]')!,
    );
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onPageClick).not.toHaveBeenCalled();
  });

  it("consumes Escape and backdrop input when dismissal is disabled", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(
      <ViewportModal open dismissible={false} onDismiss={onDismiss}>
        <div role="dialog" aria-label="Busy modal">
          <button type="button">Wait</button>
        </div>
      </ViewportModal>,
    );

    await screen.findByRole("dialog", { name: "Busy modal" });
    await user.keyboard("{Escape}");
    await user.click(
      document.querySelector('[data-viewport-modal-layer="true"]')!,
    );

    expect(onDismiss).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Busy modal" })).toBeVisible();
  });

  it("establishes the body portal and interaction lock in the opening commit", () => {
    const { container } = render(
      <ViewportModal open onDismiss={vi.fn()}>
        <div role="dialog" aria-label="Immediate modal" />
      </ViewportModal>,
    );

    const dialog = screen.getByRole("dialog", { name: "Immediate modal" });
    expect(dialog.closest('[data-viewport-overlay-root="true"]')?.parentElement)
      .toBe(document.body);
    expect(container).toHaveAttribute("inert");
    expect(document.body.style.overflow).toBe("hidden");
    expect(document.documentElement.style.overflow).toBe("hidden");
  });

  it("keeps nested ownership LIFO and restores the underlying modal before the page", async () => {
    const user = userEvent.setup();

    function NestedHarness() {
      const [outerOpen, setOuterOpen] = useState(false);
      const [innerOpen, setInnerOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOuterOpen(true)}>
            Open outer
          </button>
          <ViewportModal open={outerOpen} onDismiss={() => setOuterOpen(false)} zIndex={5000}>
            <div role="dialog" aria-label="Outer modal">
              <button type="button" onClick={() => setInnerOpen(true)}>
                Open inner
              </button>
              <button type="button">Outer last</button>
              <ViewportModal open={innerOpen} onDismiss={() => setInnerOpen(false)}>
                <div role="dialog" aria-label="Inner modal">
                  <button type="button">Inner first</button>
                  <button type="button">Inner last</button>
                </div>
              </ViewportModal>
            </div>
          </ViewportModal>
        </>
      );
    }

    const { container } = render(<NestedHarness />);
    const pageOpener = screen.getByRole("button", { name: "Open outer" });
    await user.click(pageOpener);
    const outerDialog = await screen.findByRole("dialog", { name: "Outer modal" });
    const innerOpener = screen.getByRole("button", { name: "Open inner" });
    await user.click(innerOpener);
    const innerDialog = await screen.findByRole("dialog", { name: "Inner modal" });
    const outerRoot = outerDialog.closest<HTMLElement>(
      '[data-viewport-overlay-root="true"]',
    );
    const innerRoot = innerDialog.closest<HTMLElement>(
      '[data-viewport-overlay-root="true"]',
    );

    expect(outerRoot).toHaveAttribute("inert");
    expect(outerRoot).toHaveAttribute("aria-hidden", "true");
    expect(innerRoot).not.toHaveAttribute("inert");
    expect(Number(innerRoot?.style.zIndex)).toBeGreaterThan(
      Number(outerRoot?.style.zIndex),
    );
    expect(container).toHaveAttribute("inert");

    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Inner modal" }))
        .not.toBeInTheDocument(),
    );
    await waitFor(() => expect(innerOpener).toHaveFocus());
    expect(outerRoot).not.toHaveAttribute("inert");
    expect(document.body.style.overflow).toBe("hidden");

    await user.keyboard("{Escape}");
    await waitFor(() => expect(pageOpener).toHaveFocus());
    expect(document.body.style.overflow).toBe("");
    expect(document.documentElement.style.overflow).toBe("");
    expect(container).not.toHaveAttribute("inert");
  });

  it("preserves LIFO order and focus restoration when nested modals mount and tear down together", async () => {
    const user = userEvent.setup();
    const outerDismiss = vi.fn();
    const innerDismiss = vi.fn();

    function SimultaneousHarness({ open }: { open: boolean }) {
      return (
        <>
          <button type="button">Page opener</button>
          <ViewportModal open={open} onDismiss={outerDismiss}>
            <div role="dialog" aria-label="Simultaneous outer">
              <button type="button">Outer action</button>
              <ViewportModal open={open} onDismiss={innerDismiss}>
                <div role="dialog" aria-label="Simultaneous inner">
                  <button type="button">Inner action</button>
                </div>
              </ViewportModal>
            </div>
          </ViewportModal>
        </>
      );
    }

    const { rerender } = render(<SimultaneousHarness open={false} />);
    const opener = screen.getByRole("button", { name: "Page opener" });
    opener.focus();
    rerender(<SimultaneousHarness open />);

    const inner = await screen.findByRole("dialog", { name: "Simultaneous inner" });
    const outer = screen.getByRole("dialog", {
      name: "Simultaneous outer",
      hidden: true,
    });
    expect(outer.closest('[data-viewport-overlay-root="true"]'))
      .toHaveAttribute("inert");
    expect(inner.closest('[data-viewport-overlay-root="true"]'))
      .not.toHaveAttribute("inert");

    await user.keyboard("{Escape}");
    expect(innerDismiss).toHaveBeenCalledTimes(1);
    expect(outerDismiss).not.toHaveBeenCalled();

    rerender(<SimultaneousHarness open={false} />);
    await waitFor(() => expect(opener).toHaveFocus());
    expect(document.body.style.overflow).toBe("");
  });

  it("preserves the page focus anchor when one sibling modal replaces another in the same commit", async () => {
    function ReplacementHarness({ surface }: { surface: "first" | "second" | null }) {
      return (
        <>
          <button type="button">Page action</button>
          <ViewportModal open={surface === "first"} onDismiss={vi.fn()}>
            <div role="dialog" aria-label="First surface">
              <button type="button">First modal action</button>
            </div>
          </ViewportModal>
          <ViewportModal open={surface === "second"} onDismiss={vi.fn()}>
            <div role="dialog" aria-label="Second surface">
              <button type="button">Second modal action</button>
            </div>
          </ViewportModal>
        </>
      );
    }

    const { rerender } = render(<ReplacementHarness surface={null} />);
    const pageAction = screen.getByRole("button", { name: "Page action" });
    pageAction.focus();

    rerender(<ReplacementHarness surface="first" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "First modal action" })).toHaveFocus());

    rerender(<ReplacementHarness surface="second" />);
    expect(screen.queryByRole("dialog", { name: "First surface" })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Second modal action" })).toHaveFocus());

    rerender(<ReplacementHarness surface={null} />);
    await waitFor(() => expect(pageAction).toHaveFocus());
  });

  it("suppresses registered body transients added after opening and restores their original state", async () => {
    const { unmount } = render(
      <ViewportModal open onDismiss={vi.fn()}>
        <div role="dialog" aria-label="Observed modal" />
      </ViewportModal>,
    );
    const latePortal = document.createElement("div");
    latePortal.setAttribute("aria-hidden", "false");
    document.body.appendChild(latePortal);
    const unregisterTransient = registerViewportTransientOverlay(latePortal, null);

    await waitFor(() => expect(latePortal).toHaveAttribute("inert"));
    expect(latePortal).toHaveAttribute("aria-hidden", "true");
    expect(latePortal).toHaveAttribute(
      "data-viewport-transient-suppressed",
      "true",
    );
    expect(latePortal.hidden).toBe(true);

    unmount();
    expect(latePortal).not.toHaveAttribute("inert");
    expect(latePortal).toHaveAttribute("aria-hidden", "false");
    expect(latePortal).not.toHaveAttribute("data-viewport-transient-suppressed");
    expect(latePortal.hidden).toBe(false);
    unregisterTransient();
    latePortal.remove();
  });

  it("skips controls beneath hidden and inert ancestors when choosing focus", async () => {
    render(
      <ViewportModal open onDismiss={vi.fn()}>
        <div role="dialog" aria-label="Filtered focus modal">
          <div aria-hidden="true">
            <button type="button">Aria-hidden action</button>
          </div>
          <div ref={(element) => element?.setAttribute("inert", "")}>
            <button type="button">Inert action</button>
          </div>
          <button type="button">Visible action</button>
        </div>
      </ViewportModal>,
    );

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Visible action" })).toHaveFocus(),
    );
  });

  it("contains pointer-up, mouse-up, context-menu, and key-up portal events", async () => {
    const pagePointerUp = vi.fn();
    const pageMouseUp = vi.fn();
    const pageClick = vi.fn();
    const pageContextMenu = vi.fn();
    const pageKeyUp = vi.fn();
    const pageDoubleClick = vi.fn();
    render(
      <div
        role="presentation"
        onPointerUp={pagePointerUp}
        onMouseUp={pageMouseUp}
        onClick={pageClick}
        onContextMenu={pageContextMenu}
        onKeyUp={pageKeyUp}
        onDoubleClick={pageDoubleClick}
      >
        <ViewportModal open onDismiss={vi.fn()}>
          <div role="dialog" aria-label="Contained events modal">
            <button type="button">Portal event target</button>
          </div>
        </ViewportModal>
      </div>,
    );
    const target = await screen.findByRole("button", {
      name: "Portal event target",
    });

    fireEvent.pointerUp(target);
    fireEvent.mouseUp(target);
    fireEvent.click(target);
    fireEvent.contextMenu(target);
    fireEvent.keyUp(target, { key: "Enter" });
    fireEvent.doubleClick(target);

    expect(pagePointerUp).not.toHaveBeenCalled();
    expect(pageMouseUp).not.toHaveBeenCalled();
    expect(pageClick).not.toHaveBeenCalled();
    expect(pageContextMenu).not.toHaveBeenCalled();
    expect(pageKeyUp).not.toHaveBeenCalled();
    expect(pageDoubleClick).not.toHaveBeenCalled();
  });
});
