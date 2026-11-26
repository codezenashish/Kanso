export type WorkspaceCommand = {
  id: string;
  label: string;
  keywords?: string;
  shortcut?: string;
  available?: () => boolean;
  run: () => void;
};

export const workspaceShortcuts = {
  palette: 'p',
  search: 'k',
  newNote: 'n',
  save: 's',
} as const;

export function workspaceShortcutLabel(key: string) {
  const modifier = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';
  return modifier + key.toUpperCase();
}

export function matchWorkspaceShortcut(event: KeyboardEvent) {
  if (event.defaultPrevented || event.isComposing || event.altKey || event.shiftKey || (!event.ctrlKey && !event.metaKey)) return null;
  return event.key.toLowerCase();
}

export function executeWorkspaceCommand(command: WorkspaceCommand) {
  if (command.available && !command.available()) return false;
  command.run();
  return true;
}
