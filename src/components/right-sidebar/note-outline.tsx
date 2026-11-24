import { useState } from 'react';
import { Hash } from 'lucide-react';
import type { NoteHeading } from '@/lib/note-markdown';
import { cn } from '@/lib/utils';

type NoteOutlineProps = {
  headings: NoteHeading[];
  onNavigate: (offset: number) => void;
};

type HeadingListProps = NoteOutlineProps & { selectedOffset: number; nested?: boolean };

function HeadingList({ headings, selectedOffset, nested, onNavigate }: HeadingListProps) {
  return (
    <ul className={cn('space-y-0.5', nested && 'ms-1.5 border-s border-sidebar-border ps-1')}>
      {headings.map((heading) => (
        <li key={heading.offset}>
          <button
            type="button"
            aria-current={selectedOffset === heading.offset ? 'location' : undefined}
            className="flex min-h-7 w-full cursor-pointer items-center gap-1.5 rounded-sm border-s-2 border-transparent px-1.5 py-1 text-start text-sm hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-sidebar-ring aria-current:border-sidebar-primary aria-current:bg-sidebar-accent aria-current:text-sidebar-accent-foreground"
            onClick={() => onNavigate(heading.offset)}
          >
            <Hash aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
            <span className="min-w-0 wrap-anywhere">{heading.title || 'Untitled heading'}</span>
          </button>
          {heading.children.length > 0 && (
            <HeadingList headings={heading.children} selectedOffset={selectedOffset} nested onNavigate={onNavigate} />
          )}
        </li>
      ))}
    </ul>
  );
}

export function NoteOutline({ headings, onNavigate }: NoteOutlineProps) {
  const [selectedOffset, setSelectedOffset] = useState<number>();
  if (!headings.length) return <p className="text-sm text-muted-foreground">No headings in this note.</p>;

  return (
    <HeadingList
      headings={headings}
      selectedOffset={selectedOffset ?? headings[0].offset}
      onNavigate={(offset) => {
        setSelectedOffset(offset);
        onNavigate(offset);
      }}
    />
  );
}
