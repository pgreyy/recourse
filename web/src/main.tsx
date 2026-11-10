import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { Link, useLocation } from './lib';
import { Operator } from './screens/Operator';
import { Buyer } from './screens/Buyer';
import { AgentRun } from './screens/AgentRun';
import { Home } from './screens/Home';
import { Judges } from './screens/Judges';
import './styles.css';

// AG Studio and AG Grid are large: load them only when the console opens.
const Console = lazy(() => import('./console/Console').then((m) => ({ default: m.Console })));

const NAV = [
  { to: '/operator', step: '1', label: 'Operator' },
  { to: '/buyer', step: '2', label: 'Buyer' },
  { to: '/agent', step: '3', label: 'Agent run' },
  { to: '/console', step: '4', label: 'Recourse console' },
];

function Mark() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="6" fill="#0b4f4a" />
      <path d="M10 23V9h7a4.5 4.5 0 0 1 0 9h-7m7 0 5 5" stroke="#fff" strokeWidth="2.6" fill="none" />
    </svg>
  );
}

function App() {
  const { path } = useLocation();
  const section = '/' + (path.split('/')[1] ?? '');
  const screen =
    section === '/operator' ? <Operator /> : section === '/buyer' ? <Buyer /> : section === '/agent' ? <AgentRun /> : section === '/judges' ? <Judges /> : section === '/console' ? (
      <Suspense fallback={<p className="loading">Loading the console…</p>}>
        <Console />
      </Suspense>
    ) : <Home />;
  return (
    <div className="shell">
      <header className="topbar">
        <Link to="/" className="brand">
          <Mark />
          Recourse
        </Link>
        <nav className="topnav" aria-label="Screens">
          {NAV.map((n) => (
            <Link key={n.to} to={n.to} current={section === n.to}>
              <span className="step" aria-hidden="true">
                {n.step}
              </span>
              <span className="label">{n.label}</span>
            </Link>
          ))}
        </nav>
        <Link to="/judges" className="judges-link" current={section === '/judges'}>
          For judges
        </Link>
        <span className="sandbox" title="Every PayPal call goes to the PayPal sandbox. No real money moves.">
          PayPal sandbox
        </span>
      </header>
      {screen}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
