import {
  cloneElement,
  isValidElement,
  type CSSProperties,
  type ReactNode,
  type RefObject,
  type SyntheticEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import ViewportModal, {
  VIEWPORT_TRANSIENT_Z_INDEX,
  findViewportModalOwner,
  registerViewportTransientOverlay,
  type ViewportModalDismissReason,
} from './ViewportModal';

type PopoverAlignment = 'start' | 'end';
type PopoverPlacement = 'top' | 'bottom';

interface ViewportRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface AnchorRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface AnchoredPopoverLayout {
  mode: 'anchored' | 'sheet';
  placement: PopoverPlacement;
  left: number;
  top?: number;
  bottom?: number;
  width: number;
  maxHeight: number;
}

interface ComputeAnchoredPopoverLayoutInput {
  anchor: AnchorRect;
  viewport: ViewportRect;
  requestedWidth: number;
  align: PopoverAlignment;
  gap: number;
  margin: number;
  mobileBreakpoint: number;
  preferredMinimumHeight: number;
}

interface AnchoredPopoverProps {
  open: boolean;
  anchorRef: RefObject<HTMLElement>;
  children: ReactNode;
  onDismiss: (reason: 'escape' | 'outside') => void;
  width?: number;
  align?: PopoverAlignment;
  gap?: number;
  margin?: number;
  mobileBreakpoint?: number;
  preferredMinimumHeight?: number;
  zIndex?: number;
  className?: string;
  /** Accessible name used by the modal bottom-sheet wrapper on narrow screens. */
  ariaLabel?: string;
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (maximum < minimum) return minimum;
  return Math.min(Math.max(value, minimum), maximum);
}

export function computeAnchoredPopoverLayout({
  anchor,
  viewport,
  requestedWidth,
  align,
  gap,
  margin,
  mobileBreakpoint,
  preferredMinimumHeight,
}: ComputeAnchoredPopoverLayoutInput): AnchoredPopoverLayout {
  const viewportWidth = Math.max(0, viewport.width);
  const viewportHeight = Math.max(0, viewport.height);
  const availableWidth = Math.max(0, viewportWidth - (margin * 2));
  const width = Math.min(Math.max(0, requestedWidth), availableWidth);

  if (viewportWidth <= mobileBreakpoint) {
    return {
      mode: 'sheet',
      placement: 'bottom',
      left: margin,
      bottom: margin,
      width,
      maxHeight: Math.max(0, viewportHeight - (margin * 2)),
    };
  }

  const viewportTop = viewport.top;
  const viewportBottom = viewport.top + viewportHeight;
  const visibleAnchorTop = clamp(
    anchor.top,
    viewportTop + margin,
    viewportBottom - margin,
  );
  const visibleAnchorBottom = clamp(
    anchor.bottom,
    viewportTop + margin,
    viewportBottom - margin,
  );
  const below = Math.max(0, viewportBottom - visibleAnchorBottom - gap - margin);
  const above = Math.max(0, visibleAnchorTop - viewportTop - gap - margin);
  const placement: PopoverPlacement = below >= preferredMinimumHeight || below >= above
    ? 'bottom'
    : 'top';
  const desiredLeft = align === 'start' ? anchor.left : anchor.right - width;
  const absoluteLeft = clamp(
    desiredLeft,
    viewport.left + margin,
    viewport.left + viewportWidth - margin - width,
  );

  if (placement === 'top') {
    return {
      mode: 'anchored',
      placement,
      left: absoluteLeft - viewport.left,
      bottom: viewportHeight - (visibleAnchorTop - viewport.top) + gap,
      width,
      maxHeight: above,
    };
  }

  return {
    mode: 'anchored',
    placement,
    left: absoluteLeft - viewport.left,
    top: visibleAnchorBottom - viewport.top + gap,
    width,
    maxHeight: below,
  };
}

function visualViewportRect(): ViewportRect {
  const visualViewport = window.visualViewport;
  if (visualViewport) {
    return {
      left: visualViewport.offsetLeft,
      top: visualViewport.offsetTop,
      width: visualViewport.width,
      height: visualViewport.height,
    };
  }
  return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
}

export default function AnchoredPopover({
  open,
  anchorRef,
  children,
  onDismiss,
  width = 352,
  align = 'end',
  gap = 8,
  margin = 8,
  mobileBreakpoint = 639,
  preferredMinimumHeight = 240,
  zIndex = VIEWPORT_TRANSIENT_Z_INDEX,
  className = '',
  ariaLabel = 'Options',
}: AnchoredPopoverProps) {
  const [layout, setLayout] = useState<AnchoredPopoverLayout | null>(null);
  const [viewport, setViewport] = useState<ViewportRect | null>(null);
  const [contentElement, setContentElement] = useState<HTMLDivElement | null>(null);
  const [modalOwner, setModalOwner] = useState<HTMLElement | null>(null);
  const transientRootRef = useRef<HTMLDivElement>(null);

  const updateLayout = useCallback(() => {
    const anchor = anchorRef.current;
    if (!open || !anchor) return;
    const nextViewport = visualViewportRect();
    const anchorBox = anchor.getBoundingClientRect();
    setViewport(nextViewport);
    setModalOwner(findViewportModalOwner(anchor));
    setLayout(computeAnchoredPopoverLayout({
      anchor: anchorBox,
      viewport: nextViewport,
      requestedWidth: width,
      align,
      gap,
      margin,
      mobileBreakpoint,
      preferredMinimumHeight,
    }));
  }, [align, anchorRef, gap, margin, mobileBreakpoint, open, preferredMinimumHeight, width]);

  useLayoutEffect(() => {
    if (!open) {
      setLayout(null);
      setViewport(null);
      setModalOwner(null);
      return undefined;
    }
    updateLayout();
    window.addEventListener('resize', updateLayout);
    window.addEventListener('orientationchange', updateLayout);
    window.addEventListener('scroll', updateLayout, true);
    window.visualViewport?.addEventListener('resize', updateLayout);
    window.visualViewport?.addEventListener('scroll', updateLayout);
    return () => {
      window.removeEventListener('resize', updateLayout);
      window.removeEventListener('orientationchange', updateLayout);
      window.removeEventListener('scroll', updateLayout, true);
      window.visualViewport?.removeEventListener('resize', updateLayout);
      window.visualViewport?.removeEventListener('scroll', updateLayout);
    };
  }, [open, updateLayout]);

  useEffect(() => {
    if (!open || layout?.mode === 'sheet') return undefined;
    const isSuppressed = () => (
      transientRootRef.current?.getAttribute('data-viewport-transient-suppressed') === 'true'
    );
    const isOutside = (target: Node) => (
      !anchorRef.current?.contains(target) && !contentElement?.contains(target)
    );
    const handlePointerDown = (event: PointerEvent) => {
      if (isSuppressed()) return;
      const target = event.target as Node;
      if (!isOutside(target)) return;
      // Keep the underlying control from taking focus before the completed
      // click is consumed by the transient interaction layer.
      event.preventDefault();
    };
    const handleClick = (event: MouseEvent) => {
      if (isSuppressed()) return;
      const target = event.target as Node;
      if (!isOutside(target)) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      onDismiss('outside');
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isSuppressed()) return;
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      onDismiss('escape');
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('click', handleClick, true);
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('click', handleClick, true);
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [anchorRef, contentElement, layout?.mode, onDismiss, open]);

  useLayoutEffect(() => {
    const root = transientRootRef.current;
    if (!open || layout?.mode !== 'anchored' || !root) return undefined;
    return registerViewportTransientOverlay(root, modalOwner);
  }, [layout?.mode, modalOwner, open]);

  if (!open || !layout || !viewport || typeof document === 'undefined') return null;

  const anchoredContentStyle: CSSProperties = {
    left: layout.left,
    top: layout.top,
    bottom: layout.bottom,
    width: layout.width,
    maxHeight: layout.maxHeight,
    // Flex column makes the capped used height a definite size for children.
    // A child's percentage max-height resolves to none against height:auto, so
    // without this, oversized menus are clipped instead of becoming scrollable
    // and wheel input chains into the surface behind the popover.
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'stretch',
    overflow: 'hidden',
    overscrollBehavior: 'contain',
    pointerEvents: 'auto',
  };

  const safeTop = `max(${margin}px, env(safe-area-inset-top, 0px))`;
  const safeRight = `max(${margin}px, env(safe-area-inset-right, 0px))`;
  const safeBottom = `max(${margin}px, env(safe-area-inset-bottom, 0px))`;
  const safeLeft = `max(${margin}px, env(safe-area-inset-left, 0px))`;
  const sheetContentStyle: CSSProperties = {
    left: '50%',
    bottom: safeBottom,
    width: `min(${layout.width}px, calc(100% - (${safeLeft}) - (${safeRight})))`,
    maxHeight: `calc(100% - (${safeTop}) - (${safeBottom}))`,
    transform: 'translateX(-50%)',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'stretch',
    overflow: 'hidden',
    overscrollBehavior: 'contain',
    pointerEvents: 'auto',
  };

  const stopPortalEvent = (event: SyntheticEvent) => {
    event.stopPropagation();
  };

  if (layout.mode === 'sheet') {
    const handleModalDismiss = (reason?: ViewportModalDismissReason) => {
      onDismiss(reason === 'escape' ? 'escape' : 'outside');
    };
    const childOwnsModalRole = isValidElement<{
      role?: string;
      'aria-modal'?: boolean;
    }>(children) && ['dialog', 'alertdialog'].includes(children.props.role || '');
    const sheetChildren = childOwnsModalRole
      ? cloneElement(children, { 'aria-modal': true })
      : children;

    return (
      <ViewportModal
        open
        onDismiss={handleModalDismiss}
        zIndex={zIndex}
        className="relative"
      >
        <div
          aria-hidden="true"
          data-anchored-popover-backdrop="true"
          className="absolute inset-0 bg-black/60 backdrop-blur-[1px]"
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onDismiss('outside');
          }}
        />
        <div
          ref={setContentElement}
          data-anchored-popover-root="true"
          data-anchored-popover-mode="sheet"
          data-anchored-popover-placement={layout.placement}
          role={childOwnsModalRole ? undefined : 'dialog'}
          aria-modal={childOwnsModalRole ? undefined : 'true'}
          aria-label={childOwnsModalRole ? undefined : ariaLabel}
          className={`absolute ${className}`}
          style={sheetContentStyle}
        >
          {sheetChildren}
        </div>
      </ViewportModal>
    );
  }

  return createPortal(
    <div
      ref={transientRootRef}
      role="presentation"
      data-anchored-popover-root="true"
      style={{
        position: 'fixed',
        left: viewport.left,
        top: viewport.top,
        width: viewport.width,
        height: viewport.height,
        zIndex,
        pointerEvents: 'none',
        overflow: 'hidden',
      }}
      onPointerDown={stopPortalEvent}
      onPointerMove={stopPortalEvent}
      onPointerUp={stopPortalEvent}
      onPointerCancel={stopPortalEvent}
      onMouseDown={stopPortalEvent}
      onMouseMove={stopPortalEvent}
      onMouseUp={stopPortalEvent}
      onClick={stopPortalEvent}
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
      <div
        ref={setContentElement}
        data-anchored-popover-mode={layout.mode}
        data-anchored-popover-placement={layout.placement}
        className={`absolute ${className}`}
        style={anchoredContentStyle}
      >
        {children}
      </div>
    </div>,
    modalOwner || document.body,
  );
}
