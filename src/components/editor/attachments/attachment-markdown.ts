import type { Attachment } from '@/lib/database/attachment-database';

export type AttachmentAttrs = {
  id: string;
  kind: 'image' | 'file';
  label: string;
  title: string | null;
  width: number | null;
  align: 'left' | 'center' | 'right' | null;
};

const attachmentDestinationPattern = /^attachment:([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})(?:#(.*))?$/i;

export function readAttachmentAttrs(
  destination: string,
  kind: AttachmentAttrs['kind'],
  label: string,
  title: string | null | undefined,
): AttachmentAttrs | null {
  const match = attachmentDestinationPattern.exec(destination);
  if (!match || (kind === 'file' && match[2] !== undefined)) return null;
  let width: AttachmentAttrs['width'] = null;
  let align: AttachmentAttrs['align'] = null;

  if (match[2] !== undefined) {
    const fragment = new URLSearchParams(match[2]);
    if (Array.from(fragment.keys()).some((key) => key !== 'width' && key !== 'align')
        || fragment.getAll('width').length > 1 || fragment.getAll('align').length > 1) return null;
    const widthParam = fragment.get('width');
    const alignParam = fragment.get('align');
    if (widthParam !== null) {
      if (!/^(?:[1-9][0-9]?|100)$/.test(widthParam)) return null;
      width = Number(widthParam);
    }
    if (alignParam !== null) {
      if (alignParam !== 'left' && alignParam !== 'center' && alignParam !== 'right') return null;
      align = alignParam;
    }
  }

  return { id: match[1].toLowerCase(), kind, label, title: title ?? null, width, align };
}

export function attachmentDestination({ id, width, align }: AttachmentAttrs) {
  const fragment = new URLSearchParams();
  if (width !== null) fragment.set('width', String(width));
  if (align !== null) fragment.set('align', align);
  return `attachment:${id}${fragment.size ? '#' + fragment : ''}`;
}

export function importedAttachmentAttrs(attachment: Attachment): AttachmentAttrs {
  return {
    id: attachment.id,
    kind: attachment.mimeType.startsWith('image/') ? 'image' : 'file',
    label: attachment.originalFilename,
    title: null,
    width: null,
    align: null,
  };
}
