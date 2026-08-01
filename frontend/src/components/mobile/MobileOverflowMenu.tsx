import { useState, useRef, useEffect, useId } from 'react';
import { motion } from 'framer-motion';
import { MoreVertical } from 'lucide-react';
import AnchoredPopover from '../AnchoredPopover';

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
  triggerLabel?: string;
}

export default function MobileOverflowMenu({ actions, triggerIcon, triggerClassName, triggerLabel = 'More actions' }: Props) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const focusFrame = requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
    });
    return () => cancelAnimationFrame(focusFrame);
  }, [open]);

  const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'));
    if (items.length === 0) return;
    event.preventDefault();
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? items.length - 1
        : event.key === 'ArrowUp'
          ? (currentIndex <= 0 ? items.length - 1 : currentIndex - 1)
          : (currentIndex + 1) % items.length;
    items[nextIndex]?.focus();
  };

  const variantClasses = (v?: string, active?: boolean) => {
    if (active) return 'accent-active';
    switch (v) {
      case 'danger': return 'text-red-400 hover:bg-red-500/10';
      case 'success': return 'text-emerald-400 hover:bg-emerald-500/10';
      default: return 'text-slate-300 hover:bg-white/5';
    }
  };

  return (
    <div ref={menuRef} className="relative">
      <button
        ref={triggerRef}
        aria-label={triggerLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen(!open)}
        className={triggerClassName || 'p-2 rounded-lg bg-white/5 border border-white/10 text-slate-400 hover:text-white transition-colors min-w-[44px] min-h-[44px] flex items-center justify-center'}
      >
        {triggerIcon || <MoreVertical size={18} />}
      </button>

      <AnchoredPopover
        open={open}
        anchorRef={triggerRef}
        width={224}
        mobileBreakpoint={767}
        zIndex={1500}
        ariaLabel={triggerLabel}
        onDismiss={(reason) => {
          setOpen(false);
          if (reason === 'escape') requestAnimationFrame(() => triggerRef.current?.focus());
        }}
      >
        <motion.div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={triggerLabel}
          onKeyDown={handleMenuKeyDown}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.15 }}
          className="max-h-full w-full overflow-auto rounded-2xl border border-white/10 bg-[#0D1130]/98 shadow-2xl backdrop-blur-2xl"
        >
          <div className="flex justify-center pt-3 pb-1 md:hidden" aria-hidden="true">
            <div className="w-10 h-1 rounded-full bg-white/20" />
          </div>
          <div className="py-1 px-1">
            {actions.map((action, i) => (
              <button
                key={i}
                role="menuitem"
                aria-current={action.active ? 'true' : undefined}
                onClick={() => {
                  if (!action.disabled) {
                    action.onClick();
                    setOpen(false);
                    requestAnimationFrame(() => triggerRef.current?.focus());
                  }
                }}
                disabled={action.disabled}
                className={`w-full flex items-center gap-3 px-4 py-3 md:py-2.5 text-sm md:text-xs rounded-xl md:rounded-lg transition-colors ${variantClasses(action.variant, action.active)} ${action.disabled ? 'opacity-30' : ''}`}
              >
                {action.icon && <span className="flex-shrink-0">{action.icon}</span>}
                <span>{action.label}</span>
                {action.active && <span className="accent-fill ml-auto w-1.5 h-1.5 rounded-full" />}
              </button>
            ))}
          </div>
        </motion.div>
      </AnchoredPopover>
    </div>
  );
}
