import './zod-config';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { connectKernel } from './state/actions';
import 'streamdown/styles.css';
import './styles/tokens.css';
import './styles/layout.css';
import './styles/chat.css';
import './styles/forms.css';

connectKernel();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
