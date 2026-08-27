import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';

// The frontend is a static, read-only page. No wallet, no proving, so the only
// heavy dependency is the on-chain runtime WASM used to decode ledger state and
// recompute the venue digest.
export default defineConfig({
  plugins: [wasm()],
  root: 'frontend',
  base: './',
  build: {
    outDir: '../frontend-dist',
    emptyOutDir: true,
    target: 'es2022',
  },
});
