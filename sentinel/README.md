# Sentinel

Sentinel is the scanner backend behind solgov.xyz. Reads multisig configurations, program upgrade authorities, durable nonce status, and recent rotation patterns directly from chain. Outputs structured data and plain-English reports.

Built in response to the $285M Drift exploit. Continues to run as the data layer for the public dashboard.

## What It Surfaces

The scanner output presents on-chain facts. Readers compare against [Squads' published Advanced Security Best Practices](https://docs.squads.so/main/additional-resources/advanced-security-best-practices), which solgov treats as the reference (4/6+ threshold at 67%+ ratio, role separation, timelock durations chosen by action type).

### Patterns that matched Drift's exploit-time setup

1. Multisig threshold at or below 40% (Drift was 2/5)
2. Zero timelock on admin/authority actions (Drift had instant execution)
3. Single admin key controls multiple critical functions (no role separation)
4. No withdrawal rate limits or circuit breakers in the program
5. Recent multisig rotation without corresponding security upgrade
6. Active durable nonce accounts on multisig signers

### Patterns anchored to Squads' published reference

7. Threshold below Squads' 67% ratio reference (4/6 example)
8. Fewer than 4 signers (below Squads' 4/6+ example)
9. All signers have identical permissions (Squads recommends role separation: propose, vote, execute)

### Other observable factors

10. Program upgrade authority held by a single wallet, not a multisig
11. Non-Squads governance (SPL Governance, Realms, Serum-fork, mean-multisig) decoded via custom classifiers
12. No on-chain verified build
13. Program is upgradeable (not immutable)

## Setup

```bash
cd sentinel
npm install
cp .env.example .env
# Edit .env and add your Helius API key
```

## Usage

```bash
# Full scan - writes JSON + markdown to reports/
npm run scan

# Dry run - console output only, no files written
npm run scan:dry

# Safe mode - redacts protocol names in output
npm run scan:safe
```

## Output

- `reports/scan-YYYY-MM-DD.json` - full structured data per protocol
- `reports/summary-YYYY-MM-DD.md` - plain-English report

Output presents observable on-chain facts: threshold values, timelock seconds, signer counts, configAuthority addresses, recent rotation dates. Comparison to Squads' published reference is shown where relevant. Readers draw their own conclusions.

## Architecture

```
sentinel/src/
  scanner/          - On-chain data fetchers
    programAuthority.ts   - BPF Upgradeable Loader authority lookup
    squadsConfig.ts       - Squads V4 multisig config + vault PDA reverse lookup
    governanceDetector.ts - Identifies non-Squads governance programs
    nonceDetector.ts      - Durable nonce detection with timeout
    rotationDetector.ts   - Recent multisig config change detection
    verifiedBuild.ts      - On-chain build verification
    circuitBreakers.ts    - Stub (protocol-specific, needs IDLs)
  scoring/          - Internal triage heuristics (not surfaced publicly)
    riskScore.ts          - Internal triage with Drift pattern count
    benchmarks.ts         - Threshold and timelock benchmarks anchored to Squads' reference
  protocols/        - Tracked protocol registry
    registry.ts
  output/           - Report generation
    reporter.ts           - Markdown summary
    templates.ts          - Report card structure
  utils/            - Shared helpers
    connection.ts         - Helius RPC + retry/timeout utilities
    constants.ts          - Program IDs, known governance programs
  index.ts          - CLI orchestrator
```

## License

MIT. See [LICENSE](../LICENSE) at the repo root.
