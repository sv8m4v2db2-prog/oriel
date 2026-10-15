import { createRoot } from 'react-dom/client';
import '@mantine/core/styles.css';
import '@blocknote/mantine/style.css';
import './styles/theme.css';
import './styles/app.css';
import { initTheme } from './lib/theme';
import { initDesktop } from './lib/desktop';
import { App } from './App';

initTheme();
initDesktop();

createRoot(document.getElementById('root')!).render(<App />);
