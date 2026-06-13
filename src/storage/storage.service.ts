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
      }),
    );

    const base = this.cdnUrl || `${this.config.get<string>('MINIO_ENDPOINT')}/${this.bucket}`;
    const url = `${base}/${key}`;
    this.logger.log(`Uploaded meal image org=${organizationId} meal=${mealId}`);
    return url;
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
