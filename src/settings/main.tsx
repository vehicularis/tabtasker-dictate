import { createRoot } from 'react-dom/client';
import { inApp } from '../bridge';
import { Settings } from './Settings';
import '../ui/ui.css';
import './settings.css';

// In the app the sidebar is the window's own vibrancy; in a browser it is a plain fill.
if (inApp()) document.documentElement.dataset.app = '';
createRoot(document.getElementById('root')!).render(<Settings />);
