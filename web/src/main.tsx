import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { applyTheme, storedMode } from './lib/theme';
import './index.css';

// Before the first paint, not in an effect: otherwise a light-theme user gets
// a frame of the dark palette on every load.
applyTheme(storedMode());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
