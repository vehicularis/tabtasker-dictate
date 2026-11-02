import { createRoot } from 'react-dom/client';
import { Note } from './Note';
import '../ui/ui.css';
import './note.css';

createRoot(document.getElementById('root')!).render(<Note />);
