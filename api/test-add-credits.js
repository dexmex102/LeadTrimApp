/**
 * Test Endpoint: Manually add credits to a user
 * 
 * Use this to verify that the database credit logic works,
 * independent of the Lemon Squeezy webhook.
 * 
 * Usage (via browser or curl):
 *   GET /api/test-add-credits?email=test@example.com&credits=2500&secret=your-secret
 * 
 * WARNING: This endpoint should be removed or heavily protected before going live.
 */

import { addCredits, getCredits } from '../lib/db.js';

export default async function handler(req, res) {
  // Basic protection
  const secret = req.query.secret || req.headers['x-test-secret'];
  const expectedSecret = process.env.TEST_ENDPOINT_SECRET || 'dev-only';

  if (secret !== expectedSecret) {
    console.warn('[Test] Unauthorized attempt to use test-add-credits endpoint');
    return res.status(403).json({ 
      success: false, 
      error: 'Unauthorized' 
    });
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    const email = req.query.email || req.body?.email;
    const credits = parseInt(req.query.credits || req.body?.credits, 10);

    if (!email || !credits || credits <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Missing or invalid parameters. Required: email and credits (> 0)'
      });
    }

    const normalizedEmail = email.toLowerCase().trim();

    console.log(`[Test] Manually adding ${credits} credits to ${normalizedEmail}`);

    const previousBalance = await getCredits(normalizedEmail);
    const newBalance = await addCredits(normalizedEmail, credits);

    console.log(`[Test] Success: ${normalizedEmail} balance changed from ${previousBalance} to ${newBalance}`);

    return res.status(200).json({
      success: true,
      email: normalizedEmail,
      previous_balance: previousBalance,
      credits_added: credits,
      new_balance: newBalance,
      message: `Successfully added ${credits} credits to ${normalizedEmail}`
    });

  } catch (error) {
    console.error('[Test] Error adding credits:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
}
