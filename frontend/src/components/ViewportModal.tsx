import {
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
  type SyntheticEvent,
} from "react";
import ViewportOverlay from "./ViewportOverlay";

export const VIEWPORT_MODAL_Z_INDEX = 1400;
export const VIEWPORT_TRANSIENT_Z_INDEX = 1300;

export type ViewportModalDismissReason = "escape" | "backdrop";

export interface ViewportModalProps {
  open: boolean;
  onDismiss: (reason?: ViewportModalDismissReason) => void;
  /**
   * Set false while a modal action owns progress. Escape and backdrop input are
   * still consumed, but neither can dismiss the modal.
   */
  dismissible?: boolean;
  children: ReactNode;
  /** Classes applied to the full visual-viewport backdrop/layout layer. */
  className?: string;
  zIndex?: number;
  initialFocusRef?: RefObject<HTMLElement>;
}

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  'input:not([disabled]):not([type="hidden"])',
  "select:not([disabled])",
  "textarea:not([disabled])",
  "iframe",
  "object",
  "embed",
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(",");

type InertSnapshot = {
  inert: boolean;
  inertAttribute: string | null;
  ariaHidden: string | null;
};

type ModalEntry = {
  id: symbol;
  sequence: number;
  root: HTMLElement;
  layer: HTMLElement;
  requestedZIndex: number;
  previousFocus: HTMLElement | null;
  focusInitial: () => void;
};

type TransientOverlayEntry = {
  root: HTMLElement;
  ownerLayer: HTMLElement | null;
  suppressed: boolean;
  snapshot: {
    hidden: boolean;
    inert: boolean;
    inertAttribute: string | null;
    ariaHidden: string | null;
    pointerEvents: string;
  };
};

const inertSnapshots = new Map<HTMLElement, InertSnapshot>();
const modalStack: ModalEntry[] = [];
const transientOverlays = new Map<HTMLElement, TransientOverlayEntry>();
const restorationFrames = new Map<symbol, number>();
let pendingPageRestoration: {
  entryId: symbol;
  desiredFocus: HTMLElement | null;
  frame: number;
} | null = null;
let nextModalSequence = 0;
let bodyObserver: MutationObserver | null = null;
let bodyStyleSnapshot: {
  bodyOverflow: string;
  bodyOverscrollBehavior: string;
  bodyPaddingRight: string;
  documentOverflow: string;
  documentOverscrollBehavior: string;
} | null = null;

/**
 * Returns the modal interaction layer that owns an anchored trigger. Desktop
 * transient overlays portal into this layer so the modal focus trap and inert
 * boundary treat them as part of the active dialog.
 */
export function findViewportModalOwner(element: Element | null): HTMLElement | null {
  return element?.closest<HTMLElement>('[data-viewport-modal-layer="true"]') ?? null;
}

function setTransientOverlaySuppressed(entry: TransientOverlayEntry, suppressed: boolean) {
  if (entry.suppressed === suppressed) return;
  entry.suppressed = suppressed;

  if (suppressed) {
    entry.root.hidden = true;
    entry.root.inert = true;
    entry.root.setAttribute("inert", "");
    entry.root.setAttribute("aria-hidden", "true");
    entry.root.style.pointerEvents = "none";
    entry.root.setAttribute("data-viewport-transient-suppressed", "true");
    return;
  }

  entry.root.hidden = entry.snapshot.hidden;
  entry.root.inert = entry.snapshot.inert;
  if (entry.snapshot.inertAttribute === null) entry.root.removeAttribute("inert");
  else entry.root.setAttribute("inert", entry.snapshot.inertAttribute);
  if (entry.snapshot.ariaHidden === null) entry.root.removeAttribute("aria-hidden");
  else entry.root.setAttribute("aria-hidden", entry.snapshot.ariaHidden);
  entry.root.style.pointerEvents = entry.snapshot.pointerEvents;
  entry.root.removeAttribute("data-viewport-transient-suppressed");
}

function reconcileTransientOverlays(topLayer: HTMLElement | null) {
  for (const entry of transientOverlays.values()) {
    const belongsToTopModal = topLayer !== null && entry.ownerLayer === topLayer;
    const shouldSuppress = topLayer !== null && !belongsToTopModal;
    setTransientOverlaySuppressed(entry, shouldSuppress);
  }
}

function hasActiveTransientOverlay(ownerLayer: HTMLElement): boolean {
  return Array.from(transientOverlays.values()).some((entry) => (
    entry.ownerLayer === ownerLayer &&
    !entry.suppressed &&
    entry.root.isConnected
  ));
}

/**
 * Registers a body-owned transient surface (menu/popover) with modal ownership.
 * Unowned surfaces are hidden while any modal owns the page; surfaces whose
 * trigger lives in the top modal remain interactive inside that modal.
 */
