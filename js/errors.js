/* Table – one place that turns a failure into something useful.

   Every problem surfaces twice. The player gets a plain sentence saying what happened and what to do
   about it, with no error codes or database jargon. Whoever is fixing the game gets a labelled console
   group with the code, the original error and the stack, and can also read the technical line straight
   off the page by pressing Details, which matters when the bug only happens on someone's phone.

   The rules are ordered and the first match wins, so put the specific ones first. Anything the
   database raises itself (P0001) is already written for players in supabase/schema.sql, so it is
   passed straight through rather than translated twice. */
const Err = (function () {
  const text = e => {
    if (!e) return '';
    if (typeof e === 'string') return e;
    return [e.message, e.details, e.hint, e.error_description].filter(Boolean).join(' — ') || String(e);
  };
  const has = (e, re) => re.test(text(e));

  const RULES = [
    // Keep this narrow. A bare /denied|cancel/ also swallows "permission denied for table ..." and
    // Postgres's "canceling statement due to statement timeout", which are not the player's doing.
    { code: 'wallet-cancelled',
      is: e => (e && e.code === 4001) || has(e, /user (rejected|denied|cancell?ed)|rejected the request|request (was )?cancell?ed|approval cancell?ed/i),
      say: 'You cancelled the wallet request.', fix: 'Approve the pop-up in your wallet to carry on.' },
    { code: 'wallet-missing', is: e => has(e, /no solana wallet|wallet did not share/i),
      say: 'No Solana wallet answered.', fix: 'Install Phantom, unlock it, then try again.' },

    { code: 'offline', is: e => has(e, /failed to fetch|networkerror|network request failed|load failed|err_internet/i),
      say: 'Cannot reach the server.', fix: 'Check your internet connection and try again.' },
    { code: 'timeout', is: e => has(e, /timeout|timed out|etimedout/i),
      say: 'The server took too long to answer.', fix: 'Try again in a moment.' },
    { code: 'match-server', is: e => has(e, /match server|channel_error|subscribe/i),
      say: 'Lost the connection to the match.', fix: 'Go back to 1v1 online and open the match again.' },

    { code: 'setup-incomplete', is: e => (e && e.code === 'PGRST202') || has(e, /could not find the function|schema cache/i),
      say: 'This game is not finished setting up.', fix: 'If it is yours, run supabase/schema.sql in the Supabase SQL Editor.' },
    { code: 'not-allowed', is: e => (e && e.code === '42501') || has(e, /permission denied|row-level security|not authorized/i),
      say: 'You are not allowed to do that.', fix: 'Sign in again, then retry.' },
    { code: 'taken', is: e => (e && e.code === '23505') || has(e, /duplicate key|unique constraint|already exists/i),
      say: 'That name is already taken.', fix: 'Pick a different one.' },

    { code: 'bad-password', is: e => has(e, /invalid login credentials/i),
      say: 'Wrong email or password.', fix: 'Check them and try again.' },
    { code: 'unconfirmed', is: e => has(e, /email not confirmed|not confirmed/i),
      say: 'Your email address is not confirmed yet.', fix: 'Open the link in the email we sent, then sign in.' },
    { code: 'email-taken', is: e => has(e, /already registered|already been registered|user already exists/i),
      say: 'That email already has an account.', fix: 'Sign in instead, or use another address.' },
    { code: 'weak-password', is: e => has(e, /password.*(short|least|weak|characters)/i),
      say: 'That password is too weak.', fix: 'Use at least 8 characters.' },
    { code: 'rate-limited', is: e => has(e, /rate limit|too many requests|429/i),
      say: 'Too many attempts.', fix: 'Wait a minute, then try again.' },

    { code: 'no-storage', is: e => has(e, /quota|storage|indexeddb/i),
      say: 'This browser will not let the game save anything.', fix: 'Turn off private browsing, or allow site data.' },

    // Our own database rules already speak to players: "That match is already full." and so on.
    { code: 'rule', is: e => e && e.code === 'P0001', say: null }
  ];

  function translate(e) {
    const technical = text(e) || 'no message';
    for (const r of RULES) {
      let hit = false;
      try { hit = r.is(e); } catch (x) { hit = false; }
      if (!hit) continue;
      return { code: r.code, say: r.say || technical, fix: r.say ? (r.fix || '') : '', technical };
    }
    return { code: 'unexpected', say: 'Something went wrong.', fix: 'Try again. If it keeps happening, reload the page.', technical };
  }

  // The developer half: one collapsed group per problem, with everything needed to chase it.
  function log(e, where) {
    const t = translate(e);
    try {
      console.groupCollapsed('Table · ' + (where || 'error') + ' · ' + t.code);
      console.log('player sees :', (t.say + ' ' + t.fix).trim());
      console.log('technical   :', t.technical);
      if (e && e.code) console.log('code        :', e.code);
      if (e && e.stack) console.log(e.stack);
      console.log('raw         :', e);
      console.groupEnd();
    } catch (x) { /* a console that does not support groups */ }
    return t;
  }

  // The player half: log it, then hand back the sentence to put on screen.
  function say(e, where) {
    const t = log(e, where);
    return (t.say + (t.fix ? ' ' + t.fix : '')).trim();
  }

  /* ---------- the banner, for problems that belong to no particular form ---------- */
  let el, elText, elFix, elTech, elDetails;
  function grab() {
    if (el) return el;
    el = document.getElementById('problem');
    if (!el) return null;
    elText = document.getElementById('problemText');
    elFix = document.getElementById('problemFix');
    elTech = document.getElementById('problemTech');
    elDetails = document.getElementById('problemDetails');
    elDetails.onclick = () => {
      elTech.hidden = !elTech.hidden;
      elDetails.textContent = elTech.hidden ? 'Details' : 'Hide details';
    };
    document.getElementById('problemClose').onclick = hide;
    return el;
  }
  function show(e, where) {
    const t = log(e, where);
    if (!grab()) return t;
    elText.textContent = t.say;
    elFix.textContent = t.fix;
    elTech.textContent = (where ? where + ': ' : '') + t.technical;
    elTech.hidden = true;
    elDetails.textContent = 'Details';
    el.hidden = false;
    return t;
  }
  function hide() { if (grab()) { el.hidden = true; elTech.hidden = true; } }

  /* ---------- nothing should fail silently ---------- */
  // Without these a thrown error leaves the game looking frozen with no clue why.
  addEventListener('error', ev => {
    if (ev.filename || ev.error) show(ev.error || ev.message, 'uncaught');
  });
  addEventListener('unhandledrejection', ev => show(ev.reason, 'unhandled promise'));

  return { translate, log, say, show, hide };
})();
