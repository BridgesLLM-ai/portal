import type { SlashCommand } from '../../utils/slashCommands';

interface SlashCommandMenuProps {
  commands: SlashCommand[];
  selectedIndex: number;
  onSelect: (command: SlashCommand) => void;
}

export default function SlashCommandMenu({ commands, selectedIndex, onSelect }: SlashCommandMenuProps) {
  if (!commands.length) return null;

  return (
    <div className="absolute left-0 right-0 bottom-full mb-2 max-w-[480px] rounded-xl border border-white/[0.10] bg-[#0d1230]/[0.97] backdrop-blur-xl shadow-2xl shadow-black/50 overflow-hidden z-20">
      <div className="max-h-[320px] overflow-y-auto overscroll-contain py-1">
        {commands.map((cmd, index) => {
          const active = index === selectedIndex;
          return (
            <button
              key={cmd.command}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                onSelect(cmd);
              }}
              className={`group w-full px-3 py-2 text-left transition-all duration-100 ${
                active
                  ? 'bg-emerald-500/[0.12] border-l-2 border-emerald-400'
                  : 'hover:bg-white/[0.04] border-l-2 border-transparent'
              }`}
            >
              <div className="flex items-center gap-2">
                <span className={`text-[13px] font-mono tracking-tight ${active ? 'text-emerald-200' : 'text-slate-200 group-hover:text-slate-100'}`}>
                  {cmd.command}
                </span>
                {cmd.argsHint && (
                  <span className="text-[10px] font-mono text-slate-600 truncate">{cmd.argsHint}</span>
                )}
                <span className="ml-auto text-[10px] text-slate-500">{cmd.category}</span>
              </div>
              <div className={`text-[11px] mt-0.5 ${active ? 'text-slate-300' : 'text-slate-500'}`}>
                {cmd.description}
              </div>
            </button>
          );
        })}
      </div>
      <div className="px-3 py-1.5 border-t border-white/[0.06] bg-white/[0.02] text-[10px] text-slate-600 flex flex-wrap items-center gap-x-4 gap-y-1">
        <span>↑↓ navigate</span>
        <span>enter select</span>
        <span>esc dismiss</span>
      </div>
    </div>
  );
}
