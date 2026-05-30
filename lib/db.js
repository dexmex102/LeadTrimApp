/**
 * Database client for LeadTrim (Neon Postgres via serverless driver)
 *
 * This module provides a clean interface for all credit-related database operations.
 * It is designed to work well with Vercel serverless functions.
 *
 * Usage:
 *   import { sql, getCredits, addCredits, deductCredits, transferCredits } from './lib/db.js';
 */

import { neon } from '@neondatabase/serverless';

// Use the unpooled connection string when available (recommended for serverless)
const connectionString = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;

if (!connectionString) {
  console.warn('[db] No DATABASE_URL found in environment variables. Database operations will fail.');
}

export const sql = neon(connectionString);

/**
 * Initialize the database schema (run once).
 * You can call this manually or via a one-time script.
 */
export async function initDatabase() {
  await sql`
    CREATE TABLE IF NOT EXISTS users (
      email TEXT PRIMARY KEY,
      credits INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_users_updated_at ON users(updated_at);
  `;

  console.log('[db] Database schema initialized successfully.');
}

/**
 * Get current credit balance for a user.
 */
export async function getCredits(email) {
  if (!email) return 0;

  const normalized = email.toLowerCase().trim();

  const result = await sql`
    SELECT credits 
    FROM users 
    WHERE email = ${normalized}
    LIMIT 1
  `;

  return result.length > 0 ? Number(result[0].credits) : 0;
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
  console.log(`[db] Added ${amount} credits to ${normalized} (new balance: ${newBalance})`);
  return newBalance;
}

/**
 * Deduct credits from a user.
 * Returns { success: boolean, remaining?: number, current?: number }
 */
export async function deductCredits(email, amount) {
  if (!email || !Number.isFinite(amount) || amount <= 0) {
    return { success: false, error: 'Invalid email or amount' };
  }

  const normalized = email.toLowerCase().trim();

  // First check current balance
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
  console.log(`[db] Deducted ${amount} credits from ${normalized} (remaining: ${remaining})`);

  return { success: true, remaining };
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

  // Get current balance of old email
  const oldCreditsResult = await sql`
    SELECT credits FROM users WHERE email = ${normalizedOld} LIMIT 1
  `;

  if (oldCreditsResult.length === 0) {
    throw new Error('Old email not found');
  }

  const creditsToTransfer = Number(oldCreditsResult[0].credits);

  // Upsert into new email (add to existing if any)
  await sql`
    INSERT INTO users (email, credits, updated_at)
    VALUES (${normalizedNew}, ${creditsToTransfer}, NOW())
    ON CONFLICT (email)
    DO UPDATE SET 
      credits = users.credits + ${creditsToTransfer},
      updated_at = NOW()
  `;

  // Delete the old email record
  await sql`
    DELETE FROM users WHERE email = ${normalizedOld}
  `;

  console.log(`[db] Transferred ${creditsToTransfer} credits from ${normalizedOld} to ${normalizedNew}`);

  return {
    success: true,
    transferred: creditsToTransfer,
    oldEmail: normalizedOld,
    newEmail: normalizedNew
  };
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
