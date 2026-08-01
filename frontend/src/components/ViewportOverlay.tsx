import { CSSProperties, ReactNode, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';

type ViewportAnchor = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left' | 'center' | 'fill';

interface ViewportRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface ViewportOverlayProps {
  children: ReactNode;
  anchor?: ViewportAnchor;
  className?: string;
  zIndex?: number;
  margin?: string;
  /**
   * Keep false for notification/toast stacks so the invisible layer never blocks the app.
   * Interactive descendants are still clickable because the content wrapper uses pointer-events:auto.
   */
  blockPage?: boolean;
}

function getViewportRect(): ViewportRect {
  if (typeof window === 'undefined') {
    return { left: 0, top: 0, width: 0, height: 0 };
  }

  const visualViewport = window.visualViewport;
  if (visualViewport) {
    return {
      left: visualViewport.offsetLeft,
      top: visualViewport.offsetTop,
      width: visualViewport.width,
      height: visualViewport.height,
    };
  }

  return {
    left: 0,
    top: 0,
    width: window.innerWidth,
    height: window.innerHeight,
  };
}

function useVisualViewportRect() {
  const [rect, setRect] = useState<ViewportRect>(() => getViewportRect());

  useLayoutEffect(() => {
    let frame = 0;
    const update = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => setRect(getViewportRect()));
    };

    update();
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    window.visualViewport?.addEventListener('resize', update);
    window.visualViewport?.addEventListener('scroll', update);

    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
      window.visualViewport?.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('scroll', update);
    };
  }, []);

  return rect;
}

function anchorStyle(anchor: ViewportAnchor, margin: string): CSSProperties {
  const safeTop = `max(${margin}, env(safe-area-inset-top, 0px))`;
  const safeRight = `max(${margin}, env(safe-area-inset-right, 0px))`;
  const safeBottom = `max(${margin}, env(safe-area-inset-bottom, 0px))`;
  const safeLeft = `max(${margin}, env(safe-area-inset-left, 0px))`;

  switch (anchor) {
    case 'top-left':
      return { top: safeTop, left: safeLeft, maxWidth: `calc(100% - (${safeLeft}) - (${safeRight}))`, maxHeight: `calc(100% - (${safeTop}) - (${safeBottom}))` };
    case 'top-right':
      return { top: safeTop, right: safeRight, maxWidth: `calc(100% - (${safeLeft}) - (${safeRight}))`, maxHeight: `calc(100% - (${safeTop}) - (${safeBottom}))` };
    case 'bottom-left':
      return { bottom: safeBottom, left: safeLeft, maxWidth: `calc(100% - (${safeLeft}) - (${safeRight}))`, maxHeight: `calc(100% - (${safeTop}) - (${safeBottom}))` };
    case 'center':
      return { top: '50%', left: '50%', transform: 'translate(-50%, -50%)', maxWidth: `calc(100% - (${safeLeft}) - (${safeRight}))`, maxHeight: `calc(100% - (${safeTop}) - (${safeBottom}))` };
    case 'fill':
      return { inset: 0 };
    case 'bottom-right':
    default:
      return { bottom: safeBottom, right: safeRight, maxWidth: `calc(100% - (${safeLeft}) - (${safeRight}))`, maxHeight: `calc(100% - (${safeTop}) - (${safeBottom}))` };
  }
}

/**
 * Viewport-owned overlay layer for toasts, progress cards, and other ambient UI.
 *
 * Why this exists: `position: fixed` is not reliable when rendered under page nodes
 * that animate/transform/contain/scroll. Portaling to `document.body` and anchoring
 * against the visual viewport keeps notifications attached to the visible glass,
 * not to whichever page component happened to create them.
 */
export default function ViewportOverlay({
  children,
  anchor = 'bottom-right',
  className = '',
  zIndex = 1000,
  margin = '1rem',
  blockPage = false,
}: ViewportOverlayProps) {
  const rect = useVisualViewportRect();

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      data-viewport-overlay-root="true"
      style={{
        position: 'fixed',
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        zIndex,
        pointerEvents: blockPage ? 'auto' : 'none',
        overflow: 'hidden',
      }}
    >
      <div
        data-viewport-overlay-anchor={anchor}
        className={`absolute pointer-events-auto ${className}`}
        style={anchorStyle(anchor, margin)}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
