import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    exclude: ['lucide-react'],
  },
  worker: {
    // The voice recognition worker is created with
    // `new Worker(new URL('./voiceRecognitionWorker.ts', import.meta.url),
    // { type: 'module' })` and has real ES imports. Vite's dev server
    // serves such a worker unbundled, so a classic worker would hit a
    // "Cannot use import statement outside a module" error in dev while
    // working in production. 'es' makes dev and build agree.
    format: 'es',
  },
});
