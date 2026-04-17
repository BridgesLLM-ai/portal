import { Download, FileQuestion } from 'lucide-react';

export default function ProjectBinaryViewer({ name, src }: { name: string; src: string }) {
  return (
    <div className="flex-1 flex items-center justify-center text-slate-500">
      <div className="text-center">
        <FileQuestion size={48} className="mx-auto mb-3 opacity-30" />
        <p className="text-sm font-medium text-slate-300 mb-1">{name}</p>
        <p className="text-xs mb-4">Binary file, cannot be previewed</p>
        <a href={src} download className="px-4 py-2 rounded-lg bg-emerald-500/20 text-emerald-300 text-sm hover:bg-emerald-500/30 inline-flex items-center gap-2">
          <Download size={14} /> Download
        </a>
      </div>
    </div>
  );
}
