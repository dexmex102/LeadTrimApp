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

    // === DATABASE UPDATE LOGIC ===
    // Replace this section with your actual database call.
    //
    // Example using @neondatabase/serverless (recommended with Neon):
    // import { neon } from '@neondatabase/serverless';
    // const sql = neon(process.env.DATABASE_URL_UNPOOLED);
    //
    // await sql`
    //   UPDATE users 
    //   SET email = ${newEmail.toLowerCase().trim()}
    //   WHERE email = ${currentEmail?.toLowerCase().trim()}
    // `;
    //
    // If you want to transfer credits from old email to new email:
    // await sql`
    //   UPDATE users 
    //   SET email = ${newEmail.toLowerCase().trim()}
    //   WHERE email = ${currentEmail?.toLowerCase().trim()}
    // `;

    console.log(`[Update Email] ${currentEmail} → ${newEmail}`);

    return res.status(200).json({
      success: true,
      message: 'Email updated successfully!',
      oldEmail: currentEmail,
      newEmail: newEmail.toLowerCase()
    });

  } catch (error) {
    console.error('Update email error:', error);
    return res.status(500).json({
      success: false,
      message: 'Something went wrong while updating the email.'
    });
  }
}
