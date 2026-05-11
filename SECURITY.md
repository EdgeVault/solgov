# Security Policy

solgov is an on-chain governance transparency tool for Solana DeFi. This document covers how to report security issues in solgov itself.

## In scope

- Scanner code under `sentinel/`
- Dashboard under `public-dashboard/`
- Public API at `api.solgov.xyz`
- Live site at `solgov.xyz`

## Out of scope

Governance vulnerabilities in the protocols solgov tracks (Drift, Kamino, Orca, and others) should be reported to those protocol teams directly. solgov is an observer of on-chain state. See [`disclosures.md`](disclosures.md) for how on-chain configuration observations are surfaced.

Issues in third-party services solgov depends on (Helius, DeFiLlama, Vercel, Cloudflare) should be reported to those vendors.

## How to report

- **Preferred:** GitHub Private Vulnerability Reporting on this repo (Security tab → Report a vulnerability).
- **Alternative:** DM [@Trader_CSK](https://x.com/Trader_CSK) on X.

Please do not open public issues for suspected vulnerabilities.

## Response

solgov is single-maintainer. Reports are read and triaged by the maintainer directly. Fixes are pushed once verified. Reporters are credited in the commit unless they prefer otherwise.

No bug bounty.
