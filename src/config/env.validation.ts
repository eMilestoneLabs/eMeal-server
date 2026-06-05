/**
 * env.validation.ts — Startup environment variable validation.
 *
 * Called by ConfigModule.forRoot({ validate }) in app.module.ts.
 * Runs ONCE at application boot — fails fast before any module is initialized.
 *
 * Critical secrets (DATABASE_URL, JWT_ACCESS_SECRET, JWT_REFRESH_SECRET) are
 * REQUIRED in all environments. If missing the app throws with a clear error
 * message rather than starting and failing at the first DB/Redis operation.
 *
 * Optional variables have documented defaults so ops can see what is expected.
 *
 * Governance: DO NOT add business logic here — only env presence checks.
 */

interface EnvConfig {
  [key: string]: string | undefined;
}

interface ValidationResult {
  [key: string]: string | number | boolean | undefined;
}

// ── Required in ALL environments ──────────────────────────────────────────────

const REQUIRED_VARS = [
  'DATABASE_URL',
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
] as const;

// ── Required in production only ───────────────────────────────────────────────

const REQUIRED_IN_PRODUCTION = [
  'REDIS_HOST',
  'BULL_BOARD_SECRET',
] as const;

// ── Minimum lengths for secrets (production enforcement) ──────────────────────

const SECRET_MIN_LENGTH: Record<string, number> = {
  JWT_ACCESS_SECRET: 32,
  JWT_REFRESH_SECRET: 32,
};

// ── Main validation function ───────────────────────────────────────────────────

export function validateEnv(config: EnvConfig): ValidationResult {
  const errors: string[] = [];
  const nodeEnv = config.NODE_ENV ?? 'development';
  const isProduction = nodeEnv === 'production';

  // Check universally required vars
  for (const key of REQUIRED_VARS) {
    if (!config[key]) {
      errors.push(`${key} is required but not set`);
    }
  }

  // Check production-only required vars
  if (isProduction) {
    for (const key of REQUIRED_IN_PRODUCTION) {
      if (!config[key]) {
        errors.push(`${key} is required in production but not set`);
      }
    }
  }

  // Check minimum secret lengths (only if the var is present)
  for (const [key, minLen] of Object.entries(SECRET_MIN_LENGTH)) {
    const val = config[key];
    if (val && val.length < minLen) {
      errors.push(
        `${key} must be at least ${minLen} characters (got ${val.length}) — use a cryptographically random value`,
      );
    }
  }

  // Validate DATABASE_URL format
  const dbUrl = config.DATABASE_URL;
  if (dbUrl && !dbUrl.startsWith('postgresql://') && !dbUrl.startsWith('postgres://')) {
    errors.push(`DATABASE_URL must start with postgresql:// or postgres://`);
  }

  // Fail fast — do not start if any required var is missing
  if (errors.length > 0) {
    const msg = [
      '',
      '╔══════════════════════════════════════════════════════════════╗',
      '║  eMeal-Server — Environment Variable Validation FAILED       ║',
      '╚══════════════════════════════════════════════════════════════╝',
      '',
      'The following required environment variables are missing or invalid:',
      '',
      ...errors.map((e) => `  ✗ ${e}`),
      '',
      'Set these in your .env file or server environment before starting.',
      'See docs/BACKEND_DEPLOYMENT_CONTABO_VPS_10_CLAUDE_COMMAND_GUIDELINES.md',
      'for the complete .env setup instructions.',
      '',
    ].join('\n');
    throw new Error(msg);
  }

  // Return validated config (ConfigModule requires this)
  return config as ValidationResult;
}
