# Global Intraday Stock Recommender

A browser-based research dashboard that pulls live market data and ranks global stocks as **Buy / Watch / Avoid** across 20, 60, 120, and 250 trading-day horizons using an interpretable factor model.

> ⚠ **Disclaimer:** This is a research tool only. All model outputs are probabilistic estimates. This is NOT financial advice. Always do your own research before making investment decisions.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Browser (React + Tailwind + shadcn/ui + Recharts)       │
│  Pages: Dashboard, Stock Detail, Backtest, Universe      │
└────────────────────────┬────────────────────────────────┘
                         │ HTTP / REST (apiRequest)
┌────────────────────────▼────────────────────────────────┐
│  Express Backend (Node.js / TypeScript)                  │
│  Routes: /api/recommendations, /api/stock/:ticker, …     │
│  Scheduler: node-cron (auto-refresh every 5/15/30/60m)   │
│  Data Fetcher: Yahoo Finance (primary) → Alpha Vantage   │
│  Ranking Engine: 6-factor interpretable model            │
│  Storage: SQLite (better-sqlite3 + Drizzle ORM)          │
└─────────────────────────────────────────────────────────┘
```

### Factor Model Weights
| Factor | Weight | Source |
|--------|--------|--------|
| Momentum (20/60/120d returns) | 28% | Historical prices |
| Earnings direction/revisions | 20% | Yahoo Finance fundamentals |
| Trend (SMA, MACD, RSI) | 18% | Computed from price history |
| Valuation (P/E, P/B, EV/EBITDA) | 15% | Yahoo Finance |
| Quality (margins, ROE, FCF) | 12% | Yahoo Finance |
| Sentiment/Analyst | 7% | Yahoo Finance estimates |

---

## APIs Used

| Source | Usage | Key Required | Rate Limit |
|--------|-------|-------------|-----------|
| Yahoo Finance v8/v10 | Primary data source | ❌ No | ~2000 req/hour |
| Alpha Vantage | Fallback data source | ✅ Free | 25 req/day free |

---

## Supported Universe

- **US:** NASDAQ, NYSE — full coverage (any valid ticker)
- **European:** Accessed via ADR or OTC tickers (ASML, SAP, NVO, SIEGY, ALIZY, etc.)
- **ETFs:** Any ETF listed on US exchanges
- **Default universe:** 40 stocks/ETFs across US, Europe, Global ETFs
- **Custom:** Add any globally-listed ticker via the Universe page

---

## Local Run Instructions

### Prerequisites
- Node.js 18+ 
- npm 8+

### Steps

```bash
# 1. Clone / extract project
cd stock-recommender

# 2. Install dependencies
npm install

# 3. Configure environment (optional)
cp .env.example .env
# Edit .env if you have an Alpha Vantage key

# 4. Start development server
npm run dev

# App runs at: http://localhost:5000
```

### First use
1. Open http://localhost:5000
2. Click **Refresh** in the top bar — this fetches data for all 40 default stocks
3. Wait ~60 seconds for all stocks to load (Yahoo Finance rate limiting)
4. Results appear in the Dashboard table
5. Enable **Auto-refresh** via Scheduler → Start (15-minute default)

---

## Refresh Logic

| Interval | Best for | Yahoo Finance limit |
|----------|----------|-------------------|
| 5 min | Active trading, high priority | Use sparingly |
| 15 min | Standard intraday monitoring | Recommended |
| 30 min | Low bandwidth / free tier | Conservative |
| 60 min | Background monitoring | Most conservative |

- Scheduler checks exchange trading hours before each refresh
- If no market is open, the scheduled refresh is **skipped** (saves API calls)
- Manual refresh bypasses market hours check
- Data freshness shown per row (RT / 15m delay / EOD)

---

## Easiest Browser Access

### Local development
```
http://localhost:5000
```

### LAN access (from phone/tablet)
```
http://[your-local-IP]:5000
```
Find your IP with `ipconfig` (Windows) or `ifconfig`/`ip addr` (Linux/Mac).

---

## Production Deployment

### Option A: Railway.app (easiest, one-click)
1. Push code to GitHub
2. Connect repo to [Railway](https://railway.app)
3. Set `NODE_ENV=production` env var
4. Railway auto-deploys — get a permanent HTTPS URL

### Option B: Render.com (free tier available)
1. Push to GitHub
2. New Web Service on [Render](https://render.com)
3. Build command: `npm run build`
4. Start command: `node dist/index.cjs`
5. Free tier: 512MB RAM, spins down after inactivity

### Option C: VPS (Hetzner, DigitalOcean — ~€5/month)
```bash
npm run build
NODE_ENV=production node dist/index.cjs
```
Use `pm2` or `systemd` for persistence.

### Data persistence
The SQLite database (`stock-recommender.db`) is created in the project root.
For cloud deployment, mount a persistent volume or use the export features.

---

## Folder Structure

```
server/
  index.ts          Express entry point
  routes.ts         All API routes
  storage.ts        Database layer (Drizzle + SQLite)
  lib/
    dataFetcher.ts  Yahoo Finance + Alpha Vantage fetcher
    rankingEngine.ts  6-factor ranking model
    scheduler.ts    node-cron scheduler with market hours
client/src/
  pages/
    Dashboard.tsx   Main ranked table
    StockDetail.tsx Factor breakdown + audit trail
    Backtest.tsx    Historical accuracy metrics
    Universe.tsx    Universe & watchlist management
  components/
    Layout.tsx      Sidebar + header + disclaimer
    SignalBadge.tsx Buy/Watch/Avoid badge
    ScoreBar.tsx    Factor score bar
    DataTag.tsx     Data freshness indicator
shared/
  schema.ts         Drizzle ORM schema (all tables)
```