export function registerViewportTransientOverlay(
  root: HTMLElement,
  ownerLayer: HTMLElement | null,
): () => void {
  const entry: TransientOverlayEntry = {
    root,
    ownerLayer,
    suppressed: false,
    snapshot: {
      hidden: root.hidden,
      inert: root.inert === true,
      inertAttribute: root.getAttribute("inert"),
      ariaHidden: root.getAttribute("aria-hidden"),
      pointerEvents: root.style.pointerEvents,
    },
  };
  transientOverlays.set(root, entry);
  root.setAttribute("data-viewport-transient-overlay", "true");
  reconcilePageInertness();

  return () => {
    const current = transientOverlays.get(root);
    if (current === entry) {
      setTransientOverlaySuppressed(entry, false);
      transientOverlays.delete(root);
      root.removeAttribute("data-viewport-transient-overlay");
      reconcilePageInertness();
    }
  };
}

function hasHiddenOrInertAncestor(
  element: HTMLElement,
  boundary?: HTMLElement,
): boolean {
  let current: HTMLElement | null = element;
  while (current) {
    if (
      current.hidden ||
      current.inert ||
      current.hasAttribute("inert") ||
      current.getAttribute("aria-hidden") === "true"
    ) {
      return true;
    }

    const style = window.getComputedStyle(current);
    if (style.display === "none" || style.visibility === "hidden") return true;
    if (current === boundary) break;
    current = current.parentElement;
  }
  return false;
}

function isElementFocusable(
  element: HTMLElement,
  boundary?: HTMLElement,
): boolean {
  return (
    element.isConnected &&
    !element.matches(":disabled") &&
    !hasHiddenOrInertAncestor(element, boundary)
  );
}

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter((element) => isElementFocusable(element, container));
}

function acquireBodyLock() {
  if (bodyStyleSnapshot) return;

  bodyStyleSnapshot = {
    bodyOverflow: document.body.style.overflow,
    bodyOverscrollBehavior: document.body.style.overscrollBehavior,
    bodyPaddingRight: document.body.style.paddingRight,
    documentOverflow: document.documentElement.style.overflow,
    documentOverscrollBehavior:
      document.documentElement.style.overscrollBehavior,
  };

  const viewportWidth = window.innerWidth;
  const documentWidth = document.documentElement.clientWidth;
  const scrollbarWidth =
    documentWidth > 0 ? Math.max(0, viewportWidth - documentWidth) : 0;
  if (scrollbarWidth > 0) {
    const currentPadding =
      Number.parseFloat(window.getComputedStyle(document.body).paddingRight) ||
      0;
    document.body.style.paddingRight = `${currentPadding + scrollbarWidth}px`;
  }

  document.body.style.overflow = "hidden";
  document.body.style.overscrollBehavior = "contain";
  document.documentElement.style.overflow = "hidden";
  document.documentElement.style.overscrollBehavior = "none";
}

function releaseBodyLock() {
  if (!bodyStyleSnapshot) return;
  document.body.style.overflow = bodyStyleSnapshot.bodyOverflow;
  document.body.style.overscrollBehavior =
    bodyStyleSnapshot.bodyOverscrollBehavior;
  document.body.style.paddingRight = bodyStyleSnapshot.bodyPaddingRight;
  document.documentElement.style.overflow = bodyStyleSnapshot.documentOverflow;
  document.documentElement.style.overscrollBehavior =
    bodyStyleSnapshot.documentOverscrollBehavior;
  bodyStyleSnapshot = null;
}

function ensureInert(element: HTMLElement) {
  if (!inertSnapshots.has(element)) {
    inertSnapshots.set(element, {
      inert: element.inert === true,
      inertAttribute: element.getAttribute("inert"),
      ariaHidden: element.getAttribute("aria-hidden"),
    });
  }
  element.inert = true;
  element.setAttribute("inert", "");
  element.setAttribute("aria-hidden", "true");
}

function restoreInert(element: HTMLElement) {
  const snapshot = inertSnapshots.get(element);
  if (!snapshot) return;

  element.inert = snapshot.inert;
  if (snapshot.inertAttribute === null) element.removeAttribute("inert");
  else element.setAttribute("inert", snapshot.inertAttribute);
  if (snapshot.ariaHidden === null) element.removeAttribute("aria-hidden");
  else element.setAttribute("aria-hidden", snapshot.ariaHidden);
  inertSnapshots.delete(element);
}

function canOwnPageInteraction(element: Element): element is HTMLElement {
  return (
    element instanceof HTMLElement &&
    !["SCRIPT", "STYLE", "LINK", "META", "TEMPLATE"].includes(
      element.tagName,
    )
  );
}

