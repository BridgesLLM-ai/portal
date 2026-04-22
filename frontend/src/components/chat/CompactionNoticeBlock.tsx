import { motion } from 'framer-motion';
import { CheckCircle2, Layers3, Loader2 } from 'lucide-react';

import { isCompactionNotice } from '../../utils/toolPresentation';

interface CompactionNoticeBlockProps {
  content: string;
  size?: 'default' | 'compact';
}

const COMPACTION_ACTIVE_RE = /\b(compacting context|auto-compaction|context compaction|compaction (?:in progress|started)|preparing context maintenance|preparing compaction|context maintenance in progress)\b/i;
const COMPACTION_COMPLETE_RE = /\b(context compacted|compaction (?:complete(?:d)?|finished))\b/i;

function getCompactionIcon(content: string) {
  if (COMPACTION_COMPLETE_RE.test(content)) {
    return {
      icon: <CheckCircle2 size={11} className="text-sky-300" />,
      badgeClass: 'border-sky-300/20 bg-sky-300/10',
    };
  }

  if (COMPACTION_ACTIVE_RE.test(content)) {
    return {
      icon: <Loader2 size={11} className="animate-spin text-sky-300" />,
      badgeClass: 'border-sky-300/20 bg-sky-300/10',
    };
  }

  return {
    icon: <Layers3 size={11} className="text-sky-300" />,
    badgeClass: 'border-sky-300/20 bg-sky-300/10',
  };
}

export default function CompactionNoticeBlock({ content, size = 'default' }: CompactionNoticeBlockProps) {
  if (!isCompactionNotice(content)) return null;

  const icon = getCompactionIcon(content);
  const outerSpacing = size === 'compact' ? 'px-3 py-1.5' : 'px-4 py-2';
  const pillSpacing = size === 'compact' ? 'px-3 py-1.5 text-[10px]' : 'px-4 py-2 text-[11px]';
  const maxWidth = size === 'compact' ? 'max-w-[90%]' : 'max-w-xl';

  return (
    <motion.div
      initial={{ opacity: 0, y: -2 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -2 }}
      transition={{ duration: 0.16 }}
      className={`flex justify-center ${outerSpacing} max-w-3xl mx-auto w-full`}
    >
      <div className="flex items-center gap-3 w-full">
        <span className="h-px flex-1 bg-sky-400/10" />
        <div
          className={`inline-flex ${maxWidth} items-center gap-2 rounded-full border border-sky-400/20 bg-sky-500/10 ${pillSpacing} text-center text-sky-100 whitespace-pre-wrap shadow-lg shadow-sky-500/5`}
        >
          <span className={`inline-flex h-5 w-5 items-center justify-center rounded-full border ${icon.badgeClass}`}>
            {icon.icon}
          </span>
          <span className="leading-relaxed">{content}</span>
        </div>
        <span className="h-px flex-1 bg-sky-400/10" />
      </div>
    </motion.div>
  );
}
