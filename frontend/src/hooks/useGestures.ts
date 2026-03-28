import { useEffect, useRef, RefObject } from 'react';

export interface GestureConfig {
  onSwipeLeft?: () => void;
  onSwipeRight?: () => void;
  onSwipeUp?: () => void;
  onSwipeDown?: () => void;
  onLongPress?: (e: TouchEvent) => void;
  onPinch?: (scale: number) => void;
  onTwoFingerTap?: () => void;
  threshold?: number; // Min distance for swipe (default 50px)
  longPressDelay?: number; // ms for long press (default 500)
}

export function useGestures(
  ref: RefObject<HTMLElement>,
  config: GestureConfig,
  enabled = true
) {
  const touchStartRef = useRef<{ x: number; y: number; time: number } | null>(null);
  const longPressTimerRef = useRef<NodeJS.Timeout | null>(null);
  const initialPinchDistanceRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled || !ref.current) return;

    const element = ref.current;
    const threshold = config.threshold || 50;
    const longPressDelay = config.longPressDelay || 500;

    const handleTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 1) {
        // Single touch
        const touch = e.touches[0];
        touchStartRef.current = {
          x: touch.clientX,
          y: touch.clientY,
          time: Date.now(),
        };

        // Start long press timer
        if (config.onLongPress) {
          longPressTimerRef.current = setTimeout(() => {
            if (touchStartRef.current) {
              config.onLongPress?.(e);
              touchStartRef.current = null; // Prevent swipe after long press
            }
          }, longPressDelay);
        }
      } else if (e.touches.length === 2) {
        // Two-finger gesture
        cancelLongPress();

        // Check for two-finger tap (both touches start at same time)
        if (config.onTwoFingerTap) {
          const delay = setTimeout(() => {
            if (e.touches.length === 2) {
              config.onTwoFingerTap?.();
            }
          }, 200);
          setTimeout(() => clearTimeout(delay), 300);
        }

        // Initialize pinch
        if (config.onPinch) {
          const touch1 = e.touches[0];
          const touch2 = e.touches[1];
          const distance = Math.hypot(
            touch2.clientX - touch1.clientX,
            touch2.clientY - touch1.clientY
          );
          initialPinchDistanceRef.current = distance;
        }
      }
    };

    const handleTouchMove = (e: TouchEvent) => {
      cancelLongPress();

      if (e.touches.length === 2 && config.onPinch && initialPinchDistanceRef.current) {
        // Pinch gesture
        const touch1 = e.touches[0];
        const touch2 = e.touches[1];
        const distance = Math.hypot(
          touch2.clientX - touch1.clientX,
          touch2.clientY - touch1.clientY
        );
        const scale = distance / initialPinchDistanceRef.current;
        config.onPinch(scale);
      }
    };

    const handleTouchEnd = (e: TouchEvent) => {
      cancelLongPress();

      if (initialPinchDistanceRef.current) {
        initialPinchDistanceRef.current = null;
        return;
      }

      if (!touchStartRef.current || e.changedTouches.length === 0) return;

      const touch = e.changedTouches[0];
      const deltaX = touch.clientX - touchStartRef.current.x;
      const deltaY = touch.clientY - touchStartRef.current.y;
      const deltaTime = Date.now() - touchStartRef.current.time;

      // Swipe must be fast (< 300ms) and significant distance
      if (deltaTime < 300) {
        if (Math.abs(deltaX) > threshold && Math.abs(deltaX) > Math.abs(deltaY)) {
          // Horizontal swipe
          if (deltaX > 0) {
            config.onSwipeRight?.();
          } else {
            config.onSwipeLeft?.();
          }
        } else if (Math.abs(deltaY) > threshold && Math.abs(deltaY) > Math.abs(deltaX)) {
          // Vertical swipe
          if (deltaY > 0) {
            config.onSwipeDown?.();
          } else {
            config.onSwipeUp?.();
          }
        }
      }

      touchStartRef.current = null;
    };

    const cancelLongPress = () => {
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
      }
    };

    element.addEventListener('touchstart', handleTouchStart);
    element.addEventListener('touchmove', handleTouchMove);
    element.addEventListener('touchend', handleTouchEnd);
    element.addEventListener('touchcancel', cancelLongPress);

    return () => {
      element.removeEventListener('touchstart', handleTouchStart);
      element.removeEventListener('touchmove', handleTouchMove);
      element.removeEventListener('touchend', handleTouchEnd);
      element.removeEventListener('touchcancel', cancelLongPress);
      cancelLongPress();
    };
  }, [ref, config, enabled]);
}

// Haptic feedback helper (for devices that support it)
export function triggerHaptic(style: 'light' | 'medium' | 'heavy' = 'light') {
  if ('vibrate' in navigator) {
    const patterns = {
      light: [10],
      medium: [20],
      heavy: [30],
    };
    navigator.vibrate(patterns[style]);
  }
}