function reconcilePageInertness() {
  let resolvedZIndex = 0;
  for (const entry of modalStack) {
    resolvedZIndex = Math.max(entry.requestedZIndex, resolvedZIndex + 1);
    entry.root.style.zIndex = String(resolvedZIndex);
  }

  const topModal = modalStack.at(-1) ?? null;
  const topRoot = topModal?.root ?? null;
  const shouldBeInert = new Set<HTMLElement>();

  if (topRoot) {
    for (const child of Array.from(document.body.children)) {
      if (!canOwnPageInteraction(child)) continue;
      if (child === topRoot || child.contains(topRoot)) continue;
      shouldBeInert.add(child);
    }
  }

  for (const element of Array.from(inertSnapshots.keys())) {
    if (!shouldBeInert.has(element)) restoreInert(element);
  }
  for (const element of shouldBeInert) ensureInert(element);
  // Reconcile transients after body inert snapshots are taken/restored so the
  // transient registry never teaches the body lock that a suppressed state was
  // the element's original state.
  reconcileTransientOverlays(topModal?.layer ?? null);
}

function startBodyObserver() {
  if (bodyObserver) return;
  bodyObserver = new MutationObserver(reconcilePageInertness);
  bodyObserver.observe(document.body, { childList: true });
}

function stopBodyObserver() {
  bodyObserver?.disconnect();
  bodyObserver = null;
}

function registerModal(entry: ModalEntry) {
  const pendingRestoration = restorationFrames.get(entry.id);
  if (pendingRestoration !== undefined) {
    window.cancelAnimationFrame(pendingRestoration);
    restorationFrames.delete(entry.id);
    if (pendingPageRestoration?.entryId === entry.id) {
      pendingPageRestoration = null;
    }
  }

  const firstModal = modalStack.length === 0;
  if (firstModal && pendingPageRestoration) {
    window.cancelAnimationFrame(pendingPageRestoration.frame);
    restorationFrames.delete(pendingPageRestoration.entryId);
    entry.previousFocus = pendingPageRestoration.desiredFocus;
    pendingPageRestoration = null;
  }
  modalStack.push(entry);
  modalStack.sort((left, right) => left.sequence - right.sequence);
  const entryIndex = modalStack.indexOf(entry);

  // React mounts child layout effects before parent effects. When two nested
  // modals first appear together, inherit the already-registered upper entry's
  // restoration target instead of capturing focus from the wrong layer.
  if (entryIndex < modalStack.length - 1) {
    entry.previousFocus = modalStack[entryIndex + 1].previousFocus;
  }

  if (firstModal) {
    acquireBodyLock();
    startBodyObserver();
  }
  reconcilePageInertness();
}

function scheduleFocusRestoration(entry: ModalEntry, wasTopModal: boolean) {
  if (!wasTopModal) return;

  const desiredFocus = entry.previousFocus;
  const frame = window.requestAnimationFrame(() => {
    restorationFrames.delete(entry.id);
    if (pendingPageRestoration?.entryId === entry.id) {
      pendingPageRestoration = null;
    }
    const topModal = modalStack.at(-1);
    if (topModal) {
      if (
        desiredFocus &&
        topModal.root.contains(desiredFocus) &&
        isElementFocusable(desiredFocus, topModal.root)
      ) {
        desiredFocus.focus({ preventScroll: true });
      } else {
        topModal.focusInitial();
      }
      return;
    }

    if (desiredFocus && isElementFocusable(desiredFocus)) {
      desiredFocus.focus({ preventScroll: true });
    }
  });
  restorationFrames.set(entry.id, frame);
  if (modalStack.length === 0) {
    pendingPageRestoration = { entryId: entry.id, desiredFocus, frame };
  }
}

function unregisterModal(entry: ModalEntry) {
  const entryIndex = modalStack.indexOf(entry);
  if (entryIndex < 0) return;
  const wasTopModal = entryIndex === modalStack.length - 1;

  // Preserve the restoration chain if an underlying modal disappears before
  // the modal above it (for example, a parent and child tearing down together).
  for (let index = entryIndex + 1; index < modalStack.length; index += 1) {
    const upperEntry = modalStack[index];
    if (
      upperEntry.previousFocus &&
      entry.root.contains(upperEntry.previousFocus)
    ) {
      upperEntry.previousFocus = entry.previousFocus;
    }
  }

  modalStack.splice(entryIndex, 1);
  if (modalStack.length === 0) {
    stopBodyObserver();
    reconcilePageInertness();
    releaseBodyLock();
  } else {
    reconcilePageInertness();
  }
  scheduleFocusRestoration(entry, wasTopModal);
}

function isTopModal(id: symbol): boolean {
  return modalStack.at(-1)?.id === id;
}

interface ModalLayerProps extends Omit<
  ViewportModalProps,
  "open" | "children" | "className" | "zIndex"
> {
  children: ReactNode;
  className: string;
  zIndex: number;
}

