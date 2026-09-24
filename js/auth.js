/* Table – accounts, using Supabase.
   Email + password: normal Supabase sign-in.
   Wallet: no Supabase sign-in. The app connects an external Solana wallet, then saves the wallet address and username
   in the database through the functions in supabase/schema.sql. See the note about trust in README.md. */
const Auth = (function () {
  const cfg = window.TABLE_CONFIG || {};
  const hasKey = !!cfg.SUPABASE_URL && !!cfg.SUPABASE_ANON_KEY && !/PASTE_|YOUR_/.test(cfg.SUPABASE_ANON_KEY);
  const enabled = hasKey && !!window.supabase;
  const sb = enabled ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } }) : null;
  const listeners = [], WKEY = 'table_wallet';
  let user = null, emailProfile = null, walletProfile = null, lastSaveError = null;

  const USERNAME = /^[a-z0-9_]{3,16}$/, ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  const clean = s => String(s || '').trim().toLowerCase();
  const notify = () => listeners.forEach(f => { try { f(); } catch (e) { console.error(e); } });
  const store = { get() { try { return localStorage.getItem(WKEY); } catch (e) { return null; } }, set(v) { try { localStorage.setItem(WKEY, v); } catch (e) {} }, del() { try { localStorage.removeItem(WKEY); } catch (e) {} } };
  // Kept for callers that only want the sentence; js/errors.js does the actual work.
  const nice = (e, where) => Err.say(e, where || 'account');

  async function loadProfile() {
    if (!sb || !user) return null;
    const { data, error } = await sb.from('profiles').select('id,username,wallet,wins,losses').eq('id', user.id).maybeSingle();
    if (error) { Err.log(error, 'load profile'); return null; }
    return data;
  }
  async function setSession(session) {
    user = session ? session.user : null;
    emailProfile = user ? await loadProfile() : null;
    notify();
  }
  async function init() {
    if (!enabled) return;
    const { data } = await sb.auth.getSession();
    await setSession(data.session);
    sb.auth.onAuthStateChange((_e, s) => setTimeout(() => setSession(s), 0));   // never call Supabase inside this callback directly
    const w = store.get();
    if (w && !emailProfile) { try { await walletLogin(w); } catch (e) { Err.log(e, 'resume wallet session'); } }
  }

  // Is the database set up, and is it the current version? Used by the sign-in screen so a missing
  // step shows as "run supabase/schema.sql" instead of a puzzling error in the middle of signing in.
  // The schema reports what it has built as a set of booleans. Rather than keep a copy of that list
  // here (which drifts the moment schema.sql gains a line), require every key it reports to be true,
  // and check the version as well so an OLD schema that never mentions the new keys still fails.
  const WANT_VERSION = 8;
  let setupCache = null;
  async function checkSetup() {
    if (!enabled) return { ok: false, reason: 'no-key' };
    if (setupCache) return setupCache;
    const { data, error } = await sb.rpc('table_setup_check');
    if (error) {
      const stale = /could not find the function|schema cache/i.test(error.message || '');
      setupCache = stale ? { ok: false, reason: 'old-schema' } : { ok: false, reason: 'unreachable', detail: error.message };
      return setupCache;
    }
    const missing = Object.keys(data || {}).filter(k => k !== 'version' && data[k] !== true);
    const behind = !data || (data.version || 0) < WANT_VERSION;
    setupCache = (missing.length || behind) ? { ok: false, reason: 'incomplete', missing, behind } : { ok: true };
    return setupCache;
  }
  const setupHint = r => r.ok ? '' :
    r.reason === 'no-key' ? 'Sign-in is not set up yet. Add your Supabase key in js/config.js. You can still play as a guest.' :
    r.reason === 'unreachable' ? 'Could not reach the database. You can still play as a guest.' :
    'Your database is out of date. Open Supabase > SQL Editor, paste supabase/schema.sql and run it. You can still play as a guest.';

  async function usernameFree(name) {
    const { data, error } = await sb.rpc('username_available', { name });
    if (error) throw error;
    return !!data;
  }
  async function signUp({ username, email, password, next }) {
    username = clean(username);
    if (!USERNAME.test(username)) throw new Error('Username: 3 to 16 letters, numbers or _');
    if (!(await usernameFree(username))) throw new Error('That username is taken.');
    // Without emailRedirectTo the confirmation link follows the project's Site URL, which is why a
    // link mailed from the live site can land on localhost. Send people back where they signed up,
    // carrying the match they were invited to so the link still works after confirming.
    const { data, error } = await sb.auth.signUp({
      email: clean(email), password,
      options: { data: { username }, emailRedirectTo: confirmUrl(next) }
    });
    if (error) throw error;
    return { needsConfirm: !data.session };
  }
  const confirmUrl = next => location.origin + location.pathname + (next || '');
  async function signIn({ email, password }) {
    const { error } = await sb.auth.signInWithPassword({ email: clean(email), password });
    if (error) throw error;
  }
  async function resendConfirmation(email, next) {
    const { error } = await sb.auth.resend({ type: 'signup', email: clean(email), options: { emailRedirectTo: confirmUrl(next) } });
    if (error) throw error;
  }

  // Wallet accounts: look the address up, or register it with a username
  async function walletLogin(address) {
    if (!ADDRESS.test(address)) throw new Error('That does not look like a Solana address.');
    const { data, error } = await sb.rpc('wallet_login', { w: address });
    if (error) throw error;
    if (data) { walletProfile = data; store.set(address); notify(); }
    return data || null;
  }
  async function walletRegister(address, username) {
    username = clean(username);
    if (!ADDRESS.test(address)) throw new Error('That does not look like a Solana address.');
    if (!USERNAME.test(username)) throw new Error('Username: 3 to 16 letters, numbers or _');
    const { data, error } = await sb.rpc('wallet_register', { w: address, uname: username });
    if (error) throw error;
    walletProfile = data; store.set(address); notify();
    return data;
  }

  async function signOut() {
    if (sb && user) await sb.auth.signOut();
    user = null; emailProfile = null; walletProfile = null; store.del(); notify();
  }
  async function saveMatch(row) {
    if (!sb) return false;
    if (emailProfile) {
      const { error } = await sb.from('matches').insert(row);
      if (error) { lastSaveError = error; Err.log(error, 'save match'); return false; }
      emailProfile = await loadProfile();
    } else if (walletProfile) {
      const { data, error } = await sb.rpc('wallet_save_match', { w: walletProfile.wallet, lvl: row.level, ps: row.player_score, cs: row.cpu_score, did_win: row.won, longest: row.longest_rally });
      if (error) { lastSaveError = error; Err.log(error, 'save match'); return false; }
      if (data) walletProfile = data;
    } else return false;
    notify(); return true;
  }

  return {
    enabled, hasKey, USERNAME, ADDRESS, clean, nice, init, signUp, signIn, resendConfirmation, walletLogin, walletRegister, signOut, saveMatch, usernameFree,
    checkSetup, setupHint,
    onChange: f => listeners.push(f),
    get client() { return sb; },                                    // js/net.js shares this connection
    get wallet() { return walletProfile ? walletProfile.wallet : null; },   // wallet players identify themselves with it
    get username() { return (emailProfile || walletProfile || {}).username || null; },
    get lastSaveError() { return lastSaveError; },   // so the arena can say why a result did not save
    get profile() { return emailProfile || walletProfile; },
    get signedIn() { return !!(emailProfile || walletProfile); }
  };
})();
