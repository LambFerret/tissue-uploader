import {defineConfig,devices} from '@playwright/test';
export default defineConfig({
 testDir:'./cloud-tests',outputDir:'cloud-test-results',workers:1,timeout:120000,
 use:{baseURL:'http://127.0.0.1:3108',trace:'retain-on-failure'},
 projects:[{name:'desktop',use:{...devices['Desktop Chrome']}},{name:'android',use:{...devices['Pixel 7']}}],
 webServer:{command:'node scripts/cloud-test-server.mjs',url:'http://127.0.0.1:3108/healthz',timeout:120000,reuseExistingServer:false}
});
