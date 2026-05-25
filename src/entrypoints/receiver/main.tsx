import { createRoot } from 'react-dom/client';
import '../popup/style.css';
import { Receiver } from './Receiver';

const root = document.getElementById('root');
if (root) createRoot(root).render(<Receiver />);
