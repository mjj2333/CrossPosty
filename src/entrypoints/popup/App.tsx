import { useState } from 'react';
import type { PlatformId } from '../../platforms/types';
import { AccountsPage } from './pages/Accounts';
import { AddAccountPage } from './pages/AddAccount';
import { MentionsPage } from './pages/Mentions';
import { PhonePairingPage } from './pages/PhonePairing';

type AddableId = PlatformId;

export type View =
  | { name: 'accounts' }
  | { name: 'add'; platformId: AddableId }
  | { name: 'mentions' }
  | { name: 'phone-pairing' };

export function App() {
  const [view, setView] = useState<View>({ name: 'accounts' });
  return (
    <div className="w-[400px] min-h-[500px] p-4 font-sans">
      <div className="flex justify-between items-center mb-4">
        <h1 className="text-xl font-semibold">CrossPosty</h1>
        {view.name === 'accounts' && (
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => setView({ name: 'phone-pairing' })}
              className="text-xs text-gray-500 hover:underline"
            >
              phone pairing
            </button>
            <button
              type="button"
              onClick={() => setView({ name: 'mentions' })}
              className="text-xs text-gray-500 hover:underline"
            >
              handle mappings
            </button>
          </div>
        )}
      </div>
      {view.name === 'accounts' ? (
        <AccountsPage onAdd={(platformId) => setView({ name: 'add', platformId })} />
      ) : view.name === 'add' ? (
        <AddAccountPage
          platformId={view.platformId}
          onDone={() => setView({ name: 'accounts' })}
        />
      ) : view.name === 'mentions' ? (
        <MentionsPage onBack={() => setView({ name: 'accounts' })} />
      ) : (
        <PhonePairingPage onBack={() => setView({ name: 'accounts' })} />
      )}
    </div>
  );
}
