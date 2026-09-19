const crypto = require('crypto');
const config = require('./config');
const passwordUtil = require('./password');

class AuthManager {
  constructor() {
    this.sessions = new Map();      // token -> { createdAt }
    this.loginAttempts = new Map();  // ip -> { count, lastAttempt }
    this.passwordHash = config.passwordHash;
  }

  _passwordMatches(password) {
    return passwordUtil.verify(password, this.passwordHash);
  }

  _isLockedOut(ip) {
    const attempts = this.loginAttempts.get(ip);
    if (!attempts) return false;
    if (attempts.count >= config.maxLoginAttempts) {
      const elapsed = Date.now() - attempts.lastAttempt;
      if (elapsed < config.lockoutMs) {
        return true;
      }
      // Lockout expired, reset
      this.loginAttempts.delete(ip);
      return false;
    }
    return false;
  }

  _recordFailedAttempt(ip) {
    const attempts = this.loginAttempts.get(ip) || { count: 0, lastAttempt: 0 };
    attempts.count++;
    attempts.lastAttempt = Date.now();
    this.loginAttempts.set(ip, attempts);
  }

  authenticate(password, ip) {
    if (this._isLockedOut(ip)) {
      const attempts = this.loginAttempts.get(ip);
      const remainingMs = config.lockoutMs - (Date.now() - attempts.lastAttempt);
      const remainingMin = Math.ceil(remainingMs / 60000);
      return { success: false, error: `Too many attempts. Try again in ${remainingMin} minutes.` };
    }

    if (!this._passwordMatches(password)) {
      this._recordFailedAttempt(ip);
      const attempts = this.loginAttempts.get(ip);
      const remaining = config.maxLoginAttempts - attempts.count;
      return {
        success: false,
        error: remaining > 0 ? `Invalid password. ${remaining} attempts remaining.` : 'Account locked. Try again later.'
      };
    }

    // Success - clear attempts and create session
    this.loginAttempts.delete(ip);
    const token = crypto.randomBytes(32).toString('hex');
    this.sessions.set(token, { createdAt: Date.now(), ip });
    return { success: true, token };
  }

  validateToken(token) {
    const session = this.sessions.get(token);
    if (!session) return false;

    // Check expiry
    if (Date.now() - session.createdAt > config.sessionTimeoutMs) {
      this.sessions.delete(token);
      return false;
    }
    return true;
  }

  revokeToken(token) {
    this.sessions.delete(token);
  }

  // Cleanup expired sessions periodically
  cleanup() {
    const now = Date.now();
    for (const [token, session] of this.sessions) {
      if (now - session.createdAt > config.sessionTimeoutMs) {
        this.sessions.delete(token);
      }
    }
    for (const [ip, attempts] of this.loginAttempts) {
      if (now - attempts.lastAttempt > config.lockoutMs) {
        this.loginAttempts.delete(ip);
      }
    }
  }
}

module.exports = new AuthManager();
