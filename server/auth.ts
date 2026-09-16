import { createHash, randomBytes } from 'node:crypto';
import { hash, verify, argon2id } from 'argon2';
import { AppError } from './errors.js';
export const SESSION_MS = 24 * 60 * 60 * 1000;
const digest = (token: string) => createHash('sha256').update(token).digest('hex');
export function hashPassword(password: string) {
  return hash(password, { type: argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
}
export class Auth {
  private sessions = new Map<string, number>();
  private attempts: number[] = [];
  private verifying = false;
  constructor(
    private passwordHash: string,
    private now: () => number = Date.now,
  ) {}
  private cleanup() {
    const time = this.now();
    for (const [key, expiry] of this.sessions) if (expiry <= time) this.sessions.delete(key);
    this.attempts = this.attempts.filter((t) => t > time - 5 * 60 * 1000);
  }
  valid(token: string | undefined) {
    this.cleanup();
    return !!token && token.length <= 128 && (this.sessions.get(digest(token)) ?? 0) > this.now();
  }
  async login(password: string): Promise<string> {
    this.cleanup();
    if (this.verifying || this.attempts.length >= 10)
      throw new AppError('LOGIN_RATE_LIMIT', '登录尝试过于频繁，请稍后再试。', 429);
    this.attempts.push(this.now());
    this.verifying = true;
    try {
      if (!(await verify(this.passwordHash, password)))
        throw new AppError('LOGIN_FAILED', '密码不正确。', 401);
      // A small bounded in-memory set is sufficient for one administrator.
      if (this.sessions.size >= 64) {
        const first = this.sessions.keys().next().value;
        if (first) this.sessions.delete(first);
      }
      const token = randomBytes(32).toString('base64url');
      this.sessions.set(digest(token), this.now() + SESSION_MS);
      return token;
    } finally {
      this.verifying = false;
    }
  }
  logout(token: string | undefined) {
    if (token) this.sessions.delete(digest(token));
  }
  close() {
    this.sessions.clear();
  }
}
