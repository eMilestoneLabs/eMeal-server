import { Logger } from '@nestjs/common';

/**
 * Perf (2026-07-19) — event-loop-free password hashing.
 *
 * bcryptjs is pure JavaScript: at BCRYPT_ROUNDS=12 every hash/compare burns
 * ~300-900ms of CPU ON THE EVENT LOOP, so a single login stalls every
 * concurrent request on that PM2 worker — the hidden cross-endpoint tail
 * poisoner (measured: logins 845-1234ms while unrelated reads' p95 breached
 * their 30ms budgets whenever login-heavy traffic ran).
 *
 * The native `bcrypt` package has the IDENTICAL async API and produces /
 * verifies the same $2a$/$2b$ hashes (every stored credential keeps working),
 * but runs the blowfish rounds on the libuv threadpool — the event loop stays
 * free and reads keep their 5-30ms latency even during login storms.
 *
 * Fail-safe by construction: if the native binding cannot load on some host,
 * we fall back to bcryptjs with a warning — behavior identical, only slower.
 * No env flag needed; the fallback IS the legacy path.
 */
interface BcryptLike {
  hash(data: string, saltOrRounds: number): Promise<string>;
  compare(data: string, encrypted: string): Promise<boolean>;
}

function loadBcrypt(): BcryptLike {
  const logger = new Logger('PasswordHasher');
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const native = require('bcrypt') as BcryptLike;
    logger.log('Using native bcrypt — hashing runs off the event loop');
    return native;
  } catch {
    logger.warn(
      'Native bcrypt binding unavailable — falling back to bcryptjs (pure JS, event-loop-bound)',
    );
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('bcryptjs') as BcryptLike;
  }
}

/** Shared bcrypt implementation — import as `bcrypt` for drop-in usage. */
export const bcryptLib: BcryptLike = loadBcrypt();
