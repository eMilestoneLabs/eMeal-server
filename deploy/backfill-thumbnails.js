#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * backfill-thumbnails.js — one-shot: generate the missing `_thumb.jpg` for every
 * meal image / avatar uploaded BEFORE the thumbnail pipeline was deployed.
 *
 * WHY: the Flutter app loads `<name>_thumb.jpg` first for list/grid images.
 * Legacy objects have no thumbnail, so every render paid a 404 round-trip
 * before falling back to the full image — the "avatars / meal images take
 * time" symptom. After this backfill, every image has a ~15KB thumbnail and
 * the fallback path never fires.
 *
 * Run ON the VPS from the app directory (uses the app's own node_modules —
 * @aws-sdk/client-s3 + sharp — and the same MINIO_* env the app uses):
 *
 *   cd /path/to/eMeal-server
 *   set -a; source .env; set +a
 *   node deploy/backfill-thumbnails.js            # dry-run (lists what it would do)
 *   node deploy/backfill-thumbnails.js --apply    # actually generate + upload
 *
 * Idempotent: objects that already have a `_thumb.jpg` are skipped, thumbnails
 * themselves are never re-thumbnailed, non-image keys are ignored. Safe to
 * re-run any time. Read-only unless --apply is passed.
 */
'use strict';

const {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
} = require('@aws-sdk/client-s3');

const APPLY = process.argv.includes('--apply');
const BUCKET = process.env.MINIO_BUCKET || 'emeal-images';
const ENDPOINT = process.env.MINIO_ENDPOINT;
const ACCESS = process.env.MINIO_ACCESS_KEY;
const SECRET = process.env.MINIO_SECRET_KEY;
const WIDTH = Number(process.env.THUMBNAIL_WIDTH || 320);
const QUALITY = Number(process.env.THUMBNAIL_QUALITY || 70);

if (!ENDPOINT || !ACCESS || !SECRET) {
  console.error('MINIO_ENDPOINT / MINIO_ACCESS_KEY / MINIO_SECRET_KEY missing — `set -a; source .env; set +a` first.');
  process.exit(1);
}

const s3 = new S3Client({
  endpoint: ENDPOINT,
  region: 'us-east-1',
  credentials: { accessKeyId: ACCESS, secretAccessKey: SECRET },
  forcePathStyle: true,
});

const isImage = (k) => /\.(jpe?g|png)$/i.test(k);
const isThumb = (k) => /_thumb\.jpg$/i.test(k);
const thumbKeyOf = (k) => k.replace(/\.\w+$/, '_thumb.jpg');

async function listAllKeys() {
  const keys = [];
  let token;
  do {
    const page = await s3.send(new ListObjectsV2Command({
      Bucket: BUCKET,
      ContinuationToken: token,
    }));
    for (const o of page.Contents || []) keys.push(o.Key);
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

async function bodyToBuffer(body) {
  const chunks = [];
  for await (const c of body) chunks.push(c);
  return Buffer.concat(chunks);
}

(async () => {
  // Lazy require so the error message is friendly if sharp isn't installed yet.
  let sharp;
  try {
    sharp = require('sharp');
  } catch {
    console.error('sharp is not installed — run `npm ci` in the app directory first.');
    process.exit(1);
  }

  console.log(`Scanning bucket "${BUCKET}" ${APPLY ? '(APPLY mode)' : '(dry-run — pass --apply to write)'}…`);
  const keys = await listAllKeys();
  const have = new Set(keys.filter(isThumb));
  const candidates = keys.filter((k) => isImage(k) && !isThumb(k) && !have.has(thumbKeyOf(k)));

  console.log(`objects=${keys.length} images=${keys.filter(isImage).length} thumbnails=${have.size} missing=${candidates.length}`);
  let done = 0, failed = 0;

  for (const key of candidates) {
    if (!APPLY) { console.log(`WOULD create ${thumbKeyOf(key)}`); continue; }
    try {
      const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
      const buf = await bodyToBuffer(obj.Body);
      const thumb = await sharp(buf)
        .resize({ width: WIDTH, withoutEnlargement: true })
        .jpeg({ quality: QUALITY })
        .toBuffer();
      await s3.send(new PutObjectCommand({
        Bucket: BUCKET,
        Key: thumbKeyOf(key),
        Body: thumb,
        ContentType: 'image/jpeg',
        // Same immutable policy as the app's uploadThumbnail (keys are
        // timestamped, replaced objects get new keys).
        CacheControl: 'public, max-age=31536000, immutable',
      }));
      done++;
      console.log(`created ${thumbKeyOf(key)} (${(thumb.length / 1024).toFixed(1)} KB)`);
    } catch (err) {
      failed++;
      console.warn(`FAILED ${key}: ${err.message}`);
    }
  }

  console.log(APPLY
    ? `Done. created=${done} failed=${failed}. Re-run to retry failures; safe to re-run any time.`
    : `Dry-run complete — ${candidates.length} thumbnail(s) would be created. Re-run with --apply.`);
})().catch((err) => { console.error(err); process.exit(1); });
