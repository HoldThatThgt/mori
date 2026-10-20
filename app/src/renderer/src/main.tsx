import './zod-config';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { FeedbackForm } from './components/FeedbackForm';
import { IssueReporter } from './components/IssueDialog';
import { SelectionPopover } from './components/SelectionPopover';
import { TrustDialog } from './components/TrustDialog';
import { connectKernel } from './state/actions';
import 'streamdown/styles.css';
import './styles/tokens.css';
import './styles/layout.css';
import './styles/chat.css';
import './styles/forms.css';
import './styles/issues.css';
import './styles/quotes.css';

connectKernel();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <SelectionPopover />
    <FeedbackForm />
    <IssueReporter />
    <TrustDialog />
  </StrictMode>,
);
