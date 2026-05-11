# Transparency policy

solgov reads on-chain governance state and presents what it observes. Multisig members, thresholds, timelocks, configAuthority, program upgrade authorities, signer-funder graphs, and durable-nonce activity are all visible on the Solana blockchain to anyone with an RPC connection. solgov reads that state continuously and surfaces it in one place.

## What this means in practice

- Configuration patterns are surfaced as soon as the maintainer can verify them against on-chain references.
- Observations derived from on-chain data are not held back for an embargo window. The underlying state is already public.
- Public references do not name individual signers and do not speculate about intent.

## Disputes and corrections

If a protocol team or signer believes a specific entry is factually wrong, contact [@Trader_CSK](https://x.com/Trader_CSK) on X with the on-chain reference. Corrections are applied within 24 hours once verified.

If a protocol team would like to add context that does not contradict on-chain state (audit references, recovery procedures, intentional configuration choices), that context is welcomed and can be surfaced alongside the observation.

## Privacy of off-chain engagement

Conversations with protocol teams, ecosystem leaders, and integration partners that occur off chain are not surfaced in public copy. Names of individuals from those conversations are kept private. This keeps engagement separate from any implied endorsement or partnership. Receipts are available on request to judges, partners, or potential collaborators who need to verify the engagement record.

## Live data

The dashboard at [solgov.xyz](https://solgov.xyz) and the API at [api.solgov.xyz](https://api.solgov.xyz) reflect the most recent on-chain reads. Every protocol entry traces to source files in [`public-dashboard/src/data/protocols.ts`](public-dashboard/src/data/protocols.ts) and on-chain references that any reader can re-verify with a Solana RPC.

## Reporting a vulnerability in solgov itself

See [`SECURITY.md`](SECURITY.md). Use GitHub Private Vulnerability Reporting, or DM [@Trader_CSK](https://x.com/Trader_CSK).
