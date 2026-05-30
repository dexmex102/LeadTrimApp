/**
 * Vercel Serverless Function - Lemon Squeezy Webhook Handler
 * Path: /api/webhook
 *
 * Production-ready handler for order_created events.
 */

import crypto from 'crypto';
import { addCredits } from '../lib/db.js';
import { Resend } from 'resend';

// Disable Vercel's automatic body parsing (critical for signature verification)
export const config = {
  api: {
    bodyParser: false,
  },
};

/**
 * Reads the raw request body as a Buffer.
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
 */
function verifySignature(rawBody, signature, secret) {
  if (!signature || !secret) return false;

  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(rawBody);
  const computed = hmac.digest('hex');

  return crypto.timingSafeEqual(
    Buffer.from(computed, 'hex'),
    Buffer.from(signature, 'hex')
  );
}

/**
 * Maps Lemon Squeezy Variant IDs to credit amounts.
 */
const VARIANT_CREDITS = {
  '1718509': 2500,   // Pilot
  '1718563': 10000,  // Agency
  '1720785': 50000,  // Scale
};

async function addCreditsToUser(email, creditsToAdd) {
  console.log(`[DB] Starting credit addition for ${email} → +${creditsToAdd}`);

  if (!email || !creditsToAdd) {
    console.warn('[DB] Skipped - missing email or creditsToAdd');
    return;
  }

  try {
    const newBalance = await addCredits(email, creditsToAdd);
    console.log(`[DB] ✅ Credit addition successful. New balance: ${newBalance}`);
    return newBalance;
  } catch (err) {
    console.error('[DB] ❌ Failed to add credits:', err);
    throw err;
  }
}

export default async function handler(req, res) {
  console.log('========================================');
  console.log('[WEBHOOK] Lemon Squeezy webhook received');
  console.log('Time:', new Date().toISOString());

  if (req.method !== 'POST') {
    console.warn('[WEBHOOK] Non-POST request received');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const SIGNING_SECRET = process.env.LEMON_SQUEEZY_WEBHOOK_SECRET || 'my_super_secret_lemon_123';
  const hasDbUrl = !!(process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL);
  console.log('[WEBHOOK] Database connection string present:', hasDbUrl);

  try {
    const rawBody = await getRawBody(req);
    console.log(`[WEBHOOK] Raw body length: ${rawBody.length} bytes`);

    const signature = req.headers['x-signature'] || req.headers['X-Signature'];
    console.log(`[WEBHOOK] Received signature: ${signature ? signature.substring(0, 12) + '...' : 'MISSING'}`);

    if (!signature) {
      console.warn('[WEBHOOK] No X-Signature header found');
      return res.status(401).json({ error: 'Missing signature' });
    }

    const isValid = verifySignature(rawBody, signature, SIGNING_SECRET);
    console.log(`[WEBHOOK] Signature valid: ${isValid}`);

    if (!isValid) {
      console.warn('[WEBHOOK] Invalid webhook signature — possible secret mismatch');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const event = JSON.parse(rawBody.toString('utf8'));
    console.log('[WEBHOOK] Event received:', {
      event_name: event?.meta?.event_name,
      test_mode: event?.meta?.test_mode,
    });

    if (event?.meta?.event_name !== 'order_created') {
      console.log(`[WEBHOOK] Ignoring event: ${event?.meta?.event_name}`);
      return res.status(200).json({ received: true, ignored: event?.meta?.event_name });
    }

    const attributes = event.data?.attributes || {};
    const customerEmail =
      attributes.user_email ||
      attributes.customer?.email ||
      attributes.billing_email;

    let variantId = null;
    if (attributes.first_order_item?.variant_id) {
      variantId = String(attributes.first_order_item.variant_id);
    } else if (Array.isArray(attributes.order_items) && attributes.order_items[0]?.variant_id) {
      variantId = String(attributes.order_items[0].variant_id);
    }

    const isTestMode = !!event.meta?.test_mode;

    console.log('[WEBHOOK] Extracted data:', { customerEmail, variantId, isTestMode });

    if (!customerEmail || !variantId) {
      console.warn('[WEBHOOK] Missing email or variant_id in payload');
      return res.status(200).json({ received: true, warning: 'Missing data' });
    }

    const creditsToAdd = VARIANT_CREDITS[variantId];

    if (!creditsToAdd) {
      console.warn(`[WEBHOOK] Unknown variant_id: ${variantId}`);
      return res.status(200).json({ received: true, warning: 'Unknown variant' });
    }

    console.log(`[WEBHOOK] Will add ${creditsToAdd} credits to ${customerEmail}`);

    try {
      await addCreditsToUser(customerEmail.toLowerCase().trim(), creditsToAdd);
      console.log(`[WEBHOOK] ✅ SUCCESS: Credits added to database`);
    } catch (dbError) {
      console.error('[WEBHOOK] ❌ DATABASE ERROR while adding credits:', dbError);
      return res.status(200).json({
        received: true,
        status: 'webhook_received_but_db_failed',
        error: dbError.message
      });
    }

    // Send thank-you email if Resend is configured
    try {
      if (process.env.RESEND_API_KEY) {
        const resend = new Resend(process.env.RESEND_API_KEY);

        await resend.emails.send({
          from: 'LeadTrim <noreply@leadtrim.company>',
          to: customerEmail,
          subject: 'Thank you for your purchase – Your LeadTrim credits are ready!',
          html: `
            <div style="font-family: system-ui, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
              <h2 style="color: #111827;">Payment Successful!</h2>
              <p>Thank you for purchasing <strong>${creditsToAdd.toLocaleString()} leads</strong> with LeadTrim.</p>
              <p>Your credits have been added to your account.</p>
              <p><a href="https://leadtrim.company">Go to Dashboard</a></p>
            </div>
          `
        });

        console.log(`[WEBHOOK] Thank-you email sent to ${customerEmail}`);
      }
    } catch (emailErr) {
      console.error('[WEBHOOK] Failed to send thank-you email:', emailErr);
    }

    console.log(`[WEBHOOK] ✅ Webhook processed successfully`);
    console.log('========================================');

    return res.status(200).json({
      received: true,
      variant_id: variantId,
      credits_added: creditsToAdd,
      email: customerEmail,
      test_mode: isTestMode,
    });

  } catch (error) {
    console.error('[WEBHOOK] ❌ CRITICAL ERROR:', error);
    console.log('========================================');
    return res.status(200).json({ received: true, error: 'Internal processing error' });
  }
}
