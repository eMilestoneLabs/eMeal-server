import { randomInt } from 'crypto';

/**
 * Generates a cryptographically secure join code for groups and events.
 * Format: 8-character uppercase alphanumeric (e.g., "HTL3K8XZ")
 * Search space: 36^8 ≈ 2.8 trillion — collision probability negligible at MVP scale.
 *
 * Uses Node.js crypto.randomInt() for uniform, cryptographically secure random selection.
 * This prevents predictable code generation that could allow brute-force group joins.
 *
 * Usage:
 *   const code = generateJoinCode();      // "HTL3K8XZ"
 *   const code = generateJoinCode(6);     // "A3KZ8X"
 */
export function generateJoinCode(length = 8): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < length; i++) {
    code += chars.charAt(randomInt(chars.length));
  }
  return code;
}
