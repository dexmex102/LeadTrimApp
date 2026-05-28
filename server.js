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
import { enrichLeads } from './lib/enricher.js';

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

    console.log(`[LeadTrim] Processing ${leads.length} leads from ${req.file.originalname}...`);

    // Run real enrichment (this is the expensive part)
    const start = Date.now();
    const enrichedLeads = await enrichLeads(leads, (progress) => {
      // Optional: could stream progress with SSE in the future
      if (progress.completed % 3 === 0) {
        console.log(`  → ${progress.completed}/${progress.total} (${progress.current})`);
      }
    });
    const duration = ((Date.now() - start) / 1000).toFixed(1);

    console.log(`[LeadTrim] Finished enriching ${enrichedLeads.length} leads in ${duration}s`);

    // Return in the exact format the original frontend already knows how to render
    res.json({
      success: true,
      count: enrichedLeads.length,
      durationSeconds: parseFloat(duration),
      leads: enrichedLeads
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
║  API endpoint:        POST /api/process                    ║
╠════════════════════════════════════════════════════════════╣
║  Ready to analyze real websites from uploaded CSVs.        ║
║  Each URL will be fetched + scanned (be patient on first   ║
║  uploads — this is real network work).                     ║
╚════════════════════════════════════════════════════════════╝
  `);
});

export default app;
