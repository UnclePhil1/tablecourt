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
  STREAM_API_KEY: 'tx29yg77tftp',

  /* Staking. DEVNET ONLY: these coins are worthless and the network is a test one.

     STAKE_MINT is the token players put up. Today it is a test token created by tools/chain/mint.mjs,
     whose supply we control, so testing does not depend on anybody's faucet. Going to mainnet means
     three edits together — the cluster, the RPC, and the mint to real USDC
     (EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v) — and they must move as one. A mainnet mint against
     a devnet RPC would silently stake nothing at all.

     Leave STAKE_MINT empty and staking disappears from the interface entirely; the game plays exactly
     as it did before. */
  STAKE_CLUSTER: 'devnet',
  SOLANA_RPC: 'https://api.devnet.solana.com',
  STAKE_MINT: '8kF6wfnE8MPzWuroVRsFxMEpepyJDiF9z7t1mhdxhhGm'
};