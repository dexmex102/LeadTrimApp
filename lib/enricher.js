/**
 * LeadTrim AI — Backend Enrichment Engine
 * 
 * Takes leads with URLs and performs real lightweight website analysis:
 * - Checks if the site responds (live / broken)
 * - Scans homepage HTML for hiring signals and tech stack keywords
 * - Assigns realistic AI Fit Score (A-F) and status
 */

import * as cheerio from 'cheerio';

// ===== CONFIG =====
const FETCH_TIMEOUT_MS = 6500;           // Max time per URL
const MAX_REDIRECTS = 3;
const MAX_CONCURRENCY = 4;               // Be polite to target sites
const USER_AGENT = 'LeadTrimAI/1.0 (lead enrichment bot; +https://leadtrim.ai)';

// ===== KEYWORD SIGNALS =====
const HIRING_SIGNALS = [
  'hiring', 'we\'re hiring', 'now hiring', 'we are hiring',
  'careers', 'join our team', 'open roles', 'open positions',
  'we\'re looking for', 'apply now', 'job openings', 'work with us',
  'come work', 'talent', 'join us'
];

const TECH_SIGNALS = {
  // Frontend
  'React': /react(\.js)?/i,
  'Vue': /vue(\.js)?|vuejs/i,
  'Angular': /angular/i,
  'Next.js': /next\.js|nextjs/i,
  'Nuxt': /nuxt/i,
  'Svelte': /svelte/i,
  'Tailwind': /tailwind/i,

  // Backend / Languages
  'Python': /python|django|flask|fastapi/i,
  'Node.js': /node\.js|nodejs|express/i,
  'TypeScript': /typescript|tsconfig/i,
  'PHP': /php|laravel|wordpress/i,
  'Ruby': /ruby on rails|rails/i,

  // Cloud / Infra
  'AWS': /aws|amazon web services/i,
  'GCP': /google cloud|gcp/i,
  'Azure': /azure/i,
  'Kubernetes': /kubernetes|k8s/i,
  'Docker': /docker/i,

  // Platforms
  'Shopify': /shopify/i,
  'WordPress': /wordpress|wp-content/i,
  'Stripe': /stripe/i,
  'Webflow': /webflow/i
};

// ===== HELPERS =====
function normalizeUrl(url) {
  if (!url) return null;
  let u = url.trim();
  if (!/^https?:\/\//i.test(u)) {
    u = 'https://' + u.replace(/^\/+/, '');
  }
  try {
    const parsed = new URL(u);
    // Only allow http/https
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Simple concurrency limiter
 */
function createLimiter(concurrency) {
  const queue = [];
  let active = 0;

  async function run(fn) {
    if (active >= concurrency) {
      await new Promise(resolve => queue.push(resolve));
    }
    active++;
    try {
      return await fn();
    } finally {
      active--;
      if (queue.length) queue.shift()();
    }
  }
  return run;
}

const limit = createLimiter(MAX_CONCURRENCY);

// ===== CORE ENRICHMENT =====
async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      redirect: 'follow'
    });
    clearTimeout(timeout);
    return res;
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

async function analyzeUrl(rawUrl) {
  const url = normalizeUrl(rawUrl);
  if (!url) {
    return { status: 'Broken', tech: [], hiring: false, score: 'F', notes: 'Invalid URL' };
  }

  try {
    const response = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);

    if (!response.ok) {
      return {
        status: 'Broken',
        tech: [],
        hiring: false,
        score: response.status >= 500 ? 'F' : 'D',
        notes: `HTTP ${response.status}`
      };
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    // Remove noise
    $('script, style, noscript, svg, nav, footer, header').remove();
    const text = $('body').text().toLowerCase().replace(/\s+/g, ' ').trim();

    if (text.length < 80) {
      return {
        status: 'Needs Review',
        tech: [],
        hiring: false,
        score: 'D',
        notes: 'Very thin content'
      };
    }

    // Detect hiring
    const hiring = HIRING_SIGNALS.some(signal => text.includes(signal));

    // Detect tech stack
    const tech = [];
    for (const [name, regex] of Object.entries(TECH_SIGNALS)) {
      if (regex.test(html) || regex.test(text)) {
        tech.push(name);
      }
    }

    // Simple heuristic scoring
    let score = 'C';
    const signalCount = tech.length + (hiring ? 1 : 0);

    if (signalCount >= 4) score = 'A';
    else if (signalCount === 3) score = 'B';
    else if (signalCount === 2) score = 'B';
    else if (signalCount === 1) score = 'C';
    else score = 'D';

    // Bonus for very professional signals
    if (tech.includes('React') || tech.includes('Next.js') || tech.includes('Python')) {
      if (score === 'C' && (hiring || tech.length >= 2)) score = 'B';
    }

    return {
      status: 'Active',
      tech: tech.slice(0, 5),           // cap for UI cleanliness
      hiring,
      score,
      notes: null
    };

  } catch (err) {
    const isTimeout = err.name === 'AbortError' || err.type === 'aborted';
    return {
      status: 'Broken',
      tech: [],
      hiring: false,
      score: 'F',
      notes: isTimeout ? 'Timeout' : 'Unreachable'
    };
  }
}

/**
 * Enrich a single lead object.
 * Input shape:  { company, url, ...other fields ignored for enrichment }
 * Output: full lead object with score, status, tech, hiring, keywords updated
 */
export async function enrichLead(lead) {
  const url = lead.url || lead.website || lead.domain || '';
  const company = lead.company || lead.name || 'Unknown Company';

  if (!url) {
    return {
      company,
      url: '',
      score: 'D',
      status: 'Needs Review',
      tech: [],
      hiring: false,
      keywords: lead.keywords || []
    };
  }

  const analysis = await limit(() => analyzeUrl(url));

  // Build keywords intelligently
  const baseKeywords = Array.isArray(lead.keywords) ? [...lead.keywords] : [];
  const newKeywords = new Set(baseKeywords);

  if (analysis.hiring) newKeywords.add('Hiring');
  if (analysis.tech.length > 0) {
    // Add one or two strong tech keywords if not already present
    analysis.tech.slice(0, 2).forEach(t => newKeywords.add(t));
  }

  return {
    company,
    url: url,
    score: analysis.score,
    status: analysis.status,
    tech: analysis.tech,
    hiring: analysis.hiring,
    keywords: Array.from(newKeywords)
  };
}

/**
 * Main entry point. Enriches an array of leads with controlled concurrency.
 */
export async function enrichLeads(leads = [], onProgress = null) {
  const results = [];
  let completed = 0;

  for (const lead of leads) {
    const enriched = await enrichLead(lead);
    results.push(enriched);
    completed++;

    if (onProgress) {
      onProgress({ completed, total: leads.length, current: enriched.company });
    }

    // Small politeness delay between batches (not between every single one because of limiter)
    if (completed % MAX_CONCURRENCY === 0) {
      await sleep(180);
    }
  }

  return results;
}

export { normalizeUrl, HIRING_SIGNALS, TECH_SIGNALS };
