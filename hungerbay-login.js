require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const LOGIN_URL = process.env.HUNGERBAY_LOGIN_URL || process.env.HUNGERBAY_DASHBOARD_URL;
const DASHBOARD_URL = process.env.HUNGERBAY_DASHBOARD_URL;
const STORAGE_STATE = path.resolve(process.env.HUNGERBAY_STORAGE_STATE || './hungerbay-storage.json');

if (!LOGIN_URL || !DASHBOARD_URL) throw new Error('Set HUNGERBAY_LOGIN_URL and HUNGERBAY_DASHBOARD_URL in .env');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
  console.log('\nA browser window is open. Log into HungerBay normally.');
  console.log('After you reach the Merchant dashboard, return here and press Enter.\n');
  process.stdin.setEncoding('utf8');
  process.stdin.once('data', async () => {
    await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);
    await context.storageState({ path: STORAGE_STATE });
    console.log(`Saved authenticated session to ${STORAGE_STATE}`);
    await browser.close();
    process.exit(0);
  });
})();
