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
 * Add credits to a user after successful Lemon Squeezy payment.
 */
async function addCreditsToUser(email, creditsToAdd) {
  if (!email || !creditsToAdd) return;

  try {
    const newBalance = await addCredits(email, creditsToAdd);
    console.log(`[LemonSqueezy] Added ${creditsToAdd} credits to ${email} (new balance: ${newBalance})`);
  } catch (err) {
    console.error('[LemonSqueezy] Failed to add credits to DB:', err);
    throw err;
  }
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

    // 9. Send thank-you email (optional but recommended)
    try {
      if (process.env.RESEND_API_KEY) {
        const resend = new Resend(process.env.RESEND_API_KEY);

        await resend.emails.send({
          from: 'LeadTrim <noreply@leadtrim.company>', // Change this after verifying your domain in Resend
          to: customerEmail,
          subject: 'Thank you for your purchase – Your LeadTrim credits are ready!',
          html: `
            <div style="font-family: system-ui, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
              <h2 style="color: #111827;">Payment Successful!</h2>
              <p>Hi there,</p>
              <p>Thank you for purchasing <strong>${creditsToAdd.toLocaleString()} leads</strong> with LeadTrim.</p>
              <p>Your credits have been added to your account and are ready to use.</p>
              <p style="margin-top: 24px;">
                <a href="https://leadtrim.company" 
                   style="background-color: #10b981; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; display: inline-block;">
                  Go to Dashboard
                </a>
              </p>
              <p style="margin-top: 32px; color: #6b7280; font-size: 14px;">
                If you have any questions, just reply to this email.
              </p>
            </div>
          `
        });

        console.log(`[LemonSqueezy] Thank-you email sent to ${customerEmail}`);
      }
    } catch (emailErr) {
      console.error('[LemonSqueezy] Failed to send thank-you email:', emailErr);
      // Don't fail the whole webhook if email fails
    }

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
