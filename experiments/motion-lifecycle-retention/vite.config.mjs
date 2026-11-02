// Standalone entry for the temporary experiment: no Solid plugin, no file
// routes. Run from the repo root:
//   pnpm exec vite --config experiments/motion-lifecycle-retention/vite.config.mjs
import { defineConfig } from 'vite';

export default defineConfig({
  root: import.meta.dirname,
  server: { port: 3100 },
});
