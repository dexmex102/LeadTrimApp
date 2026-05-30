/**
 * Vercel Serverless Function
 * Endpoint: GET /api/credits?email=xxx
 *
 * Returns the current credit balance for a given email.
 * Used by the frontend to display the user's balance.
 */

import { getCredits, normalizeEmail } from '../lib/db.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const email = req.query.email || req.headers['x-user-email'];

    if (!email) {
      return res.status(400).json({
        error: 'Email is required (use ?email=... or X-User-Email header)'
      });
    }

    const normalized = normalizeEmail(email);
    const credits = await getCredits(normalized);

    return res.status(200).json({
      email: normalized,
      credits: credits
    });

  } catch (error) {
    console.error('[api/credits] Error fetching credits:', error);
    return res.status(500).json({
      error: 'Failed to fetch credits from database',
      details: error.message || 'Unknown database error'
    });
  }
}
