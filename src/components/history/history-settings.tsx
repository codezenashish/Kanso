import { useEffect, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { getVersionHistoryConfig, historyErrorMessage, updateVersionHistoryConfig, type HistoryConfig } from '@/lib/database/history-database';

const field = 'h-9 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-ring sm:w-32';

export function HistorySettings() {
  const [stored, setStored] = useState<HistoryConfig>();
  const [enabled, setEnabled] = useState(true);
  const [seconds, setSeconds] = useState('');
  const [count, setCount] = useState('');
  const [days, setDays] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [request, setRequest] = useState(0);

  function show(config: HistoryConfig) {
    setStored(config);
    setEnabled(config.enabled);
    setSeconds(String(config.snapshotIntervalMs / 1_000));
    setCount(String(config.maxVersionsPerNote));
    setDays(config.maxAgeDays?.toString() ?? '');
  }

  useEffect(() => {
    let current = true;
    void getVersionHistoryConfig().then(
      (config) => { if (current) show(config); },
      (error) => { if (current) setMessage(historyErrorMessage(error)); },
    );
    return () => { current = false; };
  }, [request]);

  const config = {
    enabled,
    snapshotIntervalMs: Math.round(Number(seconds) * 1_000),
    maxVersionsPerNote: Number(count),
    maxAgeDays: days === '' ? null : Number(days),
  };
  const valid = seconds !== '' && Number.isSafeInteger(config.snapshotIntervalMs) && config.snapshotIntervalMs >= 0
    && Number.isSafeInteger(config.maxVersionsPerNote) && config.maxVersionsPerNote >= 1
    && (config.maxAgeDays === null || (Number.isSafeInteger(config.maxAgeDays) && config.maxAgeDays >= 1));
  const changed = stored && (stored.enabled !== config.enabled || stored.snapshotIntervalMs !== config.snapshotIntervalMs
    || stored.maxVersionsPerNote !== config.maxVersionsPerNote || stored.maxAgeDays !== config.maxAgeDays);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!valid || !changed || busy) return;
    setBusy(true);
    setMessage('');
    try {
      show(await updateVersionHistoryConfig(config));
      setMessage('Version history settings saved.');
    } catch (error) {
      setMessage(historyErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  if (!stored) {
    return (
      <div className="space-y-2 py-4">
        <p role="status" className="text-sm text-muted-foreground">{message || 'Loading version history settings…'}</p>
        {message && <Button variant="outline" onClick={() => { setMessage(''); setRequest((value) => value + 1); }}>Retry</Button>}
      </div>
    );
  }

  return (
    <form onSubmit={(event) => void save(event)} className="space-y-4 py-4 text-sm">
      <fieldset disabled={busy} className="space-y-4">
        <label className="flex gap-2 font-medium">
          <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)}
            className="size-4 accent-primary focus-visible:outline-2 focus-visible:outline-ring" aria-describedby="history-enabled-help" />
          Automatic snapshots
        </label>
        <p id="history-enabled-help" className="text-muted-foreground">Turning this off keeps existing versions and stops automatic snapshots.</p>
        <label className="grid gap-2 border-t border-border pt-3 sm:grid-cols-[minmax(0,1fr)_auto]">
          <span><span className="block font-medium">Snapshot interval in seconds</span>
            <span className="text-muted-foreground">Minimum time between changed snapshots. Use 0 for every eligible save.</span></span>
          <input type="number" required min={0} step={0.001} value={seconds} onChange={(event) => setSeconds(event.target.value)} className={field} />
        </label>
        <label className="grid gap-2 border-t border-border pt-3 sm:grid-cols-[minmax(0,1fr)_auto]">
          <span><span className="block font-medium">Versions per note</span>
            <span className="text-muted-foreground">Maximum number of stored versions per note.</span></span>
          <input type="number" required min={1} step={1} value={count} onChange={(event) => setCount(event.target.value)} className={field} />
        </label>
        <label className="grid gap-2 border-t border-border pt-3 sm:grid-cols-[minmax(0,1fr)_auto]">
          <span><span className="block font-medium">Maximum age in days</span>
            <span className="text-muted-foreground">Leave blank to keep versions regardless of age.</span></span>
          <input type="number" min={1} step={1} value={days} onChange={(event) => setDays(event.target.value)} className={field} />
        </label>
      </fieldset>
      <p className="text-muted-foreground">New retention limits apply when a snapshot is saved.</p>
      <Button type="submit" disabled={!changed || !valid || busy}>Save history settings</Button>
      <p role="status" className="text-muted-foreground">{busy ? 'Saving history settings…' : message}</p>
    </form>
  );
}
