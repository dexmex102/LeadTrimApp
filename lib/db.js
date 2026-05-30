/**
 * Database client for LeadTrim (Neon Postgres via serverless driver)
 *
 * This module provides a clean interface for all credit-related database operations.
 * It is designed to work well with Vercel serverless functions.
 */

import { neon } from '@neondatabase/serverless';

let sqlClient = null;

function normalizeEmail(email) {
  if (!email || typeof email !== 'string') return null;
  return email.toLowerCase().trim();
}

function getSql() {
  if (sqlClient) return sqlClient;

  const connectionString = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;

  if (!connectionString) {
    console.error('[DB] ❌ FATAL: No database connection string found in environment variables.');
    console.error('Expected one of: DATABASE_URL_UNPOOLED or DATABASE_URL');
    throw new Error('Database is not configured (missing connection string)');
  }

  sqlClient = neon(connectionString);
  return sqlClient;
}

// Lazy sql client
export const sql = (...args) => getSql()(...args);

/**
 * Get current credit balance for a user.
 */
export async function getCredits(email) {
  if (!email) return 0;

  const normalized = email.toLowerCase().trim();

  try {
    const result = await sql`
      SELECT credits 
      FROM users 
      WHERE email = ${normalized}
      LIMIT 1
    `;

    return result.length > 0 ? Number(result[0].credits) : 0;

  } catch (error) {
    console.error(`[DB] Error in getCredits for ${normalized}:`, error.message);
    return 0;
  }
}

/**
 * Add credits to a user's balance (used by the Lemon Squeezy webhook).
 * Uses upsert to create the user if they don't exist.
 */
export async function addCredits(email, amount) {
  if (!email || !Number.isFinite(amount) || amount <= 0) {
    throw new Error('Invalid email or credit amount');
  }

  const normalized = email.toLowerCase().trim();

  console.log(`[DB] Executing credit insert/update for ${normalized} (+${amount})`);

  try {
    const result = await sql`
      INSERT INTO users (email, credits, updated_at)
      VALUES (${normalized}, ${Math.floor(amount)}, NOW())
      ON CONFLICT (email)
      DO UPDATE SET 
        credits = users.credits + ${Math.floor(amount)},
        updated_at = NOW()
      RETURNING credits
    `;

    const newBalance = Number(result[0].credits);
    console.log(`[DB] ✅ Database write successful. New balance for ${normalized}: ${newBalance}`);
    return newBalance;

  } catch (error) {
    console.error(`[DB] ❌ Error in addCredits for ${normalized}:`, error.message);
    throw error;
  }
}

/**
 * Deduct credits from a user.
 */
export async function deductCredits(email, amount) {
  if (!email || !Number.isFinite(amount) || amount <= 0) {
    return { success: false, error: 'Invalid email or amount' };
  }

  const normalized = email.toLowerCase().trim();

  try {
    const currentResult = await sql`
      SELECT credits FROM users WHERE email = ${normalized} LIMIT 1
    `;

    const current = currentResult.length > 0 ? Number(currentResult[0].credits) : 0;

    if (current < amount) {
      return {
        success: false,
        error: 'Insufficient credits',
        current
      };
    }

    const result = await sql`
      UPDATE users 
      SET credits = credits - ${Math.floor(amount)}, updated_at = NOW()
      WHERE email = ${normalized}
      RETURNING credits
    `;

    const remaining = Number(result[0].credits);
    console.log(`[DB] Deducted ${amount} credits from ${normalized} (remaining: ${remaining})`);

    return { success: true, remaining };

  } catch (error) {
    console.error(`[DB] Error in deductCredits for ${normalized}:`, error.message);
    return { success: false, error: 'Database error' };
  }
}

/**
 * Transfer credits from one email to another (used when user changes email).
 */
export async function transferCredits(oldEmail, newEmail) {
  const normalizedOld = oldEmail?.toLowerCase().trim();
  const normalizedNew = newEmail?.toLowerCase().trim();

  if (!normalizedOld || !normalizedNew) {
    throw new Error('Both old and new email are required');
  }

  if (normalizedOld === normalizedNew) {
    return { success: true, message: 'Emails are the same' };
  }

  try {
    const oldCreditsResult = await sql`
      SELECT credits FROM users WHERE email = ${normalizedOld} LIMIT 1
    `;

    if (oldCreditsResult.length === 0) {
      throw new Error('Old email not found');
    }

    const creditsToTransfer = Number(oldCreditsResult[0].credits);

    await sql`
      INSERT INTO users (email, credits, updated_at)
      VALUES (${normalizedNew}, ${creditsToTransfer}, NOW())
      ON CONFLICT (email)
      DO UPDATE SET 
        credits = users.credits + ${creditsToTransfer},
        updated_at = NOW()
    `;

    await sql`
      DELETE FROM users WHERE email = ${normalizedOld}
    `;

    console.log(`[DB] Transferred ${creditsToTransfer} credits from ${normalizedOld} to ${normalizedNew}`);

    return {
      success: true,
      transferred: creditsToTransfer,
      oldEmail: normalizedOld,
      newEmail: normalizedNew
    };

  } catch (error) {
    console.error(`[DB] Error transferring credits from ${normalizedOld} to ${normalizedNew}:`, error.message);
    throw error;
  }
}

/**
 * Set exact credit balance (useful for admin/debug).
 */
export async function setCredits(email, amount) {
  if (!email || !Number.isFinite(amount) || amount < 0) {
    throw new Error('Invalid email or amount');
  }

  const normalized = email.toLowerCase().trim();

  const result = await sql`
    INSERT INTO users (email, credits, updated_at)
    VALUES (${normalized}, ${Math.floor(amount)}, NOW())
    ON CONFLICT (email)
    DO UPDATE SET 
      credits = ${Math.floor(amount)},
      updated_at = NOW()
    RETURNING credits
  `;

  return Number(result[0].credits);
}

export { normalizeEmail };
