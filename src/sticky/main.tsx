import { createRoot } from 'react-dom/client';
import { Sticky } from './Sticky';
import '../ui/tokens.css';
import './page.css';
import './sticky.css';

createRoot(document.getElementById('root')!).render(<Sticky />);
