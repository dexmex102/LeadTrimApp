/**
 * Vercel Serverless Function
 * Endpoint: POST /api/update-email
 *
 * Allows a user to change their email. Transfers credits from the old email
 * to the new one in the database.
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
