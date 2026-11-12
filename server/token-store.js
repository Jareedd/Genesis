'use strict';

const fs = require('fs');
const path = require('path');
const { kvEnabled, kvCommand } = require('./kv');

// Where the live Tesla refresh token lives.
//
// Tesla rotates the refresh token on every refresh and invalidates the
// previous one, so TESLA_REFRESH_TOKEN is only a seed: after the first
// rotation it is dead. The rotated value therefore has to outlive the
// process. Render's filesystem is ephemeral (and disks are a paid feature),
// so a file alone loses the token on every deploy and every free-tier
// spin-down, which strands the app on the stale seed.
//
// Upstash is used when configured; the file is kept as the local-dev
// fallback so nothing extra is needed to run this on a laptop.

const KEY = process.env.TESLA_TOKEN_KEY || 'teslyr:tesla_refresh_token';
const FILE_PATH =
  process.env.TESLA_TOKEN_STORE || path.join(__dirname, '.token-store.json');

function usingRedis() {
  return kvEnabled();
}

function backend() {
  return usingRedis() ? 'upstash' : 'file';
}

function readFileToken() {
  try {
    const data = JSON.parse(fs.readFileSync(FILE_PATH, 'utf8'));
    if (data && typeof data.refresh_token === 'string' && data.refresh_token) {
      return data.refresh_token;
    }
  } catch {
    /* no store yet, or unreadable — the caller falls back to the env seed */
  }
  return null;
}

function writeFileToken(token) {
  fs.writeFileSync(
    FILE_PATH,
    JSON.stringify(
      { refresh_token: token, updatedAt: new Date().toISOString() },
      null,
      2
    ),
    { mode: 0o600 }
  );
}

async function readRefreshToken() {
  if (usingRedis()) {
    try {
      const value = await kvCommand(['GET', KEY]);
      if (typeof value === 'string' && value) return value;
      return null;
    } catch (err) {
      // Fall through to the file rather than booting with no token at all.
      console.error(`[tesla-lyrics] token store read failed: ${err.message}`);
    }
  }
  return readFileToken();
}

async function writeRefreshToken(token) {
  if (!token) return false;

  if (usingRedis()) {
    try {
      await kvCommand(['SET', KEY, token]);
      return true;
    } catch (err) {
      console.error(`[tesla-lyrics] token store write failed: ${err.message}`);
      // Keep a local copy so the token at least survives until this process
      // exits, instead of being lost outright.
    }
  }

  try {
    writeFileToken(token);
    return true;
  } catch (err) {
    console.error(`[tesla-lyrics] could not persist rotated refresh token: ${err.message}`);
    return false;
  }
}

module.exports = { readRefreshToken, writeRefreshToken, backend, usingRedis };
