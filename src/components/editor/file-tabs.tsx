import { FileText, X } from 'lucide-react';
import { cn } from '@/lib/utils';

type FileTabsProps = {
  files: { id: string; name: string }[];
  activeId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
};

export function FileTabs({ files, activeId, onSelect, onClose }: FileTabsProps) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [&::-webkit-scrollbar]:hidden" role="group" aria-label="Open files">
      {files.map((file) => (
        <div
          key={file.id}
          className={cn(
            'flex h-9 max-w-55 shrink-0 items-center gap-1 rounded-md border px-1.5 text-sm',
            activeId === file.id ? 'border-border bg-background text-foreground' : 'border-transparent text-muted-foreground hover:bg-accent hover:text-accent-foreground',
          )}
        >
          <button
            className="flex h-full min-w-0 cursor-pointer items-center gap-1.5 rounded-sm px-1 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
            aria-current={activeId === file.id}
            onClick={() => onSelect(file.id)}
          >
            <FileText className="size-4 shrink-0" />
            <span className="truncate">{file.name}</span>
          </button>
          <button
            className="grid size-6 shrink-0 cursor-pointer place-items-center rounded-sm focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring hover:bg-accent hover:text-accent-foreground"
            aria-label={`Close ${file.name}`}
            title={`Close ${file.name}`}
            onClick={() => onClose(file.id)}
          >
            <X className="size-4" />
          </button>
        </div>
      ))}
    </div>
  );
}
