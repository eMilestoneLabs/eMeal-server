import { Logger } from '@nestjs/common';

/**
 * Notice attachment auto-compression (Live-Test-10 ISSUE-001).
 *
 * The client compresses first; this is the SERVER-SIDE safety net so an
 * oversized upload is automatically compressed to fit the configured limit
 * instead of being rejected outright. Rejection happens ONLY when even
 * auto-compression cannot reach the limit (extreme case per requirement).
 *
 * Both helpers follow the storage-service thumbnail discipline:
 *   • lazy require so the app boots (and unit tests run) without the native
 *     dependency installed;
 *   • never throw — a failed compression returns null and the caller falls
 *     back to the existing strict validation path.
 */
const logger = new Logger('NoticeAttachmentCompression');

export interface CompressedImage {
  buffer: Buffer;
  mimeType: string;
  ext: string;
}

/**
 * Progressive (width, quality) ladder — walked in order until the encoded
 * JPEG fits the limit. The final rung (360px q22) encodes to ~10–25 KB for
 * any photographic input, so a ≥100 KB limit is effectively always reachable.
 */
const IMAGE_LADDER: ReadonlyArray<readonly [number, number]> = [
  [1280, 80],
  [1024, 70],
  [1024, 55],
  [800, 45],
  [640, 35],
  [480, 28],
  [360, 22],
];

/**
 * Re-encode an oversized image as JPEG, stepping down size/quality until it
 * fits [maxBytes]. Honours EXIF orientation (`.rotate()`) and strips metadata
 * as a side effect of re-encoding. Returns null when sharp is unavailable,
 * the input cannot be decoded, or no rung fits.
 */
export async function compressImageToLimit(
  buffer: Buffer,
  maxBytes: number,
): Promise<CompressedImage | null> {
  let sharp: typeof import('sharp');
  try {
    // Lazy require so the app boots even if sharp is not yet installed.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    sharp = require('sharp');
  } catch {
    return null;
  }
  try {
    for (const [width, quality] of IMAGE_LADDER) {
      const out = await sharp(buffer)
        .rotate()
        .resize({ width, withoutEnlargement: true })
        .jpeg({ quality, mozjpeg: true })
        .toBuffer();
      if (out.length <= maxBytes) {
        return { buffer: out, mimeType: 'image/jpeg', ext: 'jpg' };
      }
    }
    logger.warn(
      `image auto-compress exhausted ladder (input ${buffer.length}B, limit ${maxBytes}B)`,
    );
    return null;
  } catch (err) {
    logger.warn(`image auto-compress failed: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Best-effort PDF structural compression via pdf-lib re-save (object streams
 * + deflated xref). PDFs that are mostly scanned images may not shrink enough
 * — those are rejected by the caller with the exact SRS message, matching the
 * "extreme case" rule. Returns null when pdf-lib is unavailable, the file is
 * corrupt, or the re-saved file still exceeds [maxBytes].
 */
export async function compressPdfToLimit(
  buffer: Buffer,
  maxBytes: number,
): Promise<Buffer | null> {
  try {
    // Lazy require: degrade to strict validation if pdf-lib is absent.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const {
      PDFDocument,
      PDFRawStream,
      PDFName,
      PDFNumber,
    } = require('pdf-lib');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const zlib = require('zlib') as typeof import('zlib');
    const doc = await PDFDocument.load(buffer, {
      ignoreEncryption: true,
      updateMetadata: false,
    });
    // Lossless win: FlateDecode-compress every stream that has NO filter yet
    // (uncompressed content streams are the main bloat in text PDFs). Streams
    // that already carry a filter are left untouched.
    const filterKey = PDFName.of('Filter');
    for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
      if (!(obj instanceof PDFRawStream)) continue;
      if (obj.dict.get(filterKey) !== undefined) continue;
      const deflated = zlib.deflateSync(Buffer.from(obj.contents));
      if (deflated.length >= obj.contents.length) continue;
      const newDict = obj.dict.clone(doc.context);
      newDict.set(filterKey, PDFName.of('FlateDecode'));
      newDict.set(PDFName.of('Length'), PDFNumber.of(deflated.length));
      doc.context.assign(ref, PDFRawStream.of(newDict, deflated));
    }
    const out = Buffer.from(await doc.save({ useObjectStreams: true }));
    if (out.length <= maxBytes) return out;
    logger.warn(
      `pdf auto-compress insufficient (${buffer.length}B → ${out.length}B, limit ${maxBytes}B)`,
    );
    return null;
  } catch (err) {
    logger.warn(`pdf auto-compress failed: ${(err as Error).message}`);
    return null;
  }
}
