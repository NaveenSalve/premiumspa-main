import { sql } from 'drizzle-orm';
import { db } from '../db/index.ts';
import recovery from '../data/uploaded-photo-recovery.json';

// These seven original uploads were shipped in public/uploads/db-images, but
// their therapist rows still contained the seed stock URLs. Each file was
// checked against the deployed static asset before adding this repair plan.
// A persistent marker makes this a one-time repair, so later admin selections
// (including deliberately choosing a stock URL) remain authoritative.
let recoveryPromise: Promise<void> | undefined;

export function restoreUploadedTherapistPhotos(): Promise<void> {
  recoveryPromise ||= (async () => {
    const values = recovery.map(row => sql`(${row.id}::text, ${row.expectedImage}::text, ${row.image}::text)`);
    // Claim and updates commit atomically. Concurrent serverless instances
    // cannot repeat the repair; changed/custom image URLs cannot be overwritten.
    const result = await db.execute(sql`
      WITH claimed AS (
        INSERT INTO site_settings (key, value)
        VALUES ('_migration_uploaded_therapist_photos_20260917', 'completed')
        ON CONFLICT (key) DO NOTHING
        RETURNING key
      )
      UPDATE therapists AS target
      SET image = repair.image, updated_at = now()
      FROM (VALUES ${sql.join(values, sql`, `)}) AS repair(id, expected_image, image)
      WHERE EXISTS (SELECT 1 FROM claimed)
        AND target.id = repair.id
        AND target.image = repair.expected_image
      RETURNING target.id
    `);
    if (result.rows.length) console.info(`[images] Restored ${result.rows.length} original uploaded therapist photos`);
  })().catch(error => {
    recoveryPromise = undefined;
    throw error;
  });
  return recoveryPromise;
}
