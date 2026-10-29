import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { captureImageBetaFromUrl } from './lib/imageFeature';

// The picture-button beta link (/?images=1) is read once, before anything can rewrite the address.
try {
  captureImageBetaFromUrl(window.location.search, window.localStorage);
} catch {
  // storage unavailable: nothing to remember
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
