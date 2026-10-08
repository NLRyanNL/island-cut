import { createRoot } from 'react-dom/client';
import { loadBundledFonts } from './fonts/bundled';
import { App } from './App';
import './styles/app.css';
import * as store from './store/store';
import * as actions from './store/actions';
import { runCommand } from './hooks/useShortcuts';
import * as queue from './export/queue';
import * as templates from './presets/templates';

// Test hook for the automated UI tests (only when launched with UTS_TEST=1).
if (window.api?.testMode) (window as unknown as Record<string, unknown>).__uts = { store, actions, runCommand, queue, templates };

window.addEventListener('error', (e) => console.error('Uncaught:', e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) => console.error('Unhandled rejection:', e.reason));

createRoot(document.getElementById('root')!).render(<App />);
loadBundledFonts();

if (window.api?.selftest) import('./selftest').then((m) => m.runSelfTest());
