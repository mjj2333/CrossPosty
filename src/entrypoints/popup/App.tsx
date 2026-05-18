import { useState } from 'react';
import type { PlatformId } from '../../platforms/types';
import { AccountsPage } from './pages/Accounts';
import { AddAccountPage } from './pages/AddAccount';

type AddableId = PlatformId;

export type View = { name: 'accounts' } | { name: 'add'; platformId: AddableId };

export function App() {
  const [view, setView] = useState<View>({ name: 'accounts' });
  return (
    <div className="w-[400px] min-h-[500px] p-4 font-sans">
      <h1 className="text-xl font-semibold mb-4">CrossPosty</h1>
      {view.name === 'accounts' ? (
        <AccountsPage onAdd={(platformId) => setView({ name: 'add', platformId })} />
      ) : (
        <AddAccountPage
          platformId={view.platformId}
          onDone={() => setView({ name: 'accounts' })}
        />
      )}
    </div>
  );
}
