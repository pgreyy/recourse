import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { useLocation } from './lib';
import { Operator } from './screens/Operator';
import { OperatorDecision } from './screens/OperatorDecision';
import { Buyer } from './screens/Buyer';
import { AgentRun } from './screens/AgentRun';
import { Home } from './screens/Home';
import { Judges } from './screens/Judges';
import { Shell } from './shell';
import './styles.css';

// AG Studio and AG Grid are large: load them only when the console opens.
const Console = lazy(() => import('./console/Console').then((m) => ({ default: m.Console })));

function App() {
  const { path } = useLocation();
  const section = '/' + (path.split('/')[1] ?? '');
  const screen =
    path.startsWith('/operator/decision') ? <OperatorDecision /> : section === '/operator' ? <Operator /> : section === '/buyer' ? <Buyer /> : section === '/agent' ? <AgentRun /> : section === '/judges' ? <Judges /> : section === '/console' ? (
      <Suspense fallback={<p className="loading">Loading the console…</p>}>
        <Console />
      </Suspense>
    ) : <Home />;
  return <Shell>{screen}</Shell>;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
