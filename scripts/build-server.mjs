import { build } from 'esbuild';
import fs from 'fs';

await build({
  entryPoints: ['server.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  packages: 'external',
  outfile: 'dist-server/server.cjs',
  logLevel: 'info',
});

// Vercel runs an ESM entrypoint. Bundle all local TypeScript imports into one
// JavaScript artifact and disable the standalone listener for this target.
await build({
  entryPoints: ['server.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  packages: 'external',
  define: { 'process.env.VERCEL': '"1"' },
  outfile: 'dist-server/vercel.mjs',
  logLevel: 'info',
});

if (fs.existsSync('netlify/functions/api.ts')) {
  await build({
    entryPoints: ['netlify/functions/api.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    outfile: 'dist-functions/api.js',
    logLevel: 'info',
  });
}
