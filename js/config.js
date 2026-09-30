/* Table – settings.
   The URL is your Supabase project. The key below is the PUBLIC "anon" or "publishable" key
   (Supabase dashboard > Project Settings > API). It is safe to put in browser code.
   Never paste the "service_role" or "secret" key here. */
window.TABLE_CONFIG = {
  /* Camera and mic in a 1v1 go straight between the two players. These public STUN servers are enough
     to introduce them through most home routers. Roughly one connection in six cannot be made that
     way — strict company networks, some mobile carriers — and needs a paid TURN relay. Add one here
     and it will be used automatically; leave it empty and those players simply get no video:
       ICE_EXTRA: [{ urls: 'turn:your.host:3478', username: '...', credential: '...' }]  */
  ICE_EXTRA: [],

  /* No FossaPay key here, ever.

     This file is downloaded by every visitor, so anything in it is public. A FossaPay key authorises
     moving the merchant's money, and FossaPay has no sandbox — every key is a production key. Their
     own documentation is explicit: keep API keys on your server, and rotate an exposed one at once.

     A FossaPay integration needs a server. There is no arrangement of this file that makes one safe. */

  SUPABASE_URL: 'https://gnfqmmhniburnorbxdab.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImduZnFtbWhuaWJ1cm5vcmJ4ZGFiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk4MDc4NDgsImV4cCI6MjEwNTM4Mzg0OH0.2gaoDgoAFm7iLhcRQYT3W3w0I1-B5e0X70jTSKjvY5c',
  STREAM_API_KEY: 'tx29yg77tftp',

  /* Staking.

     Money is held and moved by the server in api/, which is the only thing holding a FossaPay key.
     There is nothing to configure here and nothing that could be: every setting that matters is an
     environment variable on the server, listed in api/README.md.

     Three states:
       true    players can stake a match
       'soon'  the controls are shown but cannot be used, marked coming soon
       false   staking is absent from the interface entirely

     'soon' does not switch the money off. Anyone who has already put funds in can still see their
     balance and take it out, and a match already staked can still be settled — stopping new matches
     is not a reason to strand somebody's money. */
  STAKING: 'soon'
};