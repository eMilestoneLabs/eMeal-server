import { Module } from '@nestjs/common';
import { StorageService } from './storage.service';

/**
 * StorageModule — B11. Provides MinIO-backed StorageService for meal images.
 * ConfigModule is global (app.module), so ConfigService injects without import.
 */
@Module({
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
