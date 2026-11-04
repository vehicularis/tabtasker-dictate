import { createRoot } from 'react-dom/client';
import { App } from './App';
import '../ui/ui.css';
import './app.css';

// A file dropped anywhere nothing takes it (outside a note) would open in the window in place of the app.
addEventListener('dragover', event => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); });
addEventListener('drop', event => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); });

createRoot(document.getElementById('root')!).render(<App />);
