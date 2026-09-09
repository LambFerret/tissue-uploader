import { defineConfig, devices } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
export default defineConfig({
 testDir: './tests', fullyParallel: false, workers: 1,
 use: { baseURL: 'http://127.0.0.1:3107', trace: 'retain-on-failure' },
 projects: [{ name: 'desktop', use: { ...devices['Desktop Chrome'] } }, { name: 'android', use: { ...devices['Pixel 7'] } }],
 webServer: { command: 'node tests/test-server.js', url: 'http://127.0.0.1:3107', reuseExistingServer: false, env: { PORT:'3107', ADMIN_PASSWORD:'test-password-strong', DATA_DIR:mkdtempSync(path.join(tmpdir(),'moa-test-')) } }
});
