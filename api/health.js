/* GET /api/health  — is the server set up, and can it reach what it needs?
 *
 * For the ten minutes after a deploy when something does not work and the question is whether it is
 * the code, the environment, or the provider. Without this the only symptom a player sees is
 * "Staking is not configured on this server", which is true but says nothing about which part.
 *
 * It reports whether each secret is *present*, never what any of them is. A key that shows up in a
 * diagnostic page is a key in whatever logs, screenshots, and support threads that page reaches.
 *
 * It is a read. It creates no customer, opens no wallet, and moves nothing.
 */
const BASE = process.env.FOSSAPAY_BASE_URL || 'https://api-production.fossapay.com';

const present = v => (v ? 'set' : 'MISSING');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  const env = {
    FOSSAPAY_API_KEY: present(process.env.FOSSAPAY_API_KEY),
    FOSSAPAY_WEBHOOK_SECRET: present(process.env.FOSSAPAY_WEBHOOK_SECRET),
    SUPABASE_URL: present(process.env.SUPABASE_URL),
    SUPABASE_ANON_KEY: present(process.env.SUPABASE_ANON_KEY),
    SUPABASE_SERVICE_ROLE_KEY: present(process.env.SUPABASE_SERVICE_ROLE_KEY)
  };
  const missing = Object.keys(env).filter(k => env[k] === 'MISSING');

  const out = { ok: !missing.length, env, missing, checks: {} };

  /* Does the FossaPay key actually work, and is there a master wallet to hold pots in? Reading the
     master wallet is the cheapest call that proves both at once. */
  if (process.env.FOSSAPAY_API_KEY) {
    try {
      const r = await fetch(BASE + '/api/v1/wallets/crypto/master', {
        headers: { 'x-api-key': process.env.FOSSAPAY_API_KEY },
        signal: AbortSignal.timeout(12000)
      });
      if (r.status === 401) {
        out.checks.fossapay = 'the key was refused (401) — wrong key, or not yet active';
        out.ok = false;
      } else if (!r.ok) {
        out.checks.fossapay = 'answered ' + r.status;
        out.ok = false;
      } else {
        const body = await r.json().catch(() => null);
        const data = body && (body.data !== undefined ? body.data : body);
        const rows = Array.isArray(data) ? data : (data && (data.addresses || data.wallets)) || [];
        const sol = rows.find(x => String(x.network || x.chain || 'solana').toLowerCase() === 'solana')
                 || (data && data.address ? data : null);
        const addr = sol && (sol.address || sol.walletAddress || sol.solanaAddress);
        // Enough of the address to recognise, not enough to be useful on its own.
        out.checks.fossapay = addr
          ? 'reachable; master wallet ' + String(addr).slice(0, 4) + '…' + String(addr).slice(-4)
          : 'reachable, but no Solana master wallet was found — pots would have nowhere to go';
        if (!addr) out.ok = false;
      }
    } catch (e) {
      out.checks.fossapay = 'could not be reached: ' + (e && e.name === 'TimeoutError' ? 'timed out' : String(e && e.message || e));
      out.ok = false;
    }
  }

  /* And the database, including whether the schema is new enough for the staking columns to exist. */
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const k = process.env.SUPABASE_SERVICE_ROLE_KEY;
      const r = await fetch(process.env.SUPABASE_URL.replace(/\/+$/, '') + '/rest/v1/rpc/table_setup_check', {
        method: 'POST',
        headers: { apikey: k, Authorization: 'Bearer ' + k, 'Content-Type': 'application/json' },
        body: '{}', signal: AbortSignal.timeout(12000)
      });
      if (!r.ok) {
        out.checks.database = 'answered ' + r.status;
        out.ok = false;
      } else {
        const d = await r.json();
        const absent = Object.keys(d || {}).filter(x => d[x] === false);
        out.checks.database = 'schema version ' + (d && d.version);
        out.checks.schemaWanted = 13;
        if (!d || d.version < 13) {
          out.checks.database += ' — too old, run supabase/upgrade-to-13.sql';
          out.ok = false;
        }
        if (absent.length) { out.checks.databaseMissing = absent; out.ok = false; }

        /* And prove the service key is actually a service key.
           table_setup_check is granted to anon, so it answers for the public key too — meaning this
           check passed happily with the wrong key pasted in, and the first real failure would have
           been a payout. Reading games is blocked by row-level security for anon and allowed for the
           service role, so it is the cheapest thing that can tell the two apart. */
        const probe = await fetch(process.env.SUPABASE_URL.replace(/\/+$/, '') + '/rest/v1/games?select=code&limit=1', {
          headers: { apikey: k, Authorization: 'Bearer ' + k }, signal: AbortSignal.timeout(12000)
        });
        if (probe.status === 401 || probe.status === 403) {
          out.checks.serviceKey = 'that is not a service key — row-level security still applies to it, '
            + 'so payouts and stake records cannot be written';
          out.ok = false;
        } else if (!probe.ok) {
          out.checks.serviceKey = 'could not be checked (' + probe.status + ')';
          out.ok = false;
        } else {
          out.checks.serviceKey = 'has the rights it needs';
        }
      }
    } catch (e) {
      out.checks.database = 'could not be reached: ' + String(e && e.message || e);
      out.ok = false;
    }
  }

  res.status(out.ok ? 200 : 503).json(out);
};
