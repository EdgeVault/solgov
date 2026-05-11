# public-dashboard

The web UI for [solgov.xyz](https://solgov.xyz). React + Vite + Tailwind, deployed to Vercel.

For project-level context, the architecture overview, and the rest of the system (Sentinel backend, public API, Telegram bot), see the [root README](../README.md).

## Local development

```bash
npm install
npm run dev
```

The dev server fetches a live snapshot from `api.solgov.xyz` on start. Build output:

```bash
npm run build
```

## Data flow

A build-time snapshot is bundled into the app, then `/api/state` and `/api/historical` overlay live state on first render. Snapshots live in `src/data/` and are refreshed against the live API on every deploy.

## Source of truth

Protocol entries, governance data, and dependency mappings live in `src/data/`:

- `protocols.ts` — every tracked protocol's governance configuration, members, programs, audits, insurance disclosure
- `governance.ts` — governance activity for each tracked protocol (proposals, signers, off-hours patterns)
- `exposure.ts` — cross-protocol dependencies for each tracked protocol
- `relationships.ts` — connection graph for Blast Radius

Every entry sources to either an on-chain RPC read or a named URL.
