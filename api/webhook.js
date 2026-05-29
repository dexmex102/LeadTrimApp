/**
 * Vercel Serverless Function - Lemon Squeezy Webhook Handler
 * Path: /api/webhook
 *
 * Production-ready handler for order_created events.
 */

import crypto from 'crypto';

// Disable Vercel's automatic body parsing (critical for signature verification)
export const config = {
  api: {
    bodyParser: false,
  },
};

/**
 * Reads the raw request body as a Buffer.
 * Required for HMAC signature verification.
 */
async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Verifies the Lemon Squeezy webhook signature.
 * @param {Buffer} rawBody
 * @param {string} signature
 * @param {string} secret
 */
function verifySignature(rawBody, signature, secret) {
  if (!signature || !secret) {
    return false;
  }

  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(rawBody);
  const computedSignature = hmac.digest('hex');

  // Use timing-safe comparison
  return crypto.timingSafeEqual(
    Buffer.from(computedSignature, 'hex'),
    Buffer.from(signature, 'hex')
  );
}

/**
 * Maps Lemon Squeezy Variant IDs to credit amounts.
 * These must match exactly what you configured in Lemon Squeezy.
 */
const VARIANT_CREDITS = {
  '1718509': 2500,   // Pilot   (€29)
  '1718563': 10000,  // Agency  (€99)
  '1720785': 50000,  // Scale   (€249)
};

/**
 * TODO: Replace this function with your actual database logic.
 *
 * Examples:
 * - Vercel Postgres: await sql`UPDATE users SET credits = credits + ${amount} WHERE email = ${email}`
 * - Supabase: await supabase.from('users').update({ credits: ... }).eq('email', email)
 * - Upstash Redis, PlanetScale, MongoDB, etc.
 */
async function addCreditsToUser(email, creditsToAdd) {
  if (!email || !creditsToAdd) return;

  console.log(`[LemonSqueezy] Adding ${creditsToAdd} credits to ${email}`);

  // === IMPLEMENT YOUR DATABASE UPDATE HERE ===
  // Example with @vercel/postgres:
  //
  // import { sql } from '@vercel/postgres';
  // await sql`
  //   INSERT INTO users (email, credits)
  //   VALUES (${email}, ${creditsToAdd})
  //   ON CONFLICT (email)
  //   DO UPDATE SET credits = users.credits + ${creditsToAdd}, updated_at = NOW()
  // `;
}

/**
 * Main Webhook Handler
 */
export default async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const SIGNING_SECRET = process.env.LEMON_SQUEEZY_WEBHOOK_SECRET || 'my_super_secret_lemon_123';

  try {
    // 1. Read raw body (must be done before any parsing)
    const rawBody = await getRawBody(req);

    // 2. Get signature from headers (Lemon Squeezy sends it as 'X-Signature')
    const signature = req.headers['x-signature'] || req.headers['X-Signature'];

    // 3. Verify signature
    const isValid = verifySignature(rawBody, signature, SIGNING_SECRET);

    if (!isValid) {
      console.warn('[LemonSqueezy] Invalid webhook signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    // 4. Parse the event
    const event = JSON.parse(rawBody.toString('utf8'));

    // 5. Handle only order_created events (ignore others)
    if (event?.meta?.event_name !== 'order_created') {
      return res.status(200).json({ received: true, ignored: event?.meta?.event_name });
    }

    // 6. Extract useful data from Lemon Squeezy payload
    const attributes = event.data?.attributes || {};
    const customerEmail =
      attributes.user_email ||
      attributes.customer?.email ||
      attributes.billing_email;

    // Try multiple possible locations for variant_id
    let variantId = null;
    if (attributes.first_order_item?.variant_id) {
      variantId = String(attributes.first_order_item.variant_id);
    } else if (Array.isArray(attributes.order_items) && attributes.order_items[0]?.variant_id) {
      variantId = String(attributes.order_items[0].variant_id);
    }

    const isTestMode = !!event.meta?.test_mode;

    if (!customerEmail || !variantId) {
      console.warn('[LemonSqueezy] Missing email or variant_id in payload');
      return res.status(200).json({ received: true, warning: 'Missing data' });
    }

    // 7. Map variant to credits
    const creditsToAdd = VARIANT_CREDITS[variantId];

    if (!creditsToAdd) {
      console.warn(`[LemonSqueezy] Unknown variant_id: ${variantId}`);
      return res.status(200).json({ received: true, warning: 'Unknown variant' });
    }

    // 8. Add credits to the user (implement DB logic above)
    await addCreditsToUser(customerEmail.toLowerCase().trim(), creditsToAdd);

    console.log(
      `[LemonSqueezy] ${isTestMode ? '[TEST] ' : ''}Order processed: ${variantId} → +${creditsToAdd} credits for ${customerEmail}`
    );

    // 9. Always return 200 quickly
    return res.status(200).json({
      received: true,
      variant_id: variantId,
      credits_added: creditsToAdd,
      email: customerEmail,
      test_mode: isTestMode,
    });

  } catch (error) {
    console.error('[LemonSqueezy] Webhook error:', error);
    // Still return 200 to prevent Lemon Squeezy from retrying excessively
    return res.status(200).json({ received: true, error: 'Internal processing error' });
  }
}
