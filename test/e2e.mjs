// Drives the real web client in headless Chromium against a fake VNC server.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { createApp } from '../src/server.js';
import { startFakeRfb } from './fake-rfb.js';

const exe = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const fake = await startFakeRfb();
const app = createApp({ password: 'pw', secret: 'x', vncPort: fake.port, secureCookie: false });
await new Promise((r) => app.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${app.address().port}`;

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const page = await (await browser.newContext({ viewport: { width: 390, height: 780 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

const redPixel = () => page.evaluate(() => {
  const c = document.querySelector('#screen canvas');
  if (!c) return false;
  const d = c.getContext('2d').getImageData(5, 5, 1, 1).data;
  return d[0] > 200 && d[1] < 50 && d[2] < 50;
});
const until = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error('timed out waiting for a new connection'); await new Promise((r) => setTimeout(r, 50)); }
};
const waitRed = (ms = 8000) => page.waitForFunction(() => {
  const c = document.querySelector('#screen canvas');
  if (!c) return false;
  const d = c.getContext('2d').getImageData(5, 5, 1, 1).data;
  return d[0] > 200 && d[1] < 50 && d[2] < 50;
}, null, { timeout: ms });

try {
  // 1. sign in
  await page.goto(base);
  assert.match(page.url(), /login\.html/);
  await page.fill('#password', 'wrong'); await page.click('button[type=submit]');
  await page.waitForSelector('#error:not(:empty)');
  await page.fill('#password', 'pw'); await page.click('button[type=submit]');
  await page.waitForSelector('#connect');

  // 2. connect to the Mac (fake server needs no VNC password)
  await page.fill('#user', 'ken'); await page.fill('#pass', 'x');
  await page.click('#connect button[type=submit]');
  await waitRed();
  console.log('ok  connects and renders the remote screen');

  // 3. server drops the connection -> client reconnects by itself
  const before = fake.connections;
  fake.dropAll();
  await until(() => fake.connections > before);
  await waitRed();
  console.log('ok  reconnects automatically after a dropped connection');

  // 3b. the connection goes silent without closing (network change) -> client notices and reconnects
  const beforeFreeze = fake.connections;
  fake.freezeAll();
  await until(() => fake.connections > beforeFreeze, 15000);
  await waitRed();
  console.log('ok  reconnects by itself when the connection freezes without closing');

  // 3c. the meter shows live data, and Fast/Sharp changes what is asked of the Mac
  // RFB pseudo-encodings: JPEG quality q is -32+q, compression level c is -256+c.
  await page.waitForFunction(() => /(KB|MB)\/s · Raw/.test(document.querySelector('#meter')?.textContent ?? ''), null, { timeout: 5000 });
  assert.ok(fake.lastEncodings.includes(-32 + 8) && fake.lastEncodings.includes(-256 + 2), 'Sharp asks for quality 8, compression 2');
  await page.click('#btn-fast');
  await until(() => fake.lastEncodings.includes(-32 + 2) && fake.lastEncodings.includes(-256 + 7), 5000);
  assert.equal(await page.textContent('#btn-fast'), 'Fast');
  const beforeFast = fake.connections;
  fake.dropAll();
  await until(() => fake.connections > beforeFast);
  await waitRed();
  await until(() => fake.lastEncodings.includes(-32 + 2), 5000); // the choice survives a reconnect
  await page.screenshot({ path: process.env.E2E_SHOT ?? '/tmp/macremote-e2e.png' });
  await page.click('#btn-fast'); // back to Sharp for the rest of the run
  console.log('ok  meter shows live data; Fast/Sharp changes and keeps the quality asked of the Mac');

  // 4. app was away > 3s (iOS suspends it) -> fresh connection on return
  const before2 = fake.connections;
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(3300);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await until(() => fake.connections > before2);
  await waitRed();
  console.log('ok  reconnects on return after being away');

  // 5. saved credentials: reload goes straight back in, no prompts
  await page.reload();
  await waitRed();
  assert.equal(await page.locator('#connect').isHidden(), true);
  console.log('ok  reopening the app reconnects without any login');

  // 6. Close ends the session for good
  page.once('dialog', (d) => d.accept());
  await page.click('#btn-close');
  await page.waitForURL(/login\.html/);
  await page.goto(base);
  assert.match(page.url(), /login\.html/);
  assert.equal(await page.evaluate(() => localStorage.getItem('macremote.credentials')), null);
  console.log('ok  Close signs out and forgets saved credentials');

  assert.deepEqual(errors, [], `page errors: ${errors}`);
  console.log('ALL E2E CHECKS PASSED');
} catch (e) {
  console.error('E2E FAILED:', e.message, '\npage errors:', errors);
  await page.screenshot({ path: process.env.SHOT ?? 'e2e-failure.png' }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close(); app.closeAllConnections(); app.close(); await fake.close();
}
