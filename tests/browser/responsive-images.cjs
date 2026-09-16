const assert = require('node:assert/strict');
const { build } = require('esbuild');
const { chromium } = require('playwright-core');

async function main() {
  const original = 'https://example.supabase.co/storage/v1/object/public/spa-images/photo-full.webp?token=keep-me';
  const result = await build({
    stdin: {
      contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { ResponsiveImage } from './src/components/ResponsiveImage';
        function Fixture() {
          const [src, setSrc] = React.useState('/missing.webp');
          return <>
            <ResponsiveImage src={${JSON.stringify(original)}} alt="Uploaded photo" loading="eager" />
            <ResponsiveImage src={src} alt="Updated photo" loading="eager" />
            <button onClick={() => setSrc('/valid.webp')}>Update image</button>
          </>;
        }
        createRoot(document.getElementById('root')).render(<Fixture />);
      `,
      resolveDir: process.cwd(),
      loader: 'tsx',
    },
    bundle: true,
    write: false,
    format: 'iife',
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
  try {
    for (const width of [375, 768, 1024, 1440]) {
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      const requested = [];
      await page.route('**/*', async route => {
        const url = route.request().url();
        if (url === 'http://spa.test/') {
          return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script src="/fixture.js"></script>' });
        }
        if (url === 'http://spa.test/fixture.js') {
          return route.fulfill({ contentType: 'text/javascript', body: result.outputFiles[0].text });
        }
        requested.push(url);
        if (url === original || url === 'http://spa.test/valid.webp') {
          return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="green"/></svg>' });
        }
        return route.fulfill({ status: 404, body: 'Missing image' });
      });
      await page.goto('http://spa.test/', { waitUntil: 'networkidle' });
      const uploaded = await page.locator('img[alt="Uploaded photo"]').evaluateAll(imgs => imgs.some(i => i.complete && i.naturalWidth > 0));
      assert.ok(uploaded, 'Uploaded photo must use its existing URL, without guessed variants');
      assert.ok(requested.includes(original), 'Preserve the original URL including its query string');
      assert.equal(requested.some(url => /-\d+w\.(avif|webp)/.test(url)), false, 'Do not request nonexistent variants');
      await page.locator('[role="img"][aria-label="Updated photo"]').waitFor();
      await page.getByRole('button', { name: 'Update image' }).click();
      await page.waitForFunction(() => {
        const img = document.querySelector('img[alt="Updated photo"]');
        return img?.complete && img.naturalWidth > 0 && getComputedStyle(img).opacity === '1';
      }, { timeout: 5000 });
      console.log(`PASS ${width}px: original photo loads and failed image recovers after src changes`);
      await page.close();
    }
  } finally {
    await browser.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
