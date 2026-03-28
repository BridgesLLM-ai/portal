import { useState, useCallback } from 'react';
import type { ToastType, ToastProps } from '../components/Toast';

let toastId = 0;

export interface ToastOptions {
  detail?: string;
  hint?: string;
  duration?: number;
}

export function useToast() {
  const [toasts, setToasts] = useState<ToastProps[]>([]);

  const showToast = useCallback((type: ToastType, message: string, options?: ToastOptions | number) => {
    const id = `toast-${++toastId}`;
    // Support old signature: showToast('error', 'msg', 5000)
    const opts: ToastOptions = typeof options === 'number' ? { duration: options } : (options || {});
    const toast: ToastProps = {
      id,
      type,
      message,
      detail: opts.detail,
      hint: opts.hint,
      duration: opts.duration || (type === 'error' ? 15000 : 3000),
      onClose: (id) => setToasts((prev) => prev.filter((t) => t.id !== id)),
    };
    setToasts((prev) => [...prev, toast]);
  }, []);

  const success = useCallback((message: string, options?: ToastOptions | number) => {
    showToast('success', message, options);
  }, [showToast]);

  const error = useCallback((message: string, options?: ToastOptions | number) => {
    showToast('error', message, options);
  }, [showToast]);

  const warning = useCallback((message: string, options?: ToastOptions | number) => {
    showToast('warning', message, options);
  }, [showToast]);

  const info = useCallback((message: string, options?: ToastOptions | number) => {
    showToast('info', message, options);
  }, [showToast]);

  const closeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return {
    toasts,
    success,
    error,
    warning,
    info,
    closeToast,
  };
}
