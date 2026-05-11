# Contributing to solgov

solgov is a security-adjacent project. The contribution surface is intentionally narrow.

## Suggest a protocol for inclusion

To propose a new protocol for the scanner:

1. DM [@Trader_CSK](https://x.com/Trader_CSK) on X with the protocol's name and a public reference (docs, X account, or a program ID).
2. The maintainer verifies the on-chain governance configuration directly. Confirmed entries are added to [`public-dashboard/src/data/protocols.ts`](public-dashboard/src/data/protocols.ts) after the team is reachable for review.

## Report a factual correction

If solgov shows a configuration that you believe is incorrect or missing context:

1. **Protocol teams** representing a tracked entry: DM [@Trader_CSK](https://x.com/Trader_CSK) with the on-chain reference. Corrections are applied within 24 hours once verified.
2. **Researchers and users**: open a GitHub issue with the on-chain reference (multisig address or program ID) and a description of the discrepancy.

## Share off-chain context

If you have off-chain context about a protocol's governance posture (planned migration, signer change, audit finding) that is not contradicted by on-chain state, DM the maintainer directly. Off-chain conversations are kept private per the [transparency policy](disclosures.md).

## Vulnerabilities in solgov itself

See [`SECURITY.md`](SECURITY.md). Use GitHub Private Vulnerability Reporting on this repo, or DM [@Trader_CSK](https://x.com/Trader_CSK).

## Code contributions

Pull requests are reviewed but not actively solicited. The project is single-maintainer and prioritises stability of the live monitoring loop over feature breadth. If you have a substantial change in mind, raise an issue first.

There is no Discord. The maintainer is reachable on X.
