import { motion, AnimatePresence } from 'framer-motion';
import { X, Keyboard } from 'lucide-react';
import { GLOBAL_SHORTCUTS, formatShortcut } from '../hooks/useKeyboardShortcuts';

interface KeyboardShortcutsHelpProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function KeyboardShortcutsHelp({ isOpen, onClose }: KeyboardShortcutsHelpProps) {
  if (!isOpen) return null;

  const categories = [
    { key: 'general', label: 'General' },
    { key: 'editor', label: 'Code Editor' },
    { key: 'fileTree', label: 'File Tree' },
    { key: 'terminal', label: 'Terminal' },
  ];

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
        onClick={onClose}
      >
        <motion.div
          initial={{ scale: 0.95, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.95, opacity: 0 }}
          transition={{ type: 'spring', damping: 25, stiffness: 300 }}
          className="w-full max-w-3xl bg-[#0A0E27]/95 border border-white/10 rounded-2xl shadow-2xl overflow-hidden backdrop-blur-2xl"
          onClick={e => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-white/5">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-xl bg-emerald-500/10 border border-emerald-500/20">
                <Keyboard size={20} className="text-emerald-400" />
              </div>
              <div>
                <h2 className="text-lg font-bold text-white">Keyboard Shortcuts</h2>
                <p className="text-xs text-slate-500">Master the Portal like a pro</p>
              </div>
            </div>
            <button
              onClick={onClose}
              className="p-2 rounded-lg hover:bg-white/5 text-slate-500 hover:text-white transition-colors"
              aria-label="Close"
            >
              <X size={20} />
            </button>
          </div>

          {/* Content */}
          <div className="max-h-[70vh] overflow-auto p-6">
            <div className="grid md:grid-cols-2 gap-6">
              {categories.map(({ key, label }) => (
                <div key={key}>
                  <h3 className="text-sm font-bold text-emerald-400 uppercase tracking-wider mb-3">
                    {label}
                  </h3>
                  <div className="space-y-2">
                    {GLOBAL_SHORTCUTS[key]?.map((shortcut, index) => (
                      <div
                        key={index}
                        className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg bg-white/5 hover:bg-white/10 transition-colors"
                      >
                        <span className="text-sm text-slate-300">
                          {shortcut.description}
                        </span>
                        <kbd className="px-2 py-1 rounded bg-slate-800 border border-slate-700 text-xs font-mono text-emerald-400 whitespace-nowrap">
                          {formatShortcut(shortcut)}
                        </kbd>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            {/* Pro tips */}
            <div className="mt-8 p-4 rounded-xl bg-emerald-500/5 border border-emerald-500/20">
              <h4 className="text-sm font-bold text-emerald-400 mb-2">💡 Pro Tips</h4>
              <ul className="space-y-1 text-xs text-slate-400">
                <li>• Press <kbd className="px-1 py-0.5 rounded bg-slate-800 text-emerald-400">Shift ?</kbd> anytime to show this help</li>
                <li>• Most actions support both mouse and keyboard</li>
                <li>• Touch gestures available on mobile (swipe, long press, pinch)</li>
                <li>• Tab key navigates between interactive elements</li>
              </ul>
            </div>
          </div>

          {/* Footer */}
          <div className="px-6 py-3 border-t border-white/5 flex items-center justify-between text-xs text-slate-600">
            <span>Press ESC to close</span>
            <span>Shortcuts reflect the controls currently available in this build.</span>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
