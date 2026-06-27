import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { SmsService } from './sms.service';

/**
 * SmsModule — provides the transactional SmsService (Phase 3 OTP over SMS).
 * Self-contained; depends only on ConfigModule. Adds NO infrastructure.
 */
@Module({
  imports: [ConfigModule],
  providers: [SmsService],
  exports: [SmsService],
})
export class SmsModule {}
