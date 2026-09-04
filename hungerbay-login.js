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
  console.log('After you reach the Merchant dashboard, return here and press Enter.');
  console.log(`The fresh Playwright session will be saved to: ${STORAGE_STATE}\n`);
  process.stdin.setEncoding('utf8');
  process.stdin.once('data', async () => {
    try {
      await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1500);
      const url = page.url().toLowerCase();
      const body = (await page.locator('body').innerText().catch(() => '')).toLowerCase();
      if (url.includes('login') || body.includes('merchant login') || body.includes('sign in')) {
        throw new Error('HungerBay still shows the login page. Complete the login before pressing Enter.');
      }
      await context.storageState({ path: STORAGE_STATE });
      console.log(`\nSaved authenticated session to ${STORAGE_STATE}`);
      console.log('NEXT STEP: replace the Render Secret File named hungerbay-storage.json with this newly generated file.');
    } catch (e) {
      console.error('Could not save a valid HungerBay session:', e.message);
      process.exitCode = 1;
    } finally {
      await browser.close();
      process.exit();
    }
  });
})();
