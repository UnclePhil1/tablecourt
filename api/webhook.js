/* POST /api/webhook  — what FossaPay tells us, after the fact
 *
 * FossaPay signs the `data` object of each event with HMAC-SHA256 using the webhook secret, and sends
 * the digest in x-fossapay-signature. An unsigned or wrongly signed request is refused: this is a
 * public URL, and anything that acted on an unverified body would be acting on whatever a stranger
 * chose to post to it.
 *
 * What this endpoint deliberately does NOT do is move money or settle anything. Every payout in this
 * game is driven by an explicit request from a player, checked against the database at the time. A
 * webhook is a notification, it can be replayed, it can arrive late, and it can arrive five times —
 * so it is used to observe, never to decide. That means a missed delivery cannot cost anybody their
 * stake, which is the property worth having.
 *
 * It answers 200 immediately. FossaPay retries up to five times on anything else, and a slow handler
 * turns one event into five.
 */
const { verifyWebhook } = require('./_fossa');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    // A browser opening this URL should get something honest rather than a crash.
    res.status(405).json({ error: 'This endpoint only accepts signed POSTs from FossaPay.' });
    return;
  }

  /* The signature is over JSON.stringify(body.data), not the whole envelope and not the raw bytes,
     which is what lets this work with an already-parsed body. */
  const body = req.body && typeof req.body === 'object' ? req.body : safeParse(req.body);
  const raw = typeof req.body === 'string' ? req.body : JSON.stringify(body || {});
  const signature = req.headers['x-fossapay-signature'] || req.headers['x-fossapay-Signature'];

  if (!body || !verifyWebhook(raw, signature)) {
    console.warn('[table:webhook] refused an unsigned or badly signed delivery',
      req.headers['x-event-type'] || '', req.headers['x-event-id'] || '');
    res.status(401).json({ error: 'Invalid signature' });
    return;
  }

  // Acknowledge first. Anything after this point is observation and must not delay the response.
  res.status(200).json({ received: true });

  const type = body.eventType || req.headers['x-event-type'] || 'unknown';
  const id = body.eventId || req.headers['x-event-id'] || '';
  const retry = req.headers['x-retry-count'];
  const d = body.data || {};

  /* Logged rather than stored. Deduplication needs somewhere to keep event ids, and there is nowhere
     yet — which is safe only because nothing here changes any state. The moment this endpoint is made
     to do something, it needs an events table with a unique constraint on the id first, or a retry
     will do that something twice. */
  console.log('[table:webhook]', type, id, retry ? '(retry ' + retry + ')' : '',
    JSON.stringify({
      reference: d.reference, status: d.status,
      amount: d.amount, currency: d.currency,
      transactionId: d.transactionId || d.id
    }));
};

function safeParse(s) {
  try { return JSON.parse(s); } catch (e) { return null; }
}
