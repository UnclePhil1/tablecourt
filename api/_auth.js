/* Table – knowing who is calling, on the server.
 *
 * Every endpoint under api/ can move money, so none of them may take the caller's word for who they
 * are. The browser sends the Supabase access token it already holds; this asks Supabase whose token it
 * is. A player id is never read from the request body.
 *
 * Two different keys are used here, and the difference matters:
 *
 *   The anon key identifies a caller. It is the same public key the browser has, and it can do nothing
 *   the browser could not already do.
 *
 *   The service key bypasses row-level security. It is what writes a payout record, and it exists only
 *   in the server's environment. It must never be sent to a browser, logged, or put in js/config.js.
 */
const { fail } = require('./_fossa');

const url = () => {
  const u = process.env.SUPABASE_URL;
  if (!u) throw fail(500, 'server-misconfigured', 'Staking is not configured on this server.');
  return u.replace(/\/+$/, '');
};
const anonKey = () => process.env.SUPABASE_ANON_KEY || '';
const serviceKey = () => {
  const k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!k) throw fail(500, 'server-misconfigured', 'Staking is not configured on this server.');
  return k;
};

/** Whose token this is, according to Supabase. Throws unless it is a real, current session. */
async function whoIs(req) {
  const auth = String(req.headers['authorization'] || '');
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) throw fail(401, 'signed-out', 'Sign in again, then try that once more.');

  const res = await fetch(url() + '/auth/v1/user', {
    headers: { apikey: anonKey(), Authorization: 'Bearer ' + token }
  });
  if (!res.ok) throw fail(401, 'signed-out', 'Sign in again, then try that once more.');
  const user = await res.json();
  if (!user || !user.id) throw fail(401, 'signed-out', 'Sign in again, then try that once more.');
  return { id: user.id, email: user.email || null, token };
}

/** A database function called with the caller's own rights, so their row-level security still applies. */
async function rpcAsUser(token, fn, args) {
  return post('/rest/v1/rpc/' + fn, args, { apikey: anonKey(), Authorization: 'Bearer ' + token });
}

/** A database function called as the server. Only for writes a player must not be able to make. */
async function rpcAsServer(fn, args) {
  return post('/rest/v1/rpc/' + fn, args, { apikey: serviceKey(), Authorization: 'Bearer ' + serviceKey() });
}

/** One row of a table, read as the server. Used for the facts a payout is decided from. */
async function selectAsServer(table, query) {
  const res = await fetch(url() + '/rest/v1/' + table + '?' + query, {
    headers: { apikey: serviceKey(), Authorization: 'Bearer ' + serviceKey() }
  });
  if (!res.ok) throw fail(502, 'db', 'Could not read the match.', { body: await res.text() });
  return res.json();
}

async function patchAsServer(table, query, body) {
  const res = await fetch(url() + '/rest/v1/' + table + '?' + query, {
    method: 'PATCH',
    headers: {
      apikey: serviceKey(), Authorization: 'Bearer ' + serviceKey(),
      'Content-Type': 'application/json', Prefer: 'return=representation'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw fail(502, 'db', 'Could not record that.', { body: await res.text() });
  return res.json();
}

async function post(path, body, headers) {
  const res = await fetch(url() + path, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
    body: JSON.stringify(body || {})
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try { msg = (JSON.parse(text).message) || text; } catch (e) { /* keep the raw text */ }
    throw fail(res.status === 401 || res.status === 403 ? 403 : 502, 'db', msg, { path });
  }
  return text ? JSON.parse(text) : null;
}

/* ---------- the shape every endpoint shares ---------- */

/**
 * Wraps a handler so that a thrown error becomes a sentence for the player and a line in the log,
 * never a stack trace in the response. Anything unrecognised is reported as a generic failure: an
 * internal message could name a table, a provider, or an amount that is nobody else's business.
 */
function handler(fn) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const out = await fn(req, res);
      if (!res.writableEnded) res.status(200).json(out === undefined ? { ok: true } : out);
    } catch (e) {
      const status = e && e.status ? e.status : 500;
      const say = e && e.say ? e.say : 'Something went wrong handling that payment.';
      console.error('[table:api]', req.url, e && e.code, e && e.message, e && e.detail ? JSON.stringify(e.detail) : '');
      if (!res.writableEnded) res.status(status).json({ error: { code: (e && e.code) || 'unexpected', message: say } });
    }
  };
}

/** Refuses anything but the method an endpoint is written for. */
function only(method, req) {
  if (req.method !== method) throw fail(405, 'method', 'That is not how this is called.');
}

module.exports = { whoIs, rpcAsUser, rpcAsServer, selectAsServer, patchAsServer, handler, only };
