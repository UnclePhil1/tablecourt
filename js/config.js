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

  SUPABASE_URL: 'https://gnfqmmhniburnorbxdab.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImduZnFtbWhuaWJ1cm5vcmJ4ZGFiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk4MDc4NDgsImV4cCI6MjEwNTM4Mzg0OH0.2gaoDgoAFm7iLhcRQYT3W3w0I1-B5e0X70jTSKjvY5c',
  STREAM_API_KEY: 'tx29yg77tftp'
};