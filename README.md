# solgov

Real-time governance monitoring for Solana DeFi. Reads the multisig setup itself across 53 protocols - threshold, signers, timelocks, config authorities, program upgrades - continuously, and surfaces the configurations that show up before exploits.

Live at [solgov.xyz](https://solgov.xyz). Public alerts at [t.me/SolGovActivity](https://t.me/SolGovActivity). Telegram bot at [@SolGov_bot](https://t.me/SolGov_bot) for personal subscriptions and `/check` lookups.

---

## What this repo contains

```
public-dashboard/   React + Vite, deployed to Vercel
sentinel/           Scanner, listener, monitor cron, API, Telegram bot (VPS)
submission/         Frontier hackathon submission materials
```

### public-dashboard

The web UI at `solgov.xyz`. Four tabs:

- **Dashboard** - sortable table of every tracked protocol's governance state
- **GovWatch** - live activity feed and a governance health view for every team in the table
- **Blast Radius** - dependency map showing how a compromise in one protocol can cascade
- **Charts** - exploit history, risk metrics, governance health over time

Data flows: build-time snapshot bundled into the app, then `/api/state` and `/api/historical` overlay live state on first render.

### sentinel

The backend that runs on a VPS:

- `solgov-listener.ts` - WebSocket account-subscribe on every tracked Squads V4 multisig. Detects threshold, member, timelock, and configAuthority diffs in real time.
- `solgov-monitor.ts` - cron-driven full + config scans. Catches anything the listener misses (V3 multisigs, single-signer programs, Wormhole, Realms DAO).
- `solgov-api.ts` - HTTP API. Serves monitor state, historical aggregates, and the governance slice for any tracked protocol. Receives Helius webhooks.
- `solgov-bot.ts` - Telegram bot. `/status`, `/check`, `/report`, `/nonce`, subscriptions with severity and event-type filters, auto-triage on critical alerts.
- `incremental-scan.ts` - cron job that runs daily and aggregates governance event counts (proposals, config changes, etc.) for every tracked protocol. Covers Squads V4, V3, and the mean-multisig Anchor fork.
- `scan-signer-funders.ts` - looks at who funded each multisig signer in the past. Baseline for spotting new funders later.
- `scanner/` - reusable detection modules (governance type, nonce signers, circuit breakers, signer profiles, verified builds).
- `cron-daily-integrity.ts`, `cron-weekly.ts`, `cron-daily-digest.ts` - scheduled jobs.

#### Detection rules

Nine pattern detectors live as standalone scripts at `sentinel/src/`:

1. `brand-new-signer.ts` - signers placed on a fresh multisig at creation when their own wallet is only days old
2. `dryrun-fingerprint.ts` - multisigs that match the rehearsal-pattern shape (small membership, all-signed proposal, never executed)
3. `controlled-multisig-cluster.ts` - same external configAuthority key set across multiple multisigs in a protocol's setup
4. `weakest-link-migration.ts` - admin role transferred from an existing multisig to one with weaker security posture
5. `fresh-multisig-handover.ts` - admin role transferred to a multisig less than 14 days old
6. `stale-config-authority.ts` - long-dormant external configAuthority keys
7. `governance-burst.ts` - bursts of security-model config changes on a single multisig
8. `upgrade-authority-concentration.ts` - single vault PDA holding upgrade authority over many programs
9. `signer-funder-detection.ts` - flags signers funded by sources that haven't appeared before, with a registry that links funders across the protocols they touch

---

## Running it

### public-dashboard

```bash
cd public-dashboard
npm install
npm run dev
```

Build:
```bash
npm run build
```

Vercel deploy is direct - no GitHub integration.

### sentinel

```bash
cd sentinel
npm install
cp .env.example .env   # fill in HELIUS_API_KEY, HELIUS_RPC_URL, TELEGRAM_BOT_TOKEN, GROQ_API_KEY
```

Run a config scan:
```bash
npx tsx src/solgov-monitor.ts config
```

Run the listener:
```bash
npx tsx src/solgov-listener.ts
```

Run the API:
```bash
npx tsx src/solgov-api.ts
```

The Telegram bot, listener, monitor, and API all run as `pm2` daemons in production.

---

## Data sources

- **On-chain reads** via Helius RPC: every multisig threshold, signer, timelock, config authority, program upgrade, and proposal lifecycle
- **TVL** via DeFiLlama
- **Protocol health flags** via the Yieldbay API (cached at `sentinel/data/yieldbay-cache.json`)
- **Audit firms, public docs, and disclosure context** are hand-curated against source links in `public-dashboard/src/data/protocols.ts`

Nothing scraped. Anything not from on-chain reads is credited at the source.

---

## Status

- 50 protocols tracked
- 51 multisigs in coverage (Squads V4, V3, Serum, mean-multisig)
- Public API in private beta
- Telegram bot in private beta
- Disclosure track record: Drift, Solstice, Foundation, Yieldbay, Jupiter

Built solo by [@Trader_CSK](https://x.com/Trader_CSK).

---

## Contributing

Contact via X DM. Protocols wanting to disclose security features for inclusion in the dashboard are welcome to reach out - disclosed entries appear after the team is verified.
