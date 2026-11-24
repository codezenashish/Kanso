import { useState, type FormEvent } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { NoteProperty } from '@/lib/workspace-tree';

type NotePropertiesProps = {
  properties: NoteProperty[];
  onChange: (properties: NoteProperty[]) => void;
};

const inputClass = 'h-8 min-w-0 rounded-md border border-sidebar-border bg-background px-2 text-sm focus-visible:outline-2 focus-visible:outline-sidebar-ring';

export function NoteProperties({ properties, onChange }: NotePropertiesProps) {
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
      {properties.length === 0 && <p className="text-sm text-muted-foreground">No properties yet.</p>}
      {properties.map((property) => (
        <div key={property.name}>
          <label className="block wrap-anywhere text-xs font-medium">
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
          className={`w-full ${inputClass}`}
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
