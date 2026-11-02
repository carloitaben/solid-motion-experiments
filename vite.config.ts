import { fileRoutes } from 'filesystem-routing/vite';
import { defineConfig } from 'vitest/config';
import solid from '@solidjs/vite-plugin';

export default defineConfig({
  // Turnkey streaming SSR: no index.html and no entry files — the plugin
  // generates the entries around src/App.tsx, wrapped in src/Document.tsx.
  // `vite build` emits client assets to dist/client and the request handler
  // to dist/server, plus the Node server (dist/server/node.js) `npm start` runs.
  plugins: [
    solid({
      start: {
        // Emit dist/server/node.js: a ready-to-run Node server (static
        // assets + the handler). Other platforms import dist/server/server.js.
        node: true,
        // Typed env is on by convention: ./env.ts is probed automatically.
        // (Set the top-level `env: false` option to opt out.)
      },
      // Set to false for a static shell: pages render on the client.
      ssr: true,
      // Dev-only: capture control at /__solid/diagnostics (see AGENTS.md).
      diagnostics: true,
      // `extensions` makes @solidjs/vite-plugin also compile the `?pick=` route
      // modules the fileRoutes plugin emits (their ids end in a query string).
      extensions: ['.jsx', '.tsx'],
    }),
    // `types: true` writes file-routes.d.ts next to this config, which is what
    // gives `paths()` its literals.
    fileRoutes({ types: true }),
  ],
  server: {
    port: 3000,
  },
  test: {
    globals: false,
    // Two projects, because the same src module behaves differently per
    // environment: `client` runs the browser build of @solidjs/web under
    // jsdom, `server` runs the server build under Node so a test can call
    // the real `renderToString()`. Each project's `include` is the other's
    // complement, so no test file runs twice. The root sets only what both
    // share, because array options inherit by concatenation: `include` and
    // `setupFiles` live on the project that needs them.
    projects: [
      {
        test: {
          name: 'client',
          // jsdom + the browser build: these are component tests.
          environment: 'jsdom',
          setupFiles: ['./vitest-setup.ts'],
          include: ['src/**/*.test.tsx'],
          exclude: ['src/**/*.ssr.test.tsx'],
        },
      },
      {
        test: {
          name: 'server',
          // Node + the server build: `renderToString()` and `isServer`.
          environment: 'node',
          include: ['src/**/*.ssr.test.tsx'],
        },
      },
    ],
  },
  build: {
    target: 'esnext',
    assetsInlineLimit: 0,
  },
});
