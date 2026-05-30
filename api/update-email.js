/**
 * Vercel Serverless Function
 * Endpoint: POST /api/update-email
 *
 * This is an example implementation.
 * In production, you should:
 *   - Validate the new email
 *   - Verify the user owns the currentEmail (via session / magic link / etc.)
 *   - Update the email in your database
 *   - Optionally transfer credits from old email to new email
 */

import { transferCredits } from '../lib/db.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method Not Allowed' });
  }

  try {
    const { newEmail, currentEmail } = req.body;

    if (!newEmail || typeof newEmail !== 'string' || !newEmail.includes('@')) {
      return res.status(400).json({
        success: false,
        message: 'Please provide a valid email address.'
      });
    }

    // Transfer credits from old email to new email in the database
    const result = await transferCredits(currentEmail, newEmail);

    console.log(`[Update Email] ${currentEmail} → ${newEmail}`);

    return res.status(200).json({
      success: true,
      message: 'Email updated successfully!',
      ...result
    });

  } catch (error) {
    console.error('Update email error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Something went wrong while updating the email.'
    });
  }
}
