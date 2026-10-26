import './zod-config';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { FeedbackForm } from './components/FeedbackForm';
import { IssueReporter } from './components/IssueDialog';
import { SelectionPopover } from './components/SelectionPopover';
import { TrustDialog } from './components/TrustDialog';
import { connectKernel } from './state/actions';
import { reportBusySessions } from './state/busySessions';
import 'streamdown/styles.css';
import './styles/tokens.css';
import './styles/layout.css';
import './styles/chat.css';
import './styles/forms.css';
import './styles/issues.css';
import './styles/quotes.css';
import './styles/split.css';
import './styles/settings.css';
import './styles/models.css';
import './styles/tools.css';
import './styles/issues-page.css';
import './styles/memory.css';
import './styles/slash.css';
import './styles/team.css';

connectKernel();
reportBusySessions();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <SelectionPopover />
    <FeedbackForm />
    <IssueReporter />
    <TrustDialog />
  </StrictMode>,
);
