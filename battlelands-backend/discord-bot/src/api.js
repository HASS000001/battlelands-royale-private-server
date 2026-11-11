'use strict';

const BACKEND_URL = process.env.BACKEND_URL       || 'http://app:3000';
const API_TOKEN   = process.env.BACKEND_API_TOKEN || '';

/**
 * Authenticated request to the backend service.
 *
 * Routing logic:
 *   - paths starting with /discord  -> backend /discord/... (Discord-specific routes)
 *   - everything else               -> backend /Admin/...   (admin API)
 *
 * Both route groups verify the same `Authorization: Bearer <token>` +
 * `X-Bot-Source: discord` headers - one token for everything.
 */
async function apiCall(method, path, body = null) {
  const { default: fetch } = await import('node-fetch');

  const url  = path.startsWith('/discord')
    ? `${BACKEND_URL}${path}`
    : `${BACKEND_URL}/Admin${path}`;

  const opts = {
    method,
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${API_TOKEN}`,
      'X-Bot-Source':  'discord',
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const res  = await fetch(url, opts);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.errorMessage || json?.error || `HTTP ${res.status}`);
  return json?.data ?? json;
}

module.exports = { apiCall };
