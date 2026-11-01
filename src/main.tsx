import { createRoot } from 'react-dom/client';
import { Overlay } from './Overlay';
import './overlay.css';

// A preview in a browser stands in a wallpaper for the desktop the overlay floats over.
if (new URLSearchParams(location.search).has('preview')) document.body.classList.add('preview');
createRoot(document.getElementById('root')!).render(<Overlay />);
