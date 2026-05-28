# LeadTrim AI — Live Edition

A beautiful, self-contained sales lead scrubbing tool that now performs **real website analysis** on your uploaded CSVs.

## Features

- **Instant demo** — "Load Sample Scraped List" still works with zero setup (pure client-side)
- **Live enrichment** — Upload a real CSV and the backend will:
  - Fetch each website (with timeout protection)
  - Detect if the domain is live or broken
  - Scan the homepage for hiring signals ("we're hiring", "careers", "join our team"...)
  - Detect real tech stack signals (React, Python, Next.js, Shopify, AWS, etc.)
  - Intelligently assign A–F fit scores
- Stunning dark dashboard with all original filters, search, and export still working perfectly

## Quick Start

### 1. Install Node.js
Make sure you have **Node.js 18 or newer** installed:
```bash
node --version
```

### 2. Install dependencies
```bash
npm install
```

### 3. Run the server
```bash
npm start
```

Then open **http://localhost:3000** in your browser.

## How It Works

1. The beautiful frontend (`index.html`) is served by Express.
2. When you drop or select a CSV:
   - The file is sent to `POST /api/process`
   - The backend parses it using `csv-parse`
   - For every row with a URL, `lib/enricher.js` performs a real HTTP fetch + cheerio text analysis
   - Results are returned in the exact format the dashboard already expects
3. The three scrub criteria toggles + search continue to work as **post-filters** on the enriched data.

## Important Notes

- **Real network calls**: Each URL in your CSV is fetched from the server. This is intentional but means:
  - First uploads take 8–30+ seconds depending on how many rows and how fast the sites respond.
  - Corporate firewalls or very slow sites may mark rows as "Broken".
- **Be polite**: The server limits concurrency to 4 simultaneous requests and has per-URL timeouts.
- **No data is stored**: Everything is processed in memory and discarded after the response.

## Project Structure

```
LeadTrimApp/
├── index.html          # The complete stunning frontend
├── server.js           # Express server + API
├── package.json
├── lib/
│   └── enricher.js     # The magic: URL fetching + keyword + tech detection
├── README.md
└── .gitignore
```

## Development

```bash
npm run dev          # Uses Node --watch for auto-reload
```

## Future Ideas (not implemented yet)

- Streaming progress via Server-Sent Events
- Caching enrichment results for repeated domains
- Configurable timeout / concurrency in UI
- Export original + enriched columns

---

Built as an evolution of the original pure client-side LeadTrim AI prototype.
Enjoy turning scraped lists into scored, actionable leads.
