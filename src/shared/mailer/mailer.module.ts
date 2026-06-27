import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MailerService } from './mailer.service';

/**
 * MailerModule — provides the transactional MailerService.
 * Import it wherever email is needed (e.g. AuthModule). Self-contained: depends
 * only on ConfigModule. Adds NO infrastructure — pure app-layer SMTP client.
 */
@Module({
  imports: [ConfigModule],
  providers: [MailerService],
  exports: [MailerService],
})
export class MailerModule {}
