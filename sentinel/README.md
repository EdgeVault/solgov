# Sentinel - Solana Protocol Governance Scanner

Born 24 hours after the $270M Drift exploit - the first on-chain governance scanner in the entire Colosseum database.

Scans the exact governance failure patterns (2/5 threshold + zero timelock + durable nonces) that no existing tool monitors. Private scans, Solana Foundation disclosure, 30-day remediation window. First governance transparency layer for Solana.

## What It Detects

### Critical (Drift Had All of These)
1. Low multisig threshold relative to signer count (Drift: 2/5)
2. Zero timelock on admin/authority actions (Drift: instant execution)
3. No permission separation - single admin key controls everything
4. No withdrawal rate limits or circuit breakers
5. Recent multisig rotation without corresponding security upgrade (Drift: rotated 10 days before exploit)
6. Active durable nonce accounts on multisig signers (Drift: pre-positioned weeks in advance)

### High Risk
7. Program upgrade authority is a single wallet (not multisig)
8. Non-Squads governance (SPL Governance, Goki) - detected but config not decoded
9. Threshold under 60% of total signers
10. Timelock under 24 hours

### Moderate Risk
11. Fewer than 5 total signers
12. All signers have identical permissions
13. No verified build on-chain
14. Program is upgradeable (not immutable)

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

# Safe mode - redacts protocol names in output (for pre-disclosure use)
npm run scan:safe
```

## Output

- `reports/scan-YYYY-MM-DD.json` - Full structured data per protocol
- `reports/summary-YYYY-MM-DD.md` - Plain English report for Foundation disclosure

## Risk Scoring

Each protocol starts at 100 and loses points for governance weaknesses:

| Finding | Penalty |
|---------|---------|
| Authority is single wallet (EOA) | -30 |
| Multisig threshold <= 40% | -25 |
| Zero timelock | -25 |
| Active nonces on signers | -15 |
| Threshold < 60% | -15 |
| Unknown governance program | -10 |
| Recent rotation (< 14 days) | -10 |
| Timelock < 24 hours | -10 |
| < 5 signers | -5 |
| No role separation | -5 |
| No verified build | -3 |

**Drift Similarity Score**: 0-8 count of how many specific Drift exploit patterns match.

## Responsible Disclosure

1. Run the scan privately
2. Review results - identify protocols matching Drift patterns
3. DO NOT publish raw results
4. Contact Solana Foundation security through Superteam UK
5. Share report under responsible disclosure
6. Give protocols 30 days to remediate
7. After remediation, publish methodology and anonymised findings

## Architecture

```
sentinel/src/
  scanner/          - On-chain data fetchers
    programAuthority.ts   - BPF Upgradeable Loader authority lookup
    squadsConfig.ts       - Squads V4 multisig config + vault PDA reverse lookup
    governanceDetector.ts - Identifies non-Squads governance programs
    nonceDetector.ts      - Durable nonce detection with timeout
    rotationDetector.ts   - Recent multisig config change detection
    verifiedBuild.ts      - Ellipsis Labs on-chain build verification
    circuitBreakers.ts    - Stub (protocol-specific, needs IDLs)
  scoring/          - Risk assessment
    riskScore.ts          - 0-100 scoring with Drift similarity
    benchmarks.ts         - Toly's gold standard + TVL tier requirements
  protocols/        - What to scan
    registry.ts           - 15 protocols, priority-ordered
  output/           - Report generation
    reporter.ts           - Markdown summary for Foundation
    templates.ts          - Report card structure
  utils/            - Shared helpers
    connection.ts         - Helius RPC + retry/timeout utilities
    constants.ts          - Program IDs, known governance programs
  index.ts          - CLI orchestrator
```

## License

Private - not for redistribution. Methodology will be published after responsible disclosure.
