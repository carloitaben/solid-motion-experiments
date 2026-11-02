import { defineConfig } from '@playwright/test';

// Browser hydration check for the real app. It runs against the Vite dev
// server — real streaming SSR plus the dev build of solid-js, which reports
// hydration mismatches that a production build strips — on a port of its own.
// A hand-started `pnpm dev` (3000) or the README's 4321/4322 never collide with
// it, and `--strictPort` makes a foreign listener on 4399 fail the run instead
// of being tested by accident.
const PORT = 4399;
const baseURL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  // One server, one worker: these assertions are about frames, not throughput.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: 'list',
  outputDir: 'test-results',
  use: {
    baseURL,
    // Fixed viewport so the refrow geometry assertions are deterministic.
    viewport: { width: 1280, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  // The first request pays Vite's dependency transform.
  expect: { timeout: 15_000 },
  projects: [
    // Chromium only, matching the observations in the README. Adding
    // firefox/webkit needs their browsers installed and re-validated.
    { name: 'chromium' },
  ],
  webServer: {
    // `--strictPort`: fail instead of silently testing whatever else owns the
    // port; `--host 127.0.0.1` pins the loopback Vite binds to (it otherwise
    // listens on [::1] only on macOS). Playwright owns the process and kills it
    // when the run ends.
    command: `pnpm dev --port ${PORT} --strictPort --host 127.0.0.1`,
    url: `${baseURL}/motion`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
