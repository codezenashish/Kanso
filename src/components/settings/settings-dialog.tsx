import { useId, useRef, useState, type ReactNode } from 'react';
import { AlertDialog } from '@base-ui/react/alert-dialog';
import { Dialog } from '@base-ui/react/dialog';
import { Archive, History, Info, Keyboard, Palette, Search, Settings as SettingsIcon, SlidersHorizontal, Type, X } from 'lucide-react';
import { editorLayouts } from '@/components/editor/editor-layout';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { editorFontSizeRange, editorLineHeightRange, updateSettings, useSettings, type Settings } from '@/lib/settings';
import { HistorySettings } from '@/components/history/history-settings';
import { AttachmentSettings, type AttachmentSettingsProps } from './attachment-settings';
import { workspaceShortcutLabel, workspaceShortcuts } from '@/lib/workspace-commands';
import { version } from '../../../package.json';

const backdrop = 'fixed inset-0 z-30 bg-black/45';
const popup = 'fixed top-1/2 left-1/2 z-30 -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-background text-foreground shadow-xl';
const field = 'min-h-9 rounded-md border border-input bg-background px-2.5 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring';

type Option<Value extends string> = { id: Value; label: string };
type PreferenceRow = { label: string; description?: string; control?: (id: string, descriptionId?: string) => ReactNode };
type SettingsDialogProps = AttachmentSettingsProps & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChangeEditorView: (view: Settings['editorView']) => void;
  onResetPreferences: () => void;
};
type SettingsSection = { title: string; icon: typeof SettingsIcon; rows: PreferenceRow[]; content?: ReactNode; };

function PreferenceSelect<Value extends string>({
  id, descriptionId, value, options, onChange,
}: {
  id: string;
  descriptionId?: string;
  value: Value;
  options: readonly Option<Value>[];
  onChange: (value: Value) => void;
}) {
  return <Select id={id} aria-describedby={descriptionId} className="w-full sm:w-38" value={value}
    options={options.map(({ id: optionValue, label }) => ({ value: optionValue, label }))}
    onValueChange={(selected) => { const option = options.find(({ id: optionId }) => optionId === selected); if (option) onChange(option.id); }} />;
}

function numericOptions(value: number | null, min: number, max: number, scale: number, unit: string) {
  const values = new Set(Array.from({ length: Math.round((max - min) * scale) + 1 }, (_, index) => (Math.round(min * scale) + index) / scale));
  if (value !== null) values.add(value);
  return [...values].sort((first, second) => first - second).map((step) => ({ id: String(step), label: `${step}${unit}` }));
}

