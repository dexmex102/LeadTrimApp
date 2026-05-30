/**
 * LeadTrim Credits System (simple email-based, file-backed)
 *
 * Used by the webhook (add credits on purchase) and the /api/process endpoint (check + deduct).
 * Backed by a JSON file so balances survive server restarts.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Resolve data directory (repo root /data)
const DATA_DIR = path.join(__dirname, '..', 'data');
const CREDITS_FILE = path.join(DATA_DIR, 'user-credits.json');

// In-memory cache
let creditsCache = null;
let lastLoadTime = 0;
const CACHE_TTL_MS = 5000; // reload from disk at most every 5s

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function normalizeEmail(email) {
  if (!email || typeof email !== 'string') return null;
  return email.toLowerCase().trim();
}

function loadCredits() {
  const now = Date.now();
  if (creditsCache && (now - lastLoadTime) < CACHE_TTL_MS) {
    return creditsCache;
  }

  ensureDataDir();

  if (!fs.existsSync(CREDITS_FILE)) {
    creditsCache = {};
    lastLoadTime = now;
    return creditsCache;
  }

  try {
    const raw = fs.readFileSync(CREDITS_FILE, 'utf8');
    creditsCache = JSON.parse(raw || '{}');
    if (typeof creditsCache !== 'object' || creditsCache === null) {
      creditsCache = {};
    }
    lastLoadTime = now;
    return creditsCache;
  } catch (err) {
    console.error('[credits] Failed to load credits file, starting fresh:', err.message);
    creditsCache = {};
    lastLoadTime = now;
    return creditsCache;
  }
}

function saveCredits(credits) {
  ensureDataDir();
  try {
    fs.writeFileSync(CREDITS_FILE, JSON.stringify(credits, null, 2), 'utf8');
    creditsCache = { ...credits };
    lastLoadTime = Date.now();
  } catch (err) {
    console.error('[credits] Failed to save credits file:', err.message);
    throw err;
  }
}

/**
 * Get current credit balance for an email (0 if unknown).
 */
export function getCredits(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return 0;

  const all = loadCredits();
  return Number(all[normalized] || 0);
}

/**
 * Add credits to a user's balance (called by the Lemon Squeezy webhook).
 * Returns the new balance.
 */
export function addCredits(email, amount) {
  const normalized = normalizeEmail(email);
  if (!normalized || !Number.isFinite(amount) || amount <= 0) {
    throw new Error('Invalid email or credit amount');
  }

  const all = loadCredits();
  const current = Number(all[normalized] || 0);
  const next = current + Math.floor(amount);

  all[normalized] = next;
  saveCredits(all);

  console.log(`[credits] Added ${amount} credits to ${normalized} (now ${next})`);
  return next;
}

/**
 * Attempt to deduct credits.
 * Returns { success: true, remaining } or { success: false, error, current }
 */
export function deductCredits(email, amount) {
  const normalized = normalizeEmail(email);
  if (!normalized || !Number.isFinite(amount) || amount <= 0) {
    return { success: false, error: 'Invalid email or amount' };
  }

  const all = loadCredits();
  const current = Number(all[normalized] || 0);

  if (current < amount) {
    return {
      success: false,
      error: 'Insufficient credits',
      current
    };
  }

  const remaining = current - Math.floor(amount);
  all[normalized] = remaining;
  saveCredits(all);

  console.log(`[credits] Deducted ${amount} credits from ${normalized} (now ${remaining})`);
  return { success: true, remaining };
}

/**
 * For admin/debug: set an exact balance.
 */
export function setCredits(email, amount) {
  const normalized = normalizeEmail(email);
  if (!normalized || !Number.isFinite(amount) || amount < 0) {
    throw new Error('Invalid email or amount');
  }

  const all = loadCredits();
  all[normalized] = Math.floor(amount);
  saveCredits(all);
  return all[normalized];
}

/**
 * List all known users (for debugging only).
 */
export function listAllCredits() {
  return loadCredits();
}

/**
 * Update a user's email (transfer credits from old to new email).
 * Used by the /api/update-email endpoint.
 */
export function updateUserEmail(oldEmail, newEmail) {
  const normalizedOld = normalizeEmail(oldEmail);
  const normalizedNew = normalizeEmail(newEmail);

  if (!normalizedOld || !normalizedNew) {
    throw new Error('Both oldEmail and newEmail are required');
  }

  if (normalizedOld === normalizedNew) {
    return { success: true, message: 'Email is already up to date', balance: getCredits(normalizedNew) };
  }

  const all = loadCredits();
  const oldBalance = Number(all[normalizedOld] || 0);

  if (oldBalance === 0 && !(normalizedOld in all)) {
    throw new Error('Old email not found in the system');
  }

  // Handle case where new email already exists
  const newBalanceExisting = Number(all[normalizedNew] || 0);
  const finalNewBalance = oldBalance + newBalanceExisting;

  // Transfer credits
  all[normalizedNew] = finalNewBalance;

  // Remove old email
  delete all[normalizedOld];

  saveCredits(all);

  console.log(`[credits] Transferred ${oldBalance} credits from ${normalizedOld} to ${normalizedNew} (new total: ${finalNewBalance})`);

  return {
    success: true,
    oldEmail: normalizedOld,
    newEmail: normalizedNew,
    transferred: oldBalance,
    newBalance: finalNewBalance,
    merged: newBalanceExisting > 0
  };
}

export { normalizeEmail };