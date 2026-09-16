const assert = require('node:assert/strict');
const { build } = require('esbuild');
const { chromium } = require('playwright-core');

async function main() {
  const result = await build({
    stdin: {
      contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { AdminView } from './src/components/AdminView';
        function Fixture() {
          const [settings, setSettings] = React.useState({
            whatsappNumber: '9999999999', callNumber: '9999999999',
            contactEmail: 'test@example.com', instagramUrl: 'https://example.com',
            googleReviewUrl: 'https://example.com/review', brandName: 'Test Spa',
            brandLogoUrl: '/logo.webp', heroDesktopImageUrl: '/old-desktop.webp',
            heroLaptopImageUrl: '/old-laptop.webp', experienceHomeImageUrl: '/home.webp',
            experienceHotelImageUrl: '/hotel.webp', experienceTherapistImageUrl: '/therapist.webp'
          });
          window.refreshCatalog = () => setSettings(current => ({ ...current }));
          return <AdminView bookings={[]} therapists={[]} customers={[]} services={[]}
            isAdminAuthed={true} contactSettings={settings}
            onUpdateContactSettings={async next => {
              window.saved = next;
              if (window.failSave) return 'Simulated save failure';
              setSettings(next);
              return null;
            }} />;
        }
        createRoot(document.getElementById('root')).render(<Fixture />);
      `,
      resolveDir: process.cwd(), loader: 'tsx',
    },
    bundle: true, write: false, format: 'iife',
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
  try {
    const page = await browser.newPage();
    let pendingUpload;
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script src="/fixture.js"></script>' });
      if (url.pathname === '/fixture.js') return route.fulfill({ contentType: 'text/javascript', body: result.outputFiles[0].text });
      if (url.pathname === '/api/admin/images/upload') { pendingUpload = route; return; }
      return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>' });
    });
    await page.goto('http://spa.test/');
    await page.getByRole('button', { name: /Contact Settings/ }).click();
    const desktop = page.getByPlaceholder('Desktop hero image URL', { exact: true });
    const save = () => page.getByRole('button', { name: 'Save Contact Settings', exact: true });
    await desktop.fill('/new-desktop.webp');
    await page.evaluate(() => { window.refreshCatalog(); window.failSave = true; });
    await page.waitForTimeout(100);
    assert.equal(await desktop.inputValue(), '/new-desktop.webp', 'Catalog refresh must preserve an unsaved URL');
    await save().click();
    await page.getByText('Simulated save failure', { exact: true }).waitFor();
    assert.equal(await desktop.inputValue(), '/new-desktop.webp', 'Failed save must keep the draft');
    await page.evaluate(() => { window.failSave = false; });
    await save().click();
    await page.waitForFunction(() => window.saved.heroDesktopImageUrl === '/new-desktop.webp');
    await save().waitFor();

    const uploader = page.locator('label').filter({ hasText: 'Upload Desktop Hero' }).locator('input[type=file]');
    const upload = { name: 'new-photo.png', mimeType: 'image/png', buffer: Buffer.from('test image') };
    await page.evaluate(() => { window.saved = null; });
    await uploader.setInputFiles(upload);
    await page.getByRole('button', { name: 'Uploading image...' }).waitFor();
    assert.ok(await desktop.isDisabled());
    // Even programmatic submit must not persist a temporary upload state.
    await desktop.evaluate(input => input.form.requestSubmit());
    assert.equal(await page.evaluate(() => window.saved), null);
    for (let i = 0; !pendingUpload && i < 50; i++) await page.waitForTimeout(20);
    assert.ok(pendingUpload);
    await pendingUpload.fulfill({ json: { success: true, primaryUrl: '/uploaded-desktop.webp' } });
    pendingUpload = null;
    await page.waitForFunction(() => document.querySelector('input[placeholder="Desktop hero image URL"]').value === '/uploaded-desktop.webp');
    await page.evaluate(() => window.refreshCatalog());
    await page.waitForTimeout(100);
    assert.equal(await desktop.inputValue(), '/uploaded-desktop.webp', 'Polling must preserve a completed upload until Save');
    await save().click();
    await page.waitForFunction(() => window.saved?.heroDesktopImageUrl === '/uploaded-desktop.webp');
    await page.waitForFunction(() => !document.querySelector('input[placeholder="Desktop hero image URL"]').disabled);

    await uploader.setInputFiles({ ...upload, name: 'failed-photo.png' });
    for (let i = 0; !pendingUpload && i < 50; i++) await page.waitForTimeout(20);
    assert.ok(pendingUpload);
    await pendingUpload.fulfill({ status: 500, json: { error: 'Simulated upload failure' } });
    await page.getByText('Image upload failed. Your previous image is unchanged. Please retry.', { exact: true }).waitFor();
    assert.equal(await desktop.inputValue(), '/uploaded-desktop.webp', 'Failed upload must preserve the previous image');
    console.log('PASS: draft survives polling/save errors; uploads cannot save early; uploaded URL persists; failed upload preserves photo');
  } finally {
    await browser.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
