import { useEffect, useState } from 'react';
import type { PlatformId } from '../../../platforms/types';
import {
  loadMentionMap,
  saveMentionMap,
  type MentionEntry,
  type MentionMap,
} from '../../../storage/mention-map';

const PLATFORMS: { id: PlatformId; label: string }[] = [
  { id: 'x', label: 'X' },
  { id: 'bluesky', label: 'BlueSky' },
  { id: 'mastodon', label: 'Mastodon' },
  { id: 'substack', label: 'Substack' },
  { id: 'linkedin', label: 'LinkedIn' },
];

export function MentionsPage({ onBack }: { onBack: () => void }) {
  const [map, setMap] = useState<MentionMap>([]);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void (async () => {
      setMap(await loadMentionMap());
      setLoaded(true);
    })();
  }, []);

  function updateEntry(idx: number, patch: MentionEntry) {
    setMap((m) => m.map((e, i) => (i === idx ? { ...e, ...patch } : e)));
  }

  function removeEntry(idx: number) {
    setMap((m) => m.filter((_, i) => i !== idx));
  }

  function addEntry() {
    setMap((m) => [...m, {}]);
  }

  async function save() {
    setSaving(true);
    // Trim whitespace and drop empty platform fields so saved entries
    // stay tidy. Entries that end up entirely empty get pruned.
    const cleaned: MentionMap = map
      .map((e) => {
        const out: MentionEntry = {};
        for (const [k, v] of Object.entries(e)) {
          const trimmed = (v ?? '').trim().replace(/^@/, '');
          if (trimmed) out[k as PlatformId] = trimmed;
        }
        return out;
      })
      .filter((e) => Object.keys(e).length > 0);
    await saveMentionMap(cleaned);
    setMap(cleaned);
    setSaving(false);
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-between items-center">
        <h2 className="font-medium">Handle mappings</h2>
        <button
          type="button"
          onClick={onBack}
          className="text-xs text-gray-500 hover:underline"
        >
          ← back
        </button>
      </div>
      <p className="text-xs text-gray-500">
        Map the same person's handle across platforms. When cross-posting,
        @mentions get translated to the destination's handle. Handles you
        don't list here are stripped of their @ on the destination so you
        don't ping a stranger by accident.
      </p>
      {!loaded ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : map.length === 0 ? (
        <p className="text-sm text-gray-500">No mappings yet.</p>
      ) : (
        <ul className="space-y-2">
          {map.map((entry, idx) => (
            <li
              key={idx}
              className="border rounded p-2 space-y-1"
            >
              <div className="flex justify-between items-center">
                <span className="text-xs text-gray-500">person {idx + 1}</span>
                <button
                  type="button"
                  onClick={() => removeEntry(idx)}
                  className="text-red-600 text-xs hover:underline"
                >
                  remove
                </button>
              </div>
              <div className="grid grid-cols-2 gap-1">
                {PLATFORMS.map((p) => (
                  <label key={p.id} className="text-xs">
                    <span className="text-gray-500 mr-1">{p.label}:</span>
                    <input
                      type="text"
                      value={entry[p.id] ?? ''}
                      onChange={(e) => updateEntry(idx, { [p.id]: e.target.value })}
                      placeholder="handle"
                      className="border rounded px-1 py-0.5 text-xs w-28"
                    />
                  </label>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={addEntry}
          className="text-sm text-emerald-700 hover:underline"
        >
          + add person
        </button>
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="ml-auto bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white px-3 py-1 rounded text-sm"
        >
          {saving ? 'saving…' : 'save'}
        </button>
      </div>
    </div>
  );
}
