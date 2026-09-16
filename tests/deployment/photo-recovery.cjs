const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { build } = require('esbuild');
const { PgDialect } = require('drizzle-orm/pg-core');
const { PGlite } = require('@electric-sql/pglite');
const plan = require('../../src/data/uploaded-photo-recovery.json');

async function main() {
  for (const row of plan) {
    const hash = crypto.createHash('sha256').update(fs.readFileSync('public' + row.image)).digest('hex');
    assert.equal(hash, row.sha256, `Original upload must exist unchanged for ${row.id}`);
  }
  const result = await build({
    entryPoints: ['src/lib/restore-uploaded-photos.ts'],
    bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external',
    plugins: [{ name: 'isolated-postgres', setup(build) {
      build.onResolve({ filter: /db\/index\.ts$/ }, () => ({ path: 'test-db', namespace: 'test' }));
      build.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'export const db = { execute: statement => globalThis.recoveryTestExecute(statement) };' }));
    } }],
  });
  const freshInstance = () => {
    const mod = { exports: {} };
    new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, mod, mod.exports);
    return mod.exports.restoreUploadedTherapistPhotos;
  };
  const postgres = new PGlite();
  const dialect = new PgDialect();
  globalThis.recoveryTestExecute = statement => {
    const query = dialect.sqlToQuery(statement);
    return postgres.query(query.sql, query.params);
  };
  try {
    await postgres.exec('CREATE TABLE site_settings (key text PRIMARY KEY, value text NOT NULL); CREATE TABLE therapists (id text PRIMARY KEY, image text NOT NULL, updated_at timestamp DEFAULT now());');
    for (const row of plan) await postgres.query('INSERT INTO therapists (id, image) VALUES ($1, $2)', [row.id, row.expectedImage]);
    await postgres.query('INSERT INTO therapists (id, image) VALUES ($1, $2)', ['nitu-unchanged', '/uploads/nitu.webp']);
    // A database failure must roll back the marker together with all updates.
    await postgres.exec("ALTER TABLE therapists ADD CONSTRAINT block_repair CHECK (image NOT LIKE '/uploads/db-images/%');");
    const retryable = freshInstance();
    await assert.rejects(retryable(), /block_repair/);
    assert.equal((await postgres.query('SELECT * FROM site_settings')).rows.length, 0);
    await postgres.exec('ALTER TABLE therapists DROP CONSTRAINT block_repair');
    await retryable();
    let rows = (await postgres.query('SELECT * FROM therapists')).rows;
    for (const row of plan) assert.equal(rows.find(x => x.id === row.id).image, row.image);
    assert.equal(rows.find(x => x.id === 'nitu-unchanged').image, '/uploads/nitu.webp');
    // A new serverless instance must respect the persistent marker and future edits.
    await postgres.query('UPDATE therapists SET image = $2 WHERE id = $1', [plan[0].id, plan[0].expectedImage]);
    await freshInstance()();
    assert.equal((await postgres.query('SELECT image FROM therapists WHERE id=$1', [plan[0].id])).rows[0].image, plan[0].expectedImage);
    // When starting without a marker, custom photos must still be protected.
    await postgres.exec('DELETE FROM site_settings');
    await postgres.query('UPDATE therapists SET image = $2 WHERE id = $1', [plan[0].id, 'https://example.com/new-custom.webp']);
    await Promise.all([freshInstance()(), freshInstance()()]);
    assert.equal((await postgres.query('SELECT image FROM therapists WHERE id=$1', [plan[0].id])).rows[0].image, 'https://example.com/new-custom.webp');
    assert.equal((await postgres.query('SELECT * FROM site_settings')).rows.length, 1);
    console.log('PASS: original asset hashes, atomic PostgreSQL repair/rollback, seven restorations, custom-photo protection, and persistent one-time marker');
  } finally {
    delete globalThis.recoveryTestExecute;
    await postgres.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
