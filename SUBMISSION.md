# Colosseum Frontier 2026 — solgov submission

solgov is the governance transparency layer for Solana DeFi. Continuous on-chain reads across 50 protocols, surfacing the setup-risk patterns that precede admin-key exploits. Built solo in the weeks since the $285M Drift exploit on April 1, 2026.

## Quick links

| Surface | URL |
|---|---|
| Live product | https://solgov.xyz |
| Public API | https://api.solgov.xyz/api/state |
| API docs (OpenAPI 3.1) | https://solgov.xyz/api-docs.html |
| Pitch video | https://youtu.be/Y75dtof7LMY |
| Demo video | https://youtu.be/F1clEqm7SRk |
| Telegram broadcast | https://t.me/SolGovActivity |
| Telegram bot | https://t.me/SolGov_bot |
| X profile | https://x.com/SolGov_ |
| Founder | https://x.com/Trader_CSK |

## What solgov does

Reads governance configuration (multisigs, timelocks, signer permissions, upgrade authorities) for every tracked Solana DeFi protocol, continuously. Surfaces setup-risk patterns days or weeks before exploits land.

Three surfaces:

- **Dashboard** — full governance profile for every tracked protocol at solgov.xyz
- **Public API** — OpenAPI 3.1, no auth, free
- **Telegram** — public broadcast channel + personal bot with severity-filtered subscriptions

## Why Solana

Custom on-chain decoders for Squads V4, Squads V3, Serum Multisig, the Marinade mean-multisig fork, and SPL Governance. BPF Upgradeable Loader parsing for program upgrade authority lookup. WebSocket listener via Helius for sub-second governance event detection. The product reads multisig PDA byte layouts directly. It could not exist on EVM without rewriting from scratch.

## Public good

Open source under MIT. Free public dashboard. Free public API with no authentication. No token. No paywall. No monetised tier today.

## Tech stack

Solana Web3.js, @sqds/multisig SDK, Helius RPC and webhooks, TypeScript, React + Vite, Tailwind, Node.js, PM2. Custom decoders for four multisig systems plus SPL Governance. Four production daemons (listener, monitor, API, bot). Groq LLM for critical-alert triage. Live integrations with DeFiLlama, Yieldbay, OtterSec verified-programs registry, Ellipsis Labs verified-builds, Wormhole guardian set.

## Where to start in the repo

- [`README.md`](README.md) — architecture overview and full feature list
- [`public-dashboard/`](public-dashboard/) — the React/Vite app at solgov.xyz
- [`sentinel/`](sentinel/) — backend daemons (listener, monitor, API, bot) and scanner modules
- [`sentinel/src/scanner/`](sentinel/src/scanner/) — reusable detection modules
- [`sentinel/data/`](sentinel/data/) — on-chain tracked-protocol data and snapshot files
- [`public-dashboard/src/data/protocols.ts`](public-dashboard/src/data/protocols.ts) — source of truth for every tracked entry
- [`disclosures.md`](disclosures.md) — transparency policy for on-chain observations about tracked protocols
- [`SECURITY.md`](SECURITY.md) — how to report vulnerabilities in solgov itself

## Original on-chain forensic work

Two findings published during the Drift forensic pass, verifiable from chain:

1. A parallel rehearsal multisig created by the attacker a week earlier, running the same configuration sequence as the eventual exploit
2. An external configAuthority on the recovery setup that has not been addressed

## Built by

[@Trader_CSK](https://x.com/Trader_CSK) — solo, full-time on solgov since the Drift exploit on April 1, 2026.
