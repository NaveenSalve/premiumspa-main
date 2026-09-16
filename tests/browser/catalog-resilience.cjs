const assert = require('node:assert/strict');
const express = require('express');
const { chromium } = require('playwright-core');
const path = require('node:path');

async function main() {
  const app = express();
  app.use(express.static(path.resolve('dist')));
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
  try {
    for (const mode of ['transient', 'permanent']) {
      const width = mode === 'transient' ? 375 : 1440;
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      let attempts = 0;
      await page.route('**/*', async route => {
        if (route.request().resourceType() === 'image') {
          return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"/>' });
        }
        const endpoint = new URL(route.request().url()).pathname;
        if (!endpoint.startsWith('/api/')) return route.continue();
        if (endpoint === '/api/services') {
          attempts++;
          if (mode === 'permanent' || attempts === 1) return route.fulfill({ status: 503, json: { error: 'Simulated temporary outage' } });
          return route.fulfill({ json: [{ id: 'audit-service', name: 'Recovered Service', category: 'Therapeutic', description: 'Test', duration: '1H', price: 100, visible: true, imageUrl: '/test.webp' }] });
        }
        if (endpoint === '/api/therapists') {
          return route.fulfill({ json: [{ id: 'audit-therapist', name: 'Audit Therapist', category: 'Classic', tier: 'Classic', specialty: 'Massage', experience: '5 years', rating: 5, price: 100, avatarUrl: '/therapist.webp', status: 'available', availability: true }] });
        }
        if (endpoint === '/api/settings') {
          return route.fulfill({ json: {
            brandName: 'Audit Spa', brandLogoUrl: '/audit-logo.webp',
            heroDesktopImageUrl: '/desktop-banner.webp', heroLaptopImageUrl: '/laptop-banner.webp',
          } });
        }
        return route.fulfill({ status: 401, json: { error: 'Unauthorized' } });
      });
      await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'networkidle' });
      await page.locator('img[alt="Audit Spa"]').waitFor();
      await page.locator('img[alt="Audit Therapist"]').waitFor();
      const hero = await page.locator('img[alt="World-Class Spa Delivered"]').getAttribute('src');
      assert.equal(hero, width < 1280 ? '/laptop-banner.webp' : '/desktop-banner.webp', 'Use the configured banner for the viewport');
      assert.equal(attempts, 2, 'One retry for a failed public catalog request');
      if (mode === 'transient') await page.locator('img[alt="Recovered Service"]').waitFor();
      console.log(`PASS ${mode}: successful settings and therapist responses render despite services failure`);
      await page.close();
    }
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
