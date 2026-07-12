import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';

/**
 * StorageService — meal image storage on MinIO (self-hosted, S3-compatible).
 *
 * B11. Replaces the previous stub. Uses @aws-sdk/client-s3 with
 * `forcePathStyle: true` (required for MinIO path-style buckets).
 *
 * Env (see .env.production.example):
 *   MINIO_ENDPOINT     http://localhost:9000
 *   MINIO_ACCESS_KEY   bucket access key
 *   MINIO_SECRET_KEY   bucket secret key
 *   MINIO_BUCKET       emeal-images
 *   STORAGE_CDN_URL    https://cdn.emilestone.com   (public read prefix)
 *
 * Key pattern: org/{orgId}/meals/{mealId}/{timestamp}.{jpg|png}
 * Returns an absolute HTTPS URL — exactly what the Flutter `imageUrl` field expects.
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly bucket: string;
  private readonly cdnUrl: string;
  private client: S3Client | null = null;

  constructor(private readonly config: ConfigService) {
    this.bucket = this.config.get<string>('MINIO_BUCKET', 'emeal-images');
    this.cdnUrl = (
      this.config.get<string>('STORAGE_CDN_URL', '') || ''
    ).replace(/\/+$/, '');
  }

  /** Lazily build the S3 client so the app boots even if MinIO env is absent. */
  private getClient(): S3Client {
    if (this.client) return this.client;
    const endpoint = this.config.get<string>('MINIO_ENDPOINT');
    const accessKeyId = this.config.get<string>('MINIO_ACCESS_KEY');
    const secretAccessKey = this.config.get<string>('MINIO_SECRET_KEY');
    if (!endpoint || !accessKeyId || !secretAccessKey) {
      throw new Error('MinIO storage is not configured (MINIO_* env missing)');
    }
    this.client = new S3Client({
      endpoint,
      region: 'us-east-1', // MinIO ignores region but the SDK requires one
      credentials: { accessKeyId, secretAccessKey },
      forcePathStyle: true,
    });
    return this.client;
  }

  /**
   * Upload a meal image and return its absolute public URL.
   */
  async uploadMealImage(
    organizationId: string,
    mealId: string,
    buffer: Buffer,
    mimeType: 'image/jpeg' | 'image/png',
  ): Promise<string> {
    const ext = mimeType === 'image/jpeg' ? 'jpg' : 'png';
    const key = `org/${organizationId}/meals/${mealId}/${Date.now()}.${ext}`;

    await this.getClient().send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: buffer,
        ContentType: mimeType,
        // Keys are timestamped + immutable (old object deleted on replace),
        // so a long immutable cache is safe — lets the CDN + clients serve
        // repeat loads instantly without revalidating the origin.
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );
    await this.uploadThumbnail(key, buffer);

    const base = this.cdnUrl || `${this.config.get<string>('MINIO_ENDPOINT')}/${this.bucket}`;
    const url = `${base}/${key}`;
    this.logger.log(`Uploaded meal image org=${organizationId} meal=${mealId}`);
    return url;
  }

  /**
   * Upload a user avatar and return its absolute public URL.
   * Key: org/{orgId}/avatars/{userId}/{timestamp}.{jpg|png} — one current file
   * per user; callers delete the previous object on replace (see keyFromUrl).
   */
  async uploadAvatar(
    organizationId: string,
    userId: string,
    buffer: Buffer,
    mimeType: 'image/jpeg' | 'image/png',
  ): Promise<string> {
    const ext = mimeType === 'image/jpeg' ? 'jpg' : 'png';
    const key = `org/${organizationId}/avatars/${userId}/${Date.now()}.${ext}`;

    await this.getClient().send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: buffer,
        ContentType: mimeType,
        // Keys are timestamped + immutable (old object deleted on replace),
        // so a long immutable cache is safe — lets the CDN + clients serve
        // repeat loads instantly without revalidating the origin.
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );
    await this.uploadThumbnail(key, buffer);

    const base =
      this.cdnUrl || `${this.config.get<string>('MINIO_ENDPOINT')}/${this.bucket}`;
    this.logger.log(`Uploaded avatar org=${organizationId} user=${userId}`);
    return `${base}/${key}`;
  }

  /**
   * Best-effort thumbnail: a ~320px-wide JPEG stored alongside the original at
   * `<key>_thumb.jpg`, so list/grid views can load ~15KB instead of the full
   * image. ADDITIVE + degrade-safe — if `sharp` is not installed or resize
   * fails, the thumbnail is skipped and the (already-uploaded) original is
   * unaffected. No DB/contract change; the client derives the thumb URL by
   * this naming convention.
   */
  private async uploadThumbnail(originalKey: string, buffer: Buffer): Promise<void> {
    try {
      // Lazy require so the app boots even if sharp is not yet installed.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const sharp = require('sharp');
      const thumb = await sharp(buffer)
        .resize({ width: 320, withoutEnlargement: true })
        .jpeg({ quality: 70 })
        .toBuffer();
      const thumbKey = originalKey.replace(/\.\w+$/, '_thumb.jpg');
      await this.getClient().send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: thumbKey,
          Body: thumb,
          ContentType: 'image/jpeg',
          CacheControl: 'public, max-age=31536000, immutable',
        }),
      );
    } catch (err: any) {
      this.logger.warn(`thumbnail generation skipped: ${err?.message}`);
    }
  }

  /**
   * SRS Module 03 NTC-012/013: upload a notice attachment (one image ≤100 KB
   * or one document ≤50 KB — size/type validation happens in NoticesService)
   * and return its absolute public URL. Never base64 in the DB.
   * Key: org/{orgId}/notices/{noticeId}/{timestamp}.{ext}
   */
  async uploadNoticeAttachment(
    organizationId: string,
    noticeId: string,
    buffer: Buffer,
    mimeType: string,
    ext: string,
  ): Promise<string> {
    const key = `org/${organizationId}/notices/${noticeId}/${Date.now()}.${ext}`;
    await this.getClient().send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: buffer,
        ContentType: mimeType,
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );
    const base =
      this.cdnUrl || `${this.config.get<string>('MINIO_ENDPOINT')}/${this.bucket}`;
    this.logger.log(
      `Uploaded notice attachment org=${organizationId} notice=${noticeId} (${mimeType})`,
    );
    return `${base}/${key}`;
  }

  /**
   * Derive the storage object key from a previously-returned public URL, so the
   * old object can be deleted on replace. Returns null for non-storage URLs
   * (e.g. an external URL or a base64 data URI) — those are left untouched.
   */
  keyFromUrl(url: string | null | undefined): string | null {
    if (!url) return null;
    const base =
      this.cdnUrl || `${this.config.get<string>('MINIO_ENDPOINT')}/${this.bucket}`;
    if (base && url.startsWith(base + '/')) {
      return url.slice(base.length + 1);
    }
    return null;
  }

  /** Delete an object by its storage key (best-effort). */
  async deleteImage(key: string): Promise<void> {
    try {
      await this.getClient().send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
      );
    } catch (err: any) {
      this.logger.warn(`deleteImage failed for ${key}: ${err?.message}`);
    }
  }
}
