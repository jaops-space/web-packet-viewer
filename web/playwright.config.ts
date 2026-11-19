import { defineConfig } from '@playwright/test';

// Smoke test of the extension in a running Yamcs with the plugin (dev/yamcs: mvn yamcs:run), in the installed
// Google Chrome. PV_URL (default http://localhost:8091) and PV_INSTANCE (default simulator) choose the server.
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: process.env['PV_URL'] ?? 'http://localhost:8091',
    channel: 'chrome',
    headless: true,
    viewport: { width: 1600, height: 900 },
  },
});
