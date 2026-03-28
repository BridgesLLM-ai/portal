/**
 * Debounce utility functions for performance optimization.
 */

/**
 * Creates a debounced function that delays invoking `fn` until after `wait`
 * milliseconds have elapsed since the last time the debounced function was invoked.
 */
export function debounce<T extends (...args: any[]) => any>(
  fn: T,
  wait: number
): (...args: Parameters<T>) => void {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  return function debounced(...args: Parameters<T>) {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
    timeoutId = setTimeout(() => {
      fn(...args);
      timeoutId = null;
    }, wait);
  };
}

/**
 * Creates a debounced function with a leading edge option.
 * When `leading` is true, the function is invoked on the leading edge of the timeout.
 */
export function debounceWithOptions<T extends (...args: any[]) => any>(
  fn: T,
  wait: number,
  options: { leading?: boolean; trailing?: boolean } = {}
): (...args: Parameters<T>) => void {
  const { leading = false, trailing = true } = options;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: Parameters<T> | null = null;
  let shouldInvokeTrailing = false;

  return function debounced(...args: Parameters<T>) {
    lastArgs = args;

    if (timeoutId === null) {
      // First call
      if (leading) {
        fn(...args);
      } else {
        shouldInvokeTrailing = true;
      }

      timeoutId = setTimeout(() => {
        if (trailing && shouldInvokeTrailing && lastArgs) {
          fn(...lastArgs);
        }
        timeoutId = null;
        lastArgs = null;
        shouldInvokeTrailing = false;
      }, wait);
    } else {
      // Subsequent calls within the wait period
      shouldInvokeTrailing = true;
    }
  };
}

/**
 * Creates a throttled function that only invokes `fn` at most once per every `wait` milliseconds.
 */
export function throttle<T extends (...args: any[]) => any>(
  fn: T,
  wait: number
): (...args: Parameters<T>) => void {
  let lastTime = 0;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: Parameters<T> | null = null;

  return function throttled(...args: Parameters<T>) {
    const now = Date.now();

    if (now - lastTime >= wait) {
      // Enough time has passed, invoke immediately
      lastTime = now;
      fn(...args);
    } else {
      // Schedule a trailing call
      lastArgs = args;
      if (timeoutId === null) {
        timeoutId = setTimeout(() => {
          lastTime = Date.now();
          if (lastArgs) {
            fn(...lastArgs);
          }
          timeoutId = null;
          lastArgs = null;
        }, wait - (now - lastTime));
      }
    }
  };
}

/**
 * React hook-friendly debounce that returns a stable reference.
 * Use with useCallback or useMemo.
 */
export function createDebouncedCallback<T extends (...args: any[]) => any>(
  fn: T,
  wait: number
): { debounced: (...args: Parameters<T>) => void; cancel: () => void } {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const debounced = (...args: Parameters<T>) => {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
    timeoutId = setTimeout(() => {
      fn(...args);
      timeoutId = null;
    }, wait);
  };

  const cancel = () => {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  };

  return { debounced, cancel };
}
