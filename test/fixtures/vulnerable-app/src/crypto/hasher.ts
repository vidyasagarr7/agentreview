import crypto from 'crypto';

// Using MD5 for password hashing (weak!)
export function hashPassword(password: string): string {
  return crypto.createHash('md5').update(password).digest('hex');
}

// Using Math.random for token generation (not cryptographically secure)
export function generateResetToken(): string {
  return Math.random().toString(36).substring(2);
}

// Timing-vulnerable comparison
export function verifyToken(provided: string, stored: string): boolean {
  return provided === stored;  // Timing attack vulnerability
}
