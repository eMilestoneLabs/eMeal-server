import { registerAs } from '@nestjs/config';

export default registerAs('jwt', () => ({
  accessSecret: process.env.JWT_ACCESS_SECRET,
  refreshSecret: process.env.JWT_REFRESH_SECRET,
  // expiresIn is NUMBER (seconds) — Flutter expects expiresIn: 900 (integer)
  accessExpiresIn: parseInt(process.env.JWT_ACCESS_EXPIRES_IN ?? '900', 10),
  refreshExpiresIn: parseInt(process.env.JWT_REFRESH_EXPIRES_IN ?? '604800', 10),
}));
