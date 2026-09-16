import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const sandbox = mkdtempSync(path.join(tmpdir(), 'spa-vercel-smoke-'));
const buildToolBlocker = 'data:text/javascript,' + encodeURIComponent(`
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === 'vite' || specifier.startsWith('vite/') ||
        specifier === 'rollup' || specifier.startsWith('rollup/') ||
        specifier.startsWith('@rollup/')) {
      throw new Error('Production API must not load build tooling: ' + specifier);
    }
    return nextResolve(specifier, context);
  }
`);
try {
  // Reproduce the function filesystem without server.ts, src/, .env or a TS loader.
  mkdirSync(path.join(sandbox, 'api'));
  mkdirSync(path.join(sandbox, 'dist-server'));
  for (const file of ['package.json', 'api/index.js', 'dist-server/vercel.mjs']) {
    cpSync(path.join(root, file), path.join(sandbox, file));
  }
  symlinkSync(path.join(root, 'node_modules'), path.join(sandbox, 'node_modules'), 'junction');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { createServer } from 'node:http';
    import { register } from 'node:module';
    // Production must boot even when the platform omits dev build tooling.
    register(${JSON.stringify(buildToolBlocker)});
    const { default: handler } = await import('./api/index.js');
    const server = createServer((req, res) => {
      Promise.resolve(handler(req, res)).catch((error) => {
        console.error(error);
        res.writeHead(500).end();
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + server.address().port;
    try {
      await Promise.all(Array.from({ length: 8 }, async () => {
        const response = await fetch(base + '/api/health');
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.equal((await response.json()).status, 'ok');
      }));
      const response = await fetch(base + '/api/auth/me');
      assert.equal(response.status, 401);
      assert.ok((await response.json()).error);
      const missing = await fetch(base + '/api/nonexistent-smoke-test');
      assert.equal(missing.status, 404);
      assert.ok((await missing.json()).error);
      const sameOriginPost = await fetch(base + '/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://premiumspa-main.vercel.app' },
        body: '{}',
      });
      assert.equal(sameOriginPost.status, 400);
      const evilOriginPost = await fetch(base + '/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
        body: '{}',
      });
      assert.equal(evilOriginPost.status, 403);
      console.log('PASS: isolated Vercel bundle boots, concurrent health requests, auth guard, origin allowlist and JSON 404');
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await globalThis._postgresPool?.end();
    }
  `], {
    cwd: sandbox,
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      VERCEL: '1',
      DATABASE_URL: 'postgresql://test:test@127.0.0.1:1/test?sslmode=disable',
      POSTGRES_URL: '',
      JWT_SECRET: 'isolated-smoke-test-only-not-a-production-secret',
      ADMIN_PIN: 'Isolated-Test-Only-123!',
      APP_ORIGIN: 'https://example.invalid',
      VERCEL_PROJECT_PRODUCTION_URL: 'premiumspa-main.vercel.app',
      SUPABASE_URL: '',
      SUPABASE_SERVICE_ROLE_KEY: '',
      SUPABASE_ANON_KEY: '',
    },
  });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  if (result.error) throw result.error;
  assert.equal(result.status, 0, 'Isolated Vercel function smoke test failed');
} finally {
  // Only remove the generated temp directory; unlink the dependency junction first.
  rmSync(path.join(sandbox, 'node_modules'), { force: true, recursive: true });
  rmSync(sandbox, { force: true, recursive: true });
}
