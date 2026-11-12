'use strict';

const axios = require('axios');

// Thin client for the Upstash Redis REST API. Shared by the token store and
// the lyrics cache. Every call is best-effort: callers treat a failure as a
// cache miss, never as fatal.

const REDIS_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';

function kvEnabled() {
  return Boolean(REDIS_URL && REDIS_TOKEN);
}

async function kvCommand(command, timeoutMs = 8000) {
  const res = await axios.post(REDIS_URL, command, {
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    timeout: timeoutMs,
    validateStatus: () => true,
  });
  if (res.status >= 400) {
    throw new Error(`Upstash ${res.status}: ${JSON.stringify(res.data)}`);
  }
  return res.data ? res.data.result : null;
}

async function kvGetJson(key, timeoutMs = 2500) {
  if (!kvEnabled()) return null;
  try {
    const raw = await kvCommand(['GET', key], timeoutMs);
    return typeof raw === 'string' ? JSON.parse(raw) : null;
  } catch (err) {
    console.error(`[tesla-lyrics] kv read failed for ${key}: ${err.message}`);
    return null;
  }
}

async function kvSetJson(key, value, ttlSeconds) {
  if (!kvEnabled()) return false;
  try {
    const command = ['SET', key, JSON.stringify(value)];
    if (ttlSeconds) command.push('EX', String(Math.round(ttlSeconds)));
    await kvCommand(command, 4000);
    return true;
  } catch (err) {
    console.error(`[tesla-lyrics] kv write failed for ${key}: ${err.message}`);
    return false;
  }
}

module.exports = { kvEnabled, kvCommand, kvGetJson, kvSetJson };
