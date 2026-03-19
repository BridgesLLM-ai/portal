import { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { MoreVertical, X } from 'lucide-react';

export interface MenuAction {
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
  variant?: 'default' | 'danger' | 'success';
  disabled?: boolean;
  active?: boolean;
}

interface Props {
  actions: MenuAction[];
  triggerIcon?: React.ReactNode;
  triggerClassName?: string;
}

export default function MobileOverflowMenu({ actions, triggerIcon, triggerClassName }: Props) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent | TouchEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('touchstart', handler);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('touchstart', handler);
    };
  }, [open]);

  const variantClasses = (v?: string, active?: boolean) => {
    if (active) return 'bg-emerald-500/10 text-emerald-400';
    switch (v) {
      case 'danger': return 'text-red-400 hover:bg-red-500/10';
      case 'success': return 'text-emerald-400 hover:bg-emerald-500/10';
      default: return 'text-slate-300 hover:bg-white/5';
    }
  };

  return (
    <div ref={menuRef} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className={triggerClassName || 'p-2 rounded-lg bg-white/5 border border-white/10 text-slate-400 hover:text-white transition-colors min-w-[44px] min-h-[44px] flex items-center justify-center'}
      >
        {triggerIcon || <MoreVertical size={18} />}
      </button>

      <AnimatePresence>
        {open && (
          <>
            {/* Backdrop for mobile */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-[90] md:hidden"
              onClick={() => setOpen(false)}
            />
            {/* Menu as bottom sheet on mobile, dropdown on desktop */}
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              transition={{ duration: 0.15 }}
              className="
                fixed bottom-0 left-0 right-0 z-[100] md:absolute md:bottom-auto md:left-auto md:right-0 md:top-full md:mt-1
                bg-[#0D1130]/98 backdrop-blur-2xl border-t md:border border-white/10 md:rounded-xl
                rounded-t-2xl md:rounded-2xl shadow-2xl md:w-56 md:max-h-[60vh]
                max-h-[70vh] overflow-auto
                pb-safe
              "
              style={{ paddingBottom: 'max(env(safe-area-inset-bottom, 0px), 12px)' }}
            >
              {/* Drag handle on mobile */}
              <div className="flex justify-center pt-3 pb-1 md:hidden">
                <div className="w-10 h-1 rounded-full bg-white/20" />
              </div>
              <div className="py-1 px-1">
                {actions.map((action, i) => (
                  <button
                    key={i}
                    onClick={() => {
                      if (!action.disabled) {
                        action.onClick();
                        setOpen(false);
                      }
                    }}
                    disabled={action.disabled}
                    className={`w-full flex items-center gap-3 px-4 py-3 md:py-2.5 text-sm md:text-xs rounded-xl md:rounded-lg transition-colors ${variantClasses(action.variant, action.active)} ${action.disabled ? 'opacity-30' : ''}`}
                  >
                    {action.icon && <span className="flex-shrink-0">{action.icon}</span>}
                    <span>{action.label}</span>
                    {action.active && <span className="ml-auto w-1.5 h-1.5 rounded-full bg-emerald-400" />}
                  </button>
                ))}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
