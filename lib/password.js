/**
 * Password hashing (scrypt) used by the server and the CLI.
 *
 * Stored format: scrypt$<N>$<r>$<p>$<salt base64>$<hash base64>
 * The plaintext password is never written to disk.
 */
const crypto = require('crypto');

const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;
const SALT_LEN = 16;
const MAXMEM = 64 * 1024 * 1024;
const PREFIX = 'scrypt$';

function hash(password) {
  const salt = crypto.randomBytes(SALT_LEN);
  const derived = crypto.scryptSync(String(password), salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `${PREFIX}${N}$${R}$${P}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

function isHashed(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

function verify(password, stored) {
  if (!isHashed(stored)) return false;
  const parts = stored.split('$');
  if (parts.length !== 6) return false;
  const n = parseInt(parts[1], 10);
  const r = parseInt(parts[2], 10);
  const p = parseInt(parts[3], 10);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  let salt;
  let expected;
  try {
    salt = Buffer.from(parts[4], 'base64');
    expected = Buffer.from(parts[5], 'base64');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  let derived;
  try {
    derived = crypto.scryptSync(String(password), salt, expected.length, { N: n, r, p, maxmem: MAXMEM });
  } catch {
    return false;
  }
  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
}

module.exports = { hash, verify, isHashed };
