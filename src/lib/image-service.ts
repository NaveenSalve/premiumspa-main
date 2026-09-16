import { db } from '../db/index.ts';
import { imageAssets } from '../db/schema.ts';
import { eq, and, sql } from 'drizzle-orm';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { supabase, IMAGES_BUCKET, ensureBucketExists } from './supabase.ts';
import {
  processImage,
  uploadImageVariants,
  deleteImageVariants,
  generateStoragePath,
  getPublicUrl,
  ImageType,
  ImageVariantsResult,
} from './image-processing.ts';

const LOCAL_IMAGES_BUCKET = 'local-uploads';
const LOCAL_UPLOAD_BASE_URL = '/uploads/images';
const LOCAL_UPLOAD_DIR = path.join(process.cwd(), 'public', 'uploads', 'images');
let imageAssetsTableReady: Promise<void> | null = null;

function ensureImageAssetsTable(): Promise<void> {
  imageAssetsTableReady ||= (async () => {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "image_assets" (
        "id" text PRIMARY KEY NOT NULL,
        "original_name" text NOT NULL,
        "mime_type" text NOT NULL,
        "size" integer NOT NULL,
        "width" integer,
        "height" integer,
        "storage_path" text NOT NULL,
        "bucket" text DEFAULT 'images' NOT NULL,
        "variants" text NOT NULL,
        "entity_type" text,
        "entity_id" text,
        "entity_field" text,
        "created_at" timestamp DEFAULT now() NOT NULL,
        "updated_at" timestamp DEFAULT now() NOT NULL
      )
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS "idx_image_assets_entity" ON "image_assets" ("entity_type", "entity_id")`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS "idx_image_assets_created_at" ON "image_assets" ("created_at")`);
  })();
  return imageAssetsTableReady;
}

export interface UploadImageOptions {
  file: Buffer;
  originalName: string;
  mimeType: string;
  entityType: 'service' | 'therapist' | 'site_setting' | 'hero';
  entityId: string;
  entityField: string;
  imageType?: ImageType;
}