function ResetPreferences({ onResetPreferences }: Pick<SettingsDialogProps, 'onResetPreferences'>) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  return (
    <AlertDialog.Root>
      <AlertDialog.Trigger render={<Button variant="outline" />}>Reset to defaults</AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className={backdrop} />
        <AlertDialog.Popup initialFocus={cancelRef} className={`${popup} w-[min(25rem,calc(100%-1.5rem))] p-5`}>
          <AlertDialog.Title className="text-base font-semibold">Reset preferences?</AlertDialog.Title>
          <AlertDialog.Description className="mt-2 text-sm text-muted-foreground">
            Restore the default theme, editor preferences, and note sidebar settings. Your notes and open tabs are kept.
          </AlertDialog.Description>
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <AlertDialog.Close render={<Button ref={cancelRef} variant="outline" />}>Cancel</AlertDialog.Close>
            <AlertDialog.Close render={<Button onClick={onResetPreferences} />}>Reset preferences</AlertDialog.Close>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

function SettingsRow({ row }: { row: PreferenceRow }) {
  const id = useId();
  const descriptionId = row.description ? `${id}-description` : undefined;
  return (
    <div className="grid gap-2 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-4">
      <div className="min-w-0">
        {row.control
          ? <label className="text-sm font-medium" htmlFor={id}>{row.label}</label>
          : <p className="text-sm font-medium">{row.label}</p>}
        {row.description && <p id={descriptionId} className="mt-1 text-sm text-muted-foreground">{row.description}</p>}
      </div>
      {row.control?.(id, descriptionId)}
    </div>
  );
}

function SettingsContent({ onChangeEditorView, onResetPreferences, attachmentBusy, onAttachmentBusyChange, ...attachmentSettings }: Omit<SettingsDialogProps, 'open' | 'onOpenChange'> & {
  attachmentBusy: boolean;
  onAttachmentBusyChange: (busy: boolean) => void;
}) {
  const settings = useSettings();
  const searchRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [currentSection, setCurrentSection] = useState('General');
  const [query, setQuery] = useState('');

  const sections: SettingsSection[] = [
    {
      title: 'General', icon: SlidersHorizontal, rows: [
        { label: 'Editor mode', description: 'Choose the mode for Markdown notes.', control: (id, descriptionId) => (
          <PreferenceSelect id={id} descriptionId={descriptionId} value={settings.editorView} options={[
            { id: 'source', label: 'Source' }, { id: 'document', label: 'Visual' },
          ]} onChange={onChangeEditorView} />
        ) },
      ],
    },
    {
      title: 'Appearance', icon: Palette, rows: [
        { label: 'Theme', description: 'Choose light, dark, or your system appearance.', control: (id, descriptionId) => (
          <PreferenceSelect id={id} descriptionId={descriptionId} value={settings.theme} options={[
            { id: 'system', label: 'System' }, { id: 'light', label: 'Light' }, { id: 'dark', label: 'Dark' },
          ]} onChange={(theme) => updateSettings({ theme })} />
        ) },
      ],
    },
    {
      title: 'Editor', icon: Type, rows: [
        { label: 'Editor font', description: 'Typeface for note content.', control: (id, descriptionId) => (
          <PreferenceSelect id={id} descriptionId={descriptionId} value={settings.editorFont} options={[
            { id: 'sans', label: 'Sans serif' }, { id: 'serif', label: 'Serif' }, { id: 'mono', label: 'Monospace' },
          ]} onChange={(editorFont) => updateSettings({ editorFont })} />
        ) },
        { label: 'Font size', description: 'Base text size in Source and Visual modes.', control: (id, descriptionId) => (
          <PreferenceSelect id={id} descriptionId={descriptionId} value={String(settings.editorFontSize)}
            options={numericOptions(settings.editorFontSize, editorFontSizeRange.min, editorFontSizeRange.max, 1, ' px')}
            onChange={(value) => updateSettings({ editorFontSize: Number(value) })} />
        ) },
        { label: 'Line height', description: 'Spacing between lines of text.', control: (id, descriptionId) => (
          <PreferenceSelect id={id} descriptionId={descriptionId} value={settings.editorLineHeight === null ? 'default' : String(settings.editorLineHeight)}
            options={[{ id: 'default', label: 'Mode default' }, ...numericOptions(settings.editorLineHeight, editorLineHeightRange.min, editorLineHeightRange.max, 10, '')]}
            onChange={(value) => updateSettings({ editorLineHeight: value === 'default' ? null : Number(value) })} />
        ) },
        { label: 'Content width', description: 'Maximum writing width for Markdown notes.', control: (id, descriptionId) => (
          <PreferenceSelect id={id} descriptionId={descriptionId} value={settings.editorLayout} options={editorLayouts}
            onChange={(editorLayout) => updateSettings({ editorLayout })} />
        ) },
        { label: 'Code block line numbers', description: 'Show line numbers in newly created and reopened code blocks.', control: (id, descriptionId) => (
          <PreferenceSelect id={id} descriptionId={descriptionId} value={String(settings.codeBlockLineNumbers)} options={[
            { id: 'false', label: 'Hidden' }, { id: 'true', label: 'Shown' },
          ]} onChange={(value) => updateSettings({ codeBlockLineNumbers: value === 'true' })} />
        ) },
        { label: 'Code block word wrap', description: 'Wrap long lines in newly created and reopened code blocks.', control: (id, descriptionId) => (
          <PreferenceSelect id={id} descriptionId={descriptionId} value={String(settings.codeBlockWordWrap)} options={[
            { id: 'false', label: 'Off' }, { id: 'true', label: 'On' },
          ]} onChange={(value) => updateSettings({ codeBlockWordWrap: value === 'true' })} />
        ) },
      ],
    },
    {
      title: 'Keyboard Shortcuts', icon: Keyboard, rows: [
        { label: 'Command palette', description: workspaceShortcutLabel(workspaceShortcuts.palette) },
        { label: 'New note', description: workspaceShortcutLabel(workspaceShortcuts.newNote) },
        { label: 'Search notes', description: workspaceShortcutLabel(workspaceShortcuts.search) },
        { label: 'Save workspace', description: workspaceShortcutLabel(workspaceShortcuts.save) },
        { label: 'Focus mode shortcut', description: 'Toggle distraction-free writing.', control: (id, descriptionId) => (
          <PreferenceSelect id={id} descriptionId={descriptionId} value={settings.focusModeShortcut} options={[
            { id: 'mod-shift-f', label: `${workspaceShortcutLabel('shift+f')}` },
            { id: 'mod-shift-z', label: `${workspaceShortcutLabel('shift+z')}` },
            { id: 'off', label: 'Off' },
          ]} onChange={(focusModeShortcut) => updateSettings({ focusModeShortcut })} />
        ) },
      ],
    },
    {
      title: 'Files & Attachments', icon: Archive,
      rows: [{ label: 'Attachment storage', description: 'Managed location, file limit, storage usage, cleanup, export, and restore.' }],
      content: <AttachmentSettings {...attachmentSettings} onBusyChange={onAttachmentBusyChange} />,
    },
    {
      title: 'Version History', icon: History,
      rows: [{ label: 'Note versions', description: 'Automatic snapshots, snapshot interval, and retention limits.' }],
      content: <HistorySettings />,
    },
    {
      title: 'About', icon: Info, rows: [
        { label: 'Kanso', description: `Version ${version} · Local Markdown workspace` },
      ],
    },
  ];

  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const searching = terms.length > 0;
  const visibleSections = searching
    ? sections.map((section) => ({
        ...section,
        rows: section.rows.filter((row) => {
          const text = `${section.title} ${row.label} ${row.description ?? ''}`.toLowerCase();
          return terms.every((term) => text.includes(term));
        }),
      })).filter((section) => section.rows.length > 0)
    : sections.filter((section) => section.title === currentSection);

  return (
    <Dialog.Popup
      initialFocus={(interaction) => interaction === 'touch' ? true : searchRef.current}
      className={`${popup} flex h-[min(34rem,calc(100dvh-1.5rem))] w-[min(45rem,calc(100%-1.5rem))] flex-col overflow-hidden`}
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && ['k', 'n'].includes(event.key.toLowerCase())) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
    >
      <header className="flex items-center gap-2 border-b border-border px-4 py-3 sm:gap-4 sm:px-5">
        <Dialog.Title className="text-lg font-semibold sm:flex-1">Settings</Dialog.Title>
        <div className="relative min-w-0 flex-1 sm:max-w-60">
          <Search aria-hidden="true" className="pointer-events-none absolute inset-s-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input ref={searchRef} readOnly={attachmentBusy} type="search" aria-label="Search settings" placeholder="Search settings"
            className={`${field} w-full ps-8`} value={query} onChange={(event) => {
              setQuery(event.target.value);
              if (contentRef.current) contentRef.current.scrollTop = 0;
            }} />
        </div>
        <Dialog.Close render={<Button variant="ghost" size="icon" disabled={attachmentBusy} aria-label="Close settings" title="Close settings" />}>
          <X aria-hidden="true" />
        </Dialog.Close>
      </header>
      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        <nav aria-label="Settings sections" className="flex shrink-0 gap-1 overflow-x-auto border-b border-border bg-sidebar p-2.5 text-sidebar-foreground sm:w-46 sm:flex-col sm:overflow-y-auto sm:border-e sm:border-b-0">
          {sections.map(({ title, icon: Icon }) => (
            <Button key={title} disabled={attachmentBusy} variant="ghost" className="justify-start text-start aria-current:bg-sidebar-accent aria-current:text-sidebar-accent-foreground"
              aria-current={!searching && title === currentSection ? 'true' : undefined}
              onClick={() => {
                setCurrentSection(title);
                setQuery('');
                if (contentRef.current) contentRef.current.scrollTop = 0;
              }}>
              <Icon aria-hidden="true" />
              {title}
            </Button>
          ))}
        </nav>
        <div ref={contentRef} className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6 sm:py-5">
          {searching && <p role="status" className="mb-4 text-sm text-muted-foreground">
            {visibleSections.length === 0 ? 'No settings found.' : `${visibleSections.reduce((count, section) => count + section.rows.length, 0)} matching results`}
          </p>}
          {visibleSections.map(({ title, rows, content }) => (
            <section key={title} aria-label={title} className="mb-4 last:mb-0">
              <h2 className="border-b border-border pb-2 text-base font-semibold">{title}</h2>
              {content ?? <div className="divide-y divide-border">
                {rows.map((row) => <SettingsRow key={row.label} row={row} />)}
              </div>}
            </section>
          ))}
        </div>
      </div>
      <footer className="flex shrink-0 justify-between gap-2 border-t border-border bg-sidebar px-4 py-3 sm:px-5">
        {!attachmentBusy && <ResetPreferences onResetPreferences={onResetPreferences} />}
        <Dialog.Close render={<Button disabled={attachmentBusy} />}>Done</Dialog.Close>
      </footer>
    </Dialog.Popup>
  );
}

export function SettingsDialog({ open, onOpenChange, ...props }: SettingsDialogProps) {
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  return (
    <Dialog.Root open={open} onOpenChange={(nextOpen, details) => {
      if (!nextOpen && attachmentBusy) details.cancel();
      else onOpenChange(nextOpen);
    }}>
      <Dialog.Trigger render={<Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label="Settings" title="Settings" />}>
        <SettingsIcon aria-hidden="true" />
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className={backdrop} />
        <SettingsContent {...props} attachmentBusy={attachmentBusy} onAttachmentBusyChange={setAttachmentBusy} />
      </Dialog.Portal>
    </Dialog.Root>
  );
}
