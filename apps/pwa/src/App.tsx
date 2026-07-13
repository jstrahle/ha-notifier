import { useEffect, useState } from 'react';
import { api, type Me } from './lib/api.js';
import { isIosNeedsInstall, pushSupported } from './lib/push.js';
import { Login } from './pages/Login.js';
import { Onboarding } from './pages/Onboarding.js';
import { Inbox } from './pages/Inbox.js';
import { Settings } from './pages/Settings.js';

type Tab = 'inbox' | 'settings';

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [checked, setChecked] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [tab, setTab] = useState<Tab>('inbox');

  useEffect(() => {
    api
      .me()
      .then((m) => {
        setMe(m);
        // Prompt onboarding if push isn't set up yet on a capable device.
        if (pushSupported() || isIosNeedsInstall()) {
          const dismissed = sessionStorage.getItem('onboardingDismissed');
          if (!dismissed && Notification.permission !== 'granted') {
            setShowOnboarding(true);
          }
        }
      })
      .catch(() => setMe(null))
      .finally(() => setChecked(true));
  }, []);

  if (!checked) return <div className="p-6 text-sm text-neutral-500">Loading…</div>;
  if (!me) return <Login onLogin={setMe} />;

  if (showOnboarding) {
    return (
      <Onboarding
        onDone={() => {
          sessionStorage.setItem('onboardingDismissed', '1');
          setShowOnboarding(false);
        }}
      />
    );
  }

  return (
    <div className="min-h-screen pb-16">
      {tab === 'inbox' ? <Inbox /> : <Settings me={me} onProfileUpdated={setMe} />}
      <nav className="fixed inset-x-0 bottom-0 flex border-t border-neutral-200 bg-white">
        <TabButton active={tab === 'inbox'} onClick={() => setTab('inbox')}>
          Inbox
        </TabButton>
        <TabButton active={tab === 'settings'} onClick={() => setTab('settings')}>
          Settings
        </TabButton>
      </nav>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 py-3 text-sm font-medium ${
        active ? 'text-indigo-600' : 'text-neutral-500'
      }`}
    >
      {children}
    </button>
  );
}