export interface ImageAssetRecord {
  id: string;
  originalName: string;
  mimeType: string;
  size: number;
  width: number | null;
  height: number | null;
  storagePath: string;
  bucket: string;
  variants: Record<string, { url: string; width: number; height: number; format: string; size: number }>;
  entityType: string | null;
  entityId: string | null;
  entityField: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export async function uploadAndProcessImage(
  options: UploadImageOptions
): Promise<{ asset: ImageAssetRecord; urls: Record<string, string> }> {
  const imageType = options.imageType || 
    (options.entityType === 'hero' ? 'hero' : 
     options.entityType === 'site_setting' && options.entityField.includes('Logo') ? 'logo' : 
     'general');
  
  const result: ImageVariantsResult = await processImage(options.file, imageType);

  const urls = supabase
    ? await uploadToSupabase(options, result)
    : await writeImageVariantsToLocalStorage(options, result);
  
  const variantsMeta: Record<string, { url: string; width: number; height: number; format: string; size: number }> = {};
  for (const [suffix, variant] of Object.entries(result.variants)) {
    variantsMeta[suffix] = {
      url: urls[suffix],
      width: variant.width,
      height: variant.height,
      format: variant.format,
      size: variant.size,
    };
  }
  variantsMeta.original = {
    url: urls.original,
    width: result.original.width,
    height: result.original.height,
    format: result.original.format,
    size: result.original.size,
  };
  
  const assetId = `img-${crypto.randomUUID()}`;
  const storagePath = generateStoragePath(options.entityType, options.entityId, options.originalName, 'original', 'webp');
  const bucket = supabase ? IMAGES_BUCKET : LOCAL_IMAGES_BUCKET;

  await ensureImageAssetsTable();
  
  await db.insert(imageAssets).values({
    id: assetId,
    originalName: options.originalName,
    mimeType: options.mimeType,
    size: options.file.length,
    width: result.original.width,
    height: result.original.height,
    storagePath,
    bucket,
    variants: JSON.stringify(variantsMeta),
    entityType: options.entityType,
    entityId: options.entityId,
    entityField: options.entityField,
  });
  
  const asset: ImageAssetRecord = {
    id: assetId,
    originalName: options.originalName,
    mimeType: options.mimeType,
    size: options.file.length,
    width: result.original.width,
    height: result.original.height,
    storagePath,
    bucket,
    variants: variantsMeta,
    entityType: options.entityType,
    entityId: options.entityId,
    entityField: options.entityField,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  
  return { asset, urls };
}

async function uploadToSupabase(
  options: UploadImageOptions,
  result: ImageVariantsResult
): Promise<Record<string, string>> {
  if (!supabase) return {};
  await ensureBucketExists();
  return uploadImageVariants(
    supabase,
    IMAGES_BUCKET,
    options.entityType,
    options.entityId,
    options.originalName,
    result
  );
}

async function writeImageVariantsToLocalStorage(
  options: UploadImageOptions,
  result: ImageVariantsResult
): Promise<Record<string, string>> {
  const urls: Record<string, string> = {};
  fs.mkdirSync(path.join(LOCAL_UPLOAD_DIR, options.entityType, options.entityId), { recursive: true });

  async function writeVariant(suffix: string, buffer: Buffer, format: string) {
    const storagePath = generateStoragePath(options.entityType, options.entityId, options.originalName, suffix, format);
    const filePath = path.join(LOCAL_UPLOAD_DIR, storagePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, buffer);
    urls[suffix] = `${LOCAL_UPLOAD_BASE_URL}/${storagePath.replace(/\\/g, '/')}`;
  }

  await writeVariant('original', result.original.buffer, 'webp');
  for (const [suffix, variant] of Object.entries(result.variants)) {
    await writeVariant(suffix, variant.buffer, variant.format);
  }

  return urls;
}

export async function getImageAsset(id: string): Promise<ImageAssetRecord | null> {
  await ensureImageAssetsTable();
  const rows = await db.select().from(imageAssets).where(eq(imageAssets.id, id)).limit(1);
  if (!rows[0]) return null;
  
  const row = rows[0];
  return {
    ...row,
    variants: JSON.parse(row.variants),
  };
}

export async function getImageAssetsByEntity(
  entityType: string,
  entityId: string
): Promise<ImageAssetRecord[]> {
  await ensureImageAssetsTable();
  const rows = await db
    .select()
    .from(imageAssets)
    .where(and(eq(imageAssets.entityType, entityType), eq(imageAssets.entityId, entityId)));
  
  return rows.map(row => ({
    ...row,
    variants: JSON.parse(row.variants),
  }));
}

export async function deleteImageAsset(id: string): Promise<boolean> {
  const asset = await getImageAsset(id);
  if (!asset) return false;

  if (supabase && asset.bucket === IMAGES_BUCKET) {
    await deleteImageVariants(supabase, asset.bucket, asset.entityType || 'general', asset.entityId || asset.id);
  } else {
    deleteLocalImageFiles(asset);
  }
  
  await db.delete(imageAssets).where(eq(imageAssets.id, id));
  
  return true;
}

export async function deleteImagesByEntity(entityType: string, entityId: string): Promise<number> {
  const assets = await getImageAssetsByEntity(entityType, entityId);
  let deleted = 0;
  
  for (const asset of assets) {
    if (supabase && asset.bucket === IMAGES_BUCKET) {
      await deleteImageVariants(supabase, asset.bucket, entityType, entityId);
    } else {
      deleteLocalImageFiles(asset);
    }
    await db.delete(imageAssets).where(eq(imageAssets.id, asset.id));
    deleted++;
  }
  
  return deleted;
}

function deleteLocalImageFiles(asset: ImageAssetRecord) {
  for (const variant of Object.values(asset.variants)) {
    if (!variant.url.startsWith(`${LOCAL_UPLOAD_BASE_URL}/`)) continue;
    const relativePath = variant.url.slice(LOCAL_UPLOAD_BASE_URL.length + 1);
    const filePath = path.resolve(LOCAL_UPLOAD_DIR, relativePath);
    if (!filePath.startsWith(path.resolve(LOCAL_UPLOAD_DIR))) continue;
    try {
      fs.rmSync(filePath, { force: true });
    } catch {
      // Best-effort cleanup; the database row is the source of truth.
    }
  }
}

export async function replaceImageAsset(
  oldAssetId: string,
  options: UploadImageOptions
): Promise<{ asset: ImageAssetRecord; urls: Record<string, string> }> {
  await deleteImageAsset(oldAssetId);
  return uploadAndProcessImage(options);
}

export function getResponsiveImageSrcSet(asset: ImageAssetRecord, type: 'thumbnail' | 'card' | 'full' | 'large' = 'card'): string {
  const variants = asset.variants;
  const entries: string[] = [];
  
  const suffixMap: Record<string, string[]> = {
    thumbnail: ['thumb', 'thumb-avif'],
    card: ['card', 'card-avif'],
    full: ['full', 'full-avif'],
    large: ['large', 'large-avif'],
  };
  
  const suffixes = suffixMap[type] || ['card', 'card-avif'];
  
  for (const suffix of suffixes) {
    const variant = variants[suffix];
    if (variant) {
      entries.push(`${variant.url} ${variant.width}w`);
    }
  }
  
  return entries.join(', ');
}

export function getResponsiveImageSources(asset: ImageAssetRecord): {
  webp: { srcSet: string; sizes: string };
  avif: { srcSet: string; sizes: string };
  fallback: string;
} {
  const variants = asset.variants;
  
  const webpEntries: string[] = [];
  const avifEntries: string[] = [];
  
  for (const [suffix, variant] of Object.entries(variants)) {
    if (suffix === 'original') continue;
    if (variant.format === 'webp') {
      webpEntries.push(`${variant.url} ${variant.width}w`);
    } else if (variant.format === 'avif') {
      avifEntries.push(`${variant.url} ${variant.width}w`);
    }
  }
  
  const fallback = variants.full?.url || variants.card?.url || variants.original?.url || '';
  
  return {
    webp: { srcSet: webpEntries.join(', '), sizes: '(max-width: 400px) 150px, (max-width: 800px) 400px, (max-width: 1200px) 800px, 1200px' },
    avif: { srcSet: avifEntries.join(', '), sizes: '(max-width: 400px) 150px, (max-width: 800px) 400px, (max-width: 1200px) 800px, 1200px' },
    fallback,
  };
}

export function getPreloadLinks(asset: ImageAssetRecord): string[] {
  const variants = asset.variants;
  const links: string[] = [];
  
  const priorityVariants = ['large', 'large-avif', 'desktop', 'desktop-avif', 'full', 'full-avif'];
  
  for (const suffix of priorityVariants) {
    const variant = variants[suffix];
    if (variant && (variant.format === 'webp' || variant.format === 'avif')) {
      links.push(`<${variant.url}>; rel=preload; as=image; type=image/${variant.format}`);
    }
  }
  
  return links;
}
