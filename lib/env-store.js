/**
 * Minimal .env reader/writer shared by the server and the CLI.
 * Keeps unrelated lines and comments intact.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');
const EXAMPLE_PATH = path.join(ROOT, '.env.example');

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function read() {
  return fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
}

/** Create .env from .env.example when missing. Returns true if created. */
function ensureFromExample() {
  if (fs.existsSync(ENV_PATH)) return false;
  if (fs.existsSync(EXAMPLE_PATH)) {
    fs.copyFileSync(EXAMPLE_PATH, ENV_PATH);
    return true;
  }
  fs.writeFileSync(ENV_PATH, '', 'utf8');
  return true;
}

function get(key) {
  const match = read().match(new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*(.*)$`, 'm'));
  if (!match) return undefined;
  let value = match[1].trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return value;
}

/** Set one or more KEY=value pairs, appending missing keys. */
function setMany(pairs) {
  let content = read();
  for (const [key, rawValue] of Object.entries(pairs)) {
    const value = rawValue == null ? '' : String(rawValue);
    const line = `${key}=${value}`;
    const re = new RegExp(`^${escapeRegExp(key)}=.*$`, 'm');
    if (re.test(content)) {
      content = content.replace(re, line);
    } else {
      content = content.replace(/\s*$/, '') + `\n${line}\n`;
    }
  }
  fs.writeFileSync(ENV_PATH, content, 'utf8');
}

function set(key, value) {
  setMany({ [key]: value });
}

module.exports = {
  ROOT,
  ENV_PATH,
  ensureFromExample,
  read,
  get,
  set,
  setMany,
};
