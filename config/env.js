'use strict';

// Centralized environment bootstrap.
//
// Every executable entrypoint (server.js, index.js, scripts/verifyFirebaseAdmin.js)
// requires this module FIRST so that `.env` is loaded from an absolute path before
// any application configuration is consumed.
//
// Precedence is intentionally: real process environment > `.env` fallback.
// dotenv is called without `override` so PM2/shell variables are never replaced.

const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const ENV_FILE = path.join(ROOT_DIR, '.env');
const DEFAULT_PORT = 3000;

let dotenvError = null;
try {
  const result = require('dotenv').config({ path: ENV_FILE });
  dotenvError = result.error || null;
} catch (error) {
  dotenvError = error;
}

// Parse PORT safely. An invalid value must not be passed to server.listen(),
// which would otherwise treat a non-numeric string as a named pipe.
function parsePort(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_PORT;
  const parsed = Number(String(raw).trim());
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) return null;
  return parsed;
}

const parsedPort = parsePort(process.env.PORT);
if (parsedPort === null) {
  console.warn(`[CONFIG] Invalid PORT=${JSON.stringify(process.env.PORT)}; falling back to ${DEFAULT_PORT}`);
  process.env.PORT = String(DEFAULT_PORT);
} else {
  process.env.PORT = String(parsedPort);
}

function isProduction() {
  return String(process.env.NODE_ENV || '').toLowerCase() === 'production';
}

function isAdminPasswordSet() {
  return typeof process.env.ADMIN_PASSWORD === 'string' && process.env.ADMIN_PASSWORD.length > 0;
}

function hasFirebaseFileCredential() {
  return Boolean(process.env.FIREBASE_SERVICE_ACCOUNT_FILE || process.env.GOOGLE_APPLICATION_CREDENTIALS);
}

// Safe diagnostics: only reports whether a value is set, never the value itself.
function logConfigSummary() {
  console.log(`[CONFIG] NODE_ENV=${process.env.NODE_ENV || 'development'}`);
  console.log(`[CONFIG] PORT=${process.env.PORT}`);
  console.log(`[CONFIG] ADMIN_PASSWORD=${isAdminPasswordSet() ? 'set' : 'missing'}`);
  console.log(`[CONFIG] FIREBASE_SERVICE_ACCOUNT_FILE=${hasFirebaseFileCredential() ? 'set' : 'unset'}`);
  if (!isAdminPasswordSet()) {
    console.warn('[CONFIG] ADMIN_PASSWORD is not set. Dashboard login cannot succeed until it is configured.');
  }
  if (dotenvError && dotenvError.code !== 'ENOENT') {
    console.warn(`[CONFIG] Could not load ${ENV_FILE}: ${dotenvError.message}`);
  }
}

// Fail fast in production when the dashboard would be unusable/unsafe.
// Outside production this is a no-op so local/dev/test behavior is unchanged.
function assertValidConfig({ requireAdminPassword = false } = {}) {
  if (requireAdminPassword && isProduction() && !isAdminPasswordSet()) {
    throw new Error('[CONFIG] ADMIN_PASSWORD is required in production. Set it in .env (or the real process environment) and restart.');
  }
}

logConfigSummary();

module.exports = {
  ROOT_DIR,
  ENV_FILE,
  DEFAULT_PORT,
  isProduction,
  isAdminPasswordSet,
  hasFirebaseFileCredential,
  logConfigSummary,
  assertValidConfig,
};
