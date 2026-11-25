import { useState, type FormEvent } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { Frontmatter } from '@/lib/note-frontmatter';
import type { NoteProperty } from '@/lib/workspace-tree';

type NotePropertiesProps = {
  properties: NoteProperty[];
  frontmatter: Frontmatter | null;
  onChange: (properties: NoteProperty[]) => void;
};

const inputClass = 'h-8 min-w-0 rounded-md border border-input bg-background px-2 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-sidebar-ring';

export function NoteProperties({ properties, frontmatter, onChange }: NotePropertiesProps) {
  const yamlProperties = frontmatter?.properties ?? [];
  const [propertyName, setPropertyName] = useState('');
  const trimmedName = propertyName.trim();
  const duplicateName = properties.some((property) => property.name.toLowerCase() === trimmedName.toLowerCase());

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
      {!properties.length && !yamlProperties.length && !frontmatter?.invalid
        && <p className="text-sm text-muted-foreground">No properties yet.</p>}
      {properties.map((property) => (
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
      {duplicateName && <p role="status" className="text-xs text-destructive">This property already exists.</p>}
    </div>
  );
}
