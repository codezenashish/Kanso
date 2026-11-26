import { useId, useState, type FormEvent } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { Frontmatter } from '@/lib/note-frontmatter';
import type { NoteProperty, WorkspaceNode } from '@/lib/workspace-tree';
import { isTagsProperty, readNoteTagState, tagKey, validTagName } from '@/lib/note-tags';

type NotePropertiesProps = {
  note: WorkspaceNode;
  frontmatter: Frontmatter | null;
  onChange: (properties: NoteProperty[]) => void;
  tagNames: string[];
  onChangeTags: (tags: string[]) => boolean;
};

const inputClass = 'h-8 min-w-0 rounded-md border border-input bg-background px-2 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-sidebar-ring';

export function NoteProperties({ note, frontmatter, onChange, tagNames, onChangeTags }: NotePropertiesProps) {
  const properties = note.properties ?? [];
  const yamlProperties = frontmatter?.properties ?? [];
  const { tags, yaml } = readNoteTagState(note);
  const tagEditingBlocked = yaml.kind === 'blocked';
  const optionsId = useId();
  const [tagInput, setTagInput] = useState('');
  const [propertyName, setPropertyName] = useState('');
  const trimmedName = propertyName.trim();
  const tagProperty = tagKey(trimmedName) === 'tags';
  const duplicateName = tagProperty || properties.some((property) => property.name.toLowerCase() === trimmedName.toLowerCase());
  const usedTags = new Set(tags.map(tagKey));
  const canAddTag = !tagEditingBlocked && validTagName(tagInput) && !usedTags.has(tagKey(tagInput));

  function addTag(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (canAddTag && onChangeTags([...tags, tagInput])) setTagInput('');
  }

  function addProperty(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!trimmedName || duplicateName) return;
    onChange([...properties, { name: trimmedName, value: '' }]);
    setPropertyName('');
  }

  return (
    <div className="space-y-3">
      {frontmatter?.invalid && <p className="text-sm text-muted-foreground" role="status">Edit invalid YAML frontmatter in Source Mode.</p>}
      {yamlProperties.length > 0 && (
        <section aria-label="YAML frontmatter">
          <h3 className="mb-2 text-xs font-medium text-muted-foreground">Frontmatter</h3>
          <dl className="space-y-2">
            {yamlProperties.map(({ name, value }, index) => (
              <div key={index} className="wrap-anywhere">
                <dt className="text-xs font-medium">{name}</dt>
                <dd className="whitespace-pre-wrap text-sm">{value}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      <section aria-label="Note tags" className="space-y-2">
        <h3 className="text-xs font-medium text-muted-foreground">Tags</h3>
        {!!tags.length && <ul className="flex flex-wrap gap-1">
          {tags.map((tag) => (
            <li key={tagKey(tag)} className="flex max-w-full items-center gap-0.5 rounded-md border border-border px-1 text-xs">
              <span className="truncate" title={tag}>{tag}</span>
              <Button type="button" size="icon-xs" variant="ghost" aria-label={`Remove tag ${tag}`}
                disabled={tagEditingBlocked} onClick={() => onChangeTags(tags.filter((value) => tagKey(value) !== tagKey(tag)))}>
                <Trash2 aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>}
        {tagEditingBlocked ? <p className="text-xs text-muted-foreground">Edit these YAML tags in Source Mode.</p> : (
          <form className="flex items-center gap-1" onSubmit={addTag}>
            <input aria-label="Add note tag" placeholder="Add tag" list={optionsId} className={`flex-1 ${inputClass}`}
              value={tagInput} onChange={(event) => setTagInput(event.target.value)} />
            <datalist id={optionsId}>
              {tagNames.filter((name) => !usedTags.has(tagKey(name))).map((name) => <option key={tagKey(name)} value={name} />)}
            </datalist>
            <Button type="submit" size="icon-xs" variant="ghost" aria-label="Add tag to note" disabled={!canAddTag}>
              <Plus aria-hidden="true" />
            </Button>
          </form>
        )}
      </section>
      {!properties.length && !yamlProperties.length && !frontmatter?.invalid
        && <p className="text-sm text-muted-foreground">No properties yet.</p>}
      {properties.filter((property) => !isTagsProperty(property)).map((property) => (
        <div key={property.name} className="flex items-end gap-1">
          <label className="block min-w-0 flex-1 wrap-anywhere text-xs font-medium">
            {property.name}
            <input
              className={`mt-1 block w-full ${inputClass}`}
              value={property.value}
              onChange={(event) => onChange(properties.map((entry) => (
                entry.name === property.name ? { ...entry, value: event.target.value } : entry
              )))}
            />
          </label>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Remove ${property.name}`}
            title={`Remove ${property.name}`}
            onClick={() => onChange(properties.filter((entry) => entry.name !== property.name))}
          >
            <Trash2 />
          </Button>
        </div>
      ))}
      <form className="flex items-center gap-1" onSubmit={addProperty}>
        <input
          className={`flex-1 ${inputClass}`}
          aria-label="Property name"
          aria-invalid={duplicateName}
          placeholder="Property name"
          value={propertyName}
          onChange={(event) => setPropertyName(event.target.value)}
        />
        <Button type="submit" variant="ghost" size="icon" title="Add property" aria-label="Add property" disabled={!trimmedName || duplicateName}>
          <Plus />
        </Button>
      </form>
      {duplicateName && <p role="status" className="text-xs text-destructive">{tagProperty ? 'Use the tag field above.' : 'This property already exists.'}</p>}
    </div>
  );
}