function ModalLayer({
  children,
  className,
  dismissible = true,
  initialFocusRef,
  onDismiss,
  zIndex,
}: ModalLayerProps) {
  const layerRef = useRef<HTMLDivElement>(null);
  const modalIdRef = useRef(Symbol("viewport-modal"));
  const dismissibleRef = useRef(dismissible);
  const onDismissRef = useRef(onDismiss);
  const [sequence] = useState(() => ++nextModalSequence);

  dismissibleRef.current = dismissible;
  onDismissRef.current = onDismiss;

  useLayoutEffect(() => {
    const layer = layerRef.current;
    const root = layer?.closest<HTMLElement>(
      '[data-viewport-overlay-root="true"]',
    );
    if (!layer || !root) return;

    const modalId = modalIdRef.current;
    const focusInitial = () => {
      if (!isTopModal(modalId)) return;
      const requested = initialFocusRef?.current;
      const target =
        requested &&
        layer.contains(requested) &&
        isElementFocusable(requested, layer)
          ? requested
          : getFocusableElements(layer)[0] || layer;
      target.focus({ preventScroll: true });
    };
    const entry: ModalEntry = {
      id: modalId,
      sequence,
      root,
      layer,
      requestedZIndex: zIndex,
      previousFocus:
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null,
      focusInitial,
    };

    registerModal(entry);
    focusInitial();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isTopModal(modalId)) return;
      if (event.key === "Escape") {
        // The transient is the top interaction surface within this modal. Let
        // its later document listener consume Escape before the modal itself.
        if (hasActiveTransientOverlay(layer)) return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        if (dismissibleRef.current) onDismissRef.current("escape");
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = getFocusableElements(layer);
      if (focusable.length === 0) {
        event.preventDefault();
        layer.focus({ preventScroll: true });
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (
        event.shiftKey &&
        (active === first ||
          !(active instanceof Node) ||
          !layer.contains(active))
      ) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (
        !event.shiftKey &&
        (active === last ||
          !(active instanceof Node) ||
          !layer.contains(active))
      ) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    };

    const handleFocusIn = (event: FocusEvent) => {
      if (
        !isTopModal(modalId) ||
        !(event.target instanceof Node) ||
        layer.contains(event.target)
      ) {
        return;
      }
      focusInitial();
    };

    document.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("focusin", handleFocusIn, true);

    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("focusin", handleFocusIn, true);
      unregisterModal(entry);
    };
  }, [initialFocusRef, sequence, zIndex]);

  const stopPortalEvent = (event: SyntheticEvent) => {
    event.stopPropagation();
  };

  const handleModalMouseDown = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (event.currentTarget === event.target) event.preventDefault();
  };

  const handleBackdropClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (event.currentTarget !== event.target) return;
    event.preventDefault();
    if (isTopModal(modalIdRef.current) && dismissibleRef.current) {
      onDismissRef.current("backdrop");
    }
  };

  return (
    <div
      ref={layerRef}
      role="presentation"
      data-viewport-modal-layer="true"
      tabIndex={-1}
      className={`relative flex h-full w-full items-center justify-center overflow-y-auto overscroll-contain ${className}`}
      onPointerDown={stopPortalEvent}
      onPointerMove={stopPortalEvent}
      onPointerUp={stopPortalEvent}
      onPointerCancel={stopPortalEvent}
      onMouseDown={handleModalMouseDown}
      onMouseMove={stopPortalEvent}
      onMouseUp={stopPortalEvent}
      onClick={handleBackdropClick}
      onDoubleClick={stopPortalEvent}
      onContextMenu={stopPortalEvent}
      onKeyDown={stopPortalEvent}
      onKeyUp={stopPortalEvent}
      onKeyPress={stopPortalEvent}
      onWheel={stopPortalEvent}
      onTouchStart={stopPortalEvent}
      onTouchMove={stopPortalEvent}
      onTouchEnd={stopPortalEvent}
      onTouchCancel={stopPortalEvent}
    >
      {children}
    </div>
  );
}

/**
 * Body-owned modal foundation. Consumers keep ownership of their dialog role,
 * accessible labels, sizing, visual surface, and action semantics.
 */
export default function ViewportModal({
  open,
  onDismiss,
  dismissible = true,
  children,
  className = "",
  zIndex = VIEWPORT_MODAL_Z_INDEX,
  initialFocusRef,
}: ViewportModalProps) {
  if (!open) return null;

  return (
    <ViewportOverlay anchor="fill" margin="0px" zIndex={zIndex} blockPage>
      <ModalLayer
        className={className}
        dismissible={dismissible}
        initialFocusRef={initialFocusRef}
        onDismiss={onDismiss}
        zIndex={zIndex}
      >
        {children}
      </ModalLayer>
    </ViewportOverlay>
  );
}
