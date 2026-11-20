import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { UpdateNotice } from './components/UpdateNotice.tsx';
import { isAdminPath } from './lib/admin/adminPath.ts';
import './index.css';

const root = createRoot(document.getElementById('root')!);

if (isAdminPath(window.location.pathname)) {
  // The admin panel is its own chunk: it is downloaded only here, and the normal app never renders it.
  void import('./admin/AdminApp.tsx').then(({ AdminApp }) => {
    root.render(
      <StrictMode>
        <AdminApp />
      </StrictMode>,
    );
  });
} else {
  root.render(
    <StrictMode>
      <App />
      <UpdateNotice />
    </StrictMode>,
  );
}
