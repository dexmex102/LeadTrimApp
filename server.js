/**
 * LeadTrim AI — Backend Server
 *
 * Responsibilities:
 * - Serves the beautiful frontend (index.html)
 * - Accepts CSV uploads via POST /api/process
 * - Runs real enrichment (live URL checks + keyword analysis)
 * - Returns enriched leads ready for the dashboard
 */

import express from 'express';
import multer from 'multer';
import { parse } from 'csv-parse/sync';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { enrichLeads } from './lib/enricher.js';
import { getCredits, addCredits, deductCredits, normalizeEmail } from './lib/credits.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// ===== MULTER CONFIG (CSV upload in memory) =====
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 2 * 1024 * 1024, // 2MB max
    files: 1
  },
  fileFilter: (req, file, cb) => {
    const isCsv = file.mimetype === 'text/csv' ||
                  file.originalname.toLowerCase().endsWith('.csv');
    if (isCsv) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files are allowed'));
    }
  }
});

// ===== MIDDLEWARE =====
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve static frontend (index.html + future assets)
app.use(express.static(__dirname, {
  index: 'index.html',
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

// ===== ROUTES =====

/**
 * Health check
 */
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'LeadTrim AI', timestamp: new Date().toISOString() });
});

/**
 * GET current credits for a user (email-based identity)
 * Used by the frontend to display the balance.
 */
app.get('/api/credits', (req, res) => {
  const email = req.query.email || req.headers['x-user-email'];
  const normalized = normalizeEmail(email);

  if (!normalized) {
    return res.status(400).json({ error: 'Email is required (query param or X-User-Email header)' });
  }

  const credits = getCredits(normalized);
  res.json({ email: normalized, credits });
});

/**
 * Lemon Squeezy Webhook
 * IMPORTANT: This route MUST receive the raw body for signature verification.
 * It is registered with express.raw() BEFORE the general express.json() middleware.
 */
