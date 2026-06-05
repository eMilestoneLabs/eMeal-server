/**
 * test/utils/test-app.ts
 *
 * Shared e2e harness. Boots the real AppModule and applies the SAME global
 * config as src/main.ts (api/v1 prefix + 422 validation pipe) so e2e behaviour
 * matches production exactly. Requires the Postgres + Redis service containers
 * provided by the CI integration stage.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app/app.module';

export async function createTestApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleRef.createNestApplication();

  // Mirror src/main.ts
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
      errorHttpStatusCode: 422,
    }),
  );

  await app.init();
  return app;
}

/** Unique suffix so repeat runs never collide on unique email/phone/slug. */
export function uniq(prefix = ''): string {
  return `${prefix}${Date.now()}${Math.floor(Math.random() * 10000)}`;
}
