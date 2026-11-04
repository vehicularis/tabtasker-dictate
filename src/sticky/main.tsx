import { createRoot } from 'react-dom/client';
import { Sticky } from './Sticky';
import '../ui/tokens.css';
import './page.css';
import './sticky.css';

// A file dropped anywhere nothing takes it would open in the sticky's window in place of the sticky (app/main.tsx).
addEventListener('dragover', event => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); });
addEventListener('drop', event => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); });

createRoot(document.getElementById('root')!).render(<Sticky />);