app.post('/api/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const signature = req.headers['x-signature'] || req.headers['X-Signature'];
  const secret = process.env.LEMON_SQUEEZY_WEBHOOK_SECRET;

  if (!secret) {
    console.error('[webhook] LEMON_SQUEEZY_WEBHOOK_SECRET is not set. Rejecting webhook.');
    return res.status(500).json({ error: 'Webhook secret not configured' });
  }

  if (!signature) {
    console.warn('[webhook] Missing X-Signature header');
    return res.status(401).json({ error: 'Missing signature' });
  }

  // Verify HMAC signature (raw body as received)
  try {
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(req.body); // req.body is a Buffer thanks to express.raw()
    const digest = hmac.digest('hex');

    if (digest !== signature) {
      console.warn('[webhook] Invalid signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }
  } catch (err) {
    console.error('[webhook] Signature verification error:', err.message);
    return res.status(400).json({ error: 'Bad signature' });
  }

  // Parse the JSON body now that it's verified
  let event;
  try {
    event = JSON.parse(req.body.toString('utf8'));
  } catch (err) {
    console.error('[webhook] Failed to parse JSON body');
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  // We only care about successful orders
  if (event?.meta?.event_name !== 'order_created') {
    // Acknowledge other events (e.g. order_refunded) but do nothing
    return res.status(200).json({ received: true, ignored: event?.meta?.event_name || 'unknown' });
  }

  const isTest = !!event?.meta?.test_mode;
  const attrs = event?.data?.attributes || {};
  const email = attrs.user_email || attrs.customer?.email || '';

  // Try multiple locations for the variant ID (Lemon Squeezy payload can vary slightly)
  let variantId = null;
  if (attrs.first_order_item?.variant_id) {
    variantId = attrs.first_order_item.variant_id;
  } else if (Array.isArray(attrs.order_items) && attrs.order_items[0]?.variant_id) {
    variantId = attrs.order_items[0].variant_id;
  } else if (attrs.order_items?.data?.[0]?.attributes?.variant_id) {
    variantId = attrs.order_items.data[0].attributes.variant_id;
  }

  const normalizedEmail = normalizeEmail(email);

  if (!normalizedEmail) {
    console.warn('[webhook] order_created event received but no customer email found');
    return res.status(200).json({ received: true, warning: 'No email' });
  }

  // ============================================================
  // Lemon Squeezy Variant → Credit Mapping (NEW B2B Pricing)
  // ============================================================
  // STEP 1: In Lemon Squeezy, create 3 new one-time products with these exact offers:
  //   - Pilot   → $29  one-time → 2,500 leads
  //   - Agency  → $99  one-time → 10,000 leads   (mark as "Most Popular")
  //   - Scale   → $249 one-time → 50,000 leads
  //
  // STEP 2: After creating the products, copy the numeric Variant IDs
  //         and replace the keys below.
  //
  // The credit amounts on the right MUST match what you sell.
  // ============================================================
  const VARIANT_CREDITS = {
    // >>>>> REPLACE THE KEYS BELOW WITH YOUR REAL LEMON SQUEEZY VARIANT IDs <<<<<
    'pilot_2500': 2500,     // Pilot Tier   - $29  →  2,500 leads
    'agency_10000': 10000,  // Agency Tier  - $99  → 10,000 leads (Most Popular)
    'scale_50000': 50000    // Scale Tier   - $249 → 50,000 leads
  };

  const creditsToAdd = VARIANT_CREDITS[String(variantId)] || 0;

  if (creditsToAdd > 0) {
    try {
      const newBalance = addCredits(normalizedEmail, creditsToAdd);
      console.log(`[webhook] ${isTest ? '[TEST] ' : ''}Credited ${creditsToAdd} leads to ${normalizedEmail} (balance: ${newBalance})`);
    } catch (err) {
      console.error('[webhook] Failed to add credits:', err.message);
      // Still return 200 so Lemon Squeezy doesn't keep retrying
    }
  } else {
    console.warn(`[webhook] Unknown variant_id ${variantId} — no credits granted`);
  }

  return res.status(200).json({ received: true });
});

/**
 * Main enrichment endpoint
 * Accepts a CSV file, parses it, enriches every row with real web data,
 * and returns the processed leads in the exact shape the frontend expects.
 */
app.post('/api/process', upload.single('csv'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No CSV file uploaded. Use field name "csv".' });
    }

    const csvText = req.file.buffer.toString('utf8');

    // Parse CSV into array of objects (very tolerant)
    let records;
    try {
      records = parse(csvText, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        relax_column_count: true,
        relax_quotes: true
      });
    } catch (parseErr) {
      console.error('CSV parse error:', parseErr);
      return res.status(400).json({ error: 'Failed to parse CSV. Check for malformed quotes or structure.' });
    }

    if (!records || records.length === 0) {
      return res.status(400).json({ error: 'CSV contained no data rows.' });
    }

    // ===== CREDIT CHECK (email-based identity) =====
    const userEmail = req.headers['x-user-email'] || req.body?.email || null;
    const normalizedEmail = normalizeEmail(userEmail);

    const leadCount = records.length;

    if (normalizedEmail) {
      const currentCredits = getCredits(normalizedEmail);

      if (currentCredits < leadCount) {
        console.log(`[LeadTrim] Blocked upload for ${normalizedEmail}: needs ${leadCount}, has ${currentCredits}`);
        return res.status(402).json({
          error: 'Insufficient credits',
          message: `You need ${leadCount} credits to process this file but only have ${currentCredits}.`,
          needed: leadCount,
          current: currentCredits
        });
      }
    } else {
      // No email provided — block real processing (samples still work in the UI)
      return res.status(401).json({
        error: 'Authentication required',
        message: 'Please sign in with your purchase email before uploading real CSVs. Sample data is always free.'
      });
    }

    // Normalize incoming records into the shape our enricher understands
    const leads = records.map((row, index) => {
      // Try many possible column names users might have
      const company = row.company || row['company name'] || row.name || row.organization ||
                      row['company_name'] || row.Company || `Lead ${index + 1}`;

      const url = row.website || row.url || row.domain || row.web || row.link ||
                  row.site || row.URL || row.Website || '';

      return {
        company: String(company).trim(),
        url: String(url).trim(),
        // Preserve any extra columns the user might have sent (we ignore them for now)
        _raw: row
      };
    });

    console.log(`[LeadTrim] Processing ${leads.length} leads from ${req.file.originalname} for ${normalizedEmail}...`);

    // Run real enrichment (this is the expensive part)
    const start = Date.now();
    const enrichedLeads = await enrichLeads(leads, (progress) => {
      // Optional: could stream progress with SSE in the future
      if (progress.completed % 3 === 0) {
        console.log(`  → ${progress.completed}/${progress.total} (${progress.current})`);
      }
    });
    const duration = ((Date.now() - start) / 1000).toFixed(1);

    // Deduct credits AFTER successful processing (source of truth is server)
    let creditsRemaining = null;
    try {
      const deductResult = deductCredits(normalizedEmail, leadCount);
      if (deductResult.success) {
        creditsRemaining = deductResult.remaining;
      } else {
        console.warn(`[LeadTrim] Deduction failed for ${normalizedEmail} after processing`);
      }
    } catch (deductErr) {
      console.error('[LeadTrim] Error during credit deduction:', deductErr.message);
    }

    console.log(`[LeadTrim] Finished enriching ${enrichedLeads.length} leads in ${duration}s`);

    // Return in the exact format the original frontend already knows how to render
    res.json({
      success: true,
      count: enrichedLeads.length,
      durationSeconds: parseFloat(duration),
      leads: enrichedLeads,
      creditsRemaining
    });

  } catch (err) {
    console.error('Processing error:', err);

    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'File too large. Maximum 2MB allowed.' });
    }

    res.status(500).json({
      error: 'Server error while processing leads',
      message: err.message
    });
  }
});

// Catch-all: serve the frontend for any unknown route (SPA-like behavior)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ===== START SERVER =====
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║  LeadTrim AI — Live Enrichment Server                      ║
╠════════════════════════════════════════════════════════════╣
║  Server running at:   http://localhost:${PORT}               ║
║  Frontend:            http://localhost:${PORT}               ║
║  API endpoints:       POST /api/process                    ║
║                       POST /api/webhook  (Lemon Squeezy)   ║
║                       GET  /api/credits                    ║
╠════════════════════════════════════════════════════════════╣
║  Lemon Squeezy credits system is active.                   ║
║  Configure LEMON_SQUEEZY_WEBHOOK_SECRET in .env            ║
╚════════════════════════════════════════════════════════════╝
  `);
});

export default app;
