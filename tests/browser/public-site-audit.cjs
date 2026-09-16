const { chromium } = require('playwright-core');
const fs = require('node:fs');
const path = require('node:path');

const base = (process.env.BASE_URL || 'https://premiumspa-main.vercel.app').replace(/\/$/, '');
const output = path.resolve(process.env.AUDIT_OUTPUT || 'audit-output');

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const report = { base, timestamp: new Date().toISOString(), api: [], pages: [] };
  for (const route of ['/api/health', '/api/services', '/api/therapists', '/api/settings', '/api/auth/me', '/api/admin/storage']) {
    const response = await fetch(base + route, { signal: AbortSignal.timeout(20000) });
    const data = await response.json();
    report.api.push({ route, status: response.status, count: Array.isArray(data) ? data.length : undefined });
  }
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
  try {
    for (const width of [375, 768, 1024, 1440]) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const page = await context.newPage();
      const failures = [];
      const errors = [];
      page.on('requestfailed', request => failures.push({ type: request.resourceType(), url: request.url(), error: request.failure()?.errorText }));
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(base, { waitUntil: 'networkidle', timeout: 30000 });
      for (const view of ['home', 'therapists', 'booking', 'about', 'message', 'admin']) {
        if (view === 'therapists') {
          await page.getByRole('button', { name: /^services$/i }).click();
        }
        if (view === 'booking') await page.getByRole('button', { name: /^book( now)?$/i }).first().click();
        if (view === 'about') await page.getByRole('button', { name: /^about us$/i }).first().click();
        if (view === 'message') await page.getByRole('button', { name: /^message$/i }).first().click();
        if (view === 'admin') {
          const response = await page.goto(base + '/admin', { waitUntil: 'networkidle' });
          if (response.status() !== 200) throw new Error('Admin direct navigation returned ' + response.status());
          await page.locator('input[type="password"]').waitFor();
        }
        const imageRows = [];
        const images = page.locator('img:visible');
        const count = await images.count();
        for (let index = 0; index < count; index++) {
          const img = images.nth(index);
          // Exercise the real lazy loading path, without forcing eager loading.
          await img.scrollIntoViewIfNeeded();
          const handle = await img.elementHandle();
          await page.waitForFunction(el => el.complete, handle, { timeout: 15000 }).catch(() => {});
          imageRows.push(await img.evaluate(el => ({
            alt: el.alt, src: el.currentSrc || el.src,
            loaded: el.complete && el.naturalWidth > 0,
            width: el.getBoundingClientRect().width,
            height: el.getBoundingClientRect().height,
            opacity: getComputedStyle(el).opacity,
          })));
        }
        const placeholders = await page.locator('[role="img"]:visible').evaluateAll(elements => elements.map(el => el.getAttribute('aria-label')));
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
        await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
        await page.screenshot({ path: path.join(output, `${width}-${view}-viewport.png`) });
        await page.screenshot({ path: path.join(output, `${width}-${view}.png`), fullPage: true });
        const result = { width, view, images: imageRows, placeholders, overflow, errors: [...errors], failedRequests: [...failures] };
        report.pages.push(result);
        console.log(JSON.stringify({ width, view, images: imageRows.length, broken: imageRows.filter(i => !i.loaded), placeholders, overflow, errors }));
      }
      await context.close();
    }
  } finally {
    await browser.close();
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  }
  const failed = report.api.some(r => r.status !== (r.route.includes('/auth/') || r.route.includes('/admin/') ? 401 : 200)) ||
    report.pages.some(p => p.images.some(i => !i.loaded) || p.placeholders.length || p.overflow || p.errors.length);
  process.exitCode = failed ? 1 : 0;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
