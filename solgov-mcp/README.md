# solgov-mcp

An [MCP](https://modelcontextprotocol.io) server that gives AI agents read access to [solgov.xyz](https://solgov.xyz), the on-chain governance transparency tracker for Solana DeFi.

Before an agent deposits into or interacts with a protocol it can ask: who can upgrade this program, what does the multisig look like, is there a timelock, has anything changed recently, is there an upgrade queued right now, and does the deployed code match a verified build. Every tool returns solgov's on-chain facts as they are. Nothing here scores, ranks or advises.

No API key. Read-only. Public data.

## Install

```
npx solgov-mcp
```

Or add it to a client configuration. Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "solgov": {
      "command": "npx",
      "args": ["-y", "solgov-mcp"]
    }
  }
}
```

Cursor, Windsurf and other MCP clients take the same `command` / `args` shape.

To point at a self-hosted API set `SOLGOV_API_BASE` (default `https://solgov.xyz`).

## Tools

| Tool | What it returns |
|---|---|
| `solgov_list_protocols` | Every tracked protocol with threshold, signer count, timelock, config authority and governance model. Use it to find exact names. |
| `solgov_get_governance` | Full current state for one protocol: multisig, timelock, config authority, program upgrade authorities, pending proposals, threat alerts, and how fresh the read is. |
| `solgov_recent_events` | Recent governance events across all protocols, newest first. Filter by protocol or event type. |
| `solgov_changelog` | Permanent change history for one protocol. Each event is citable by timestamp, type and detail. |
| `solgov_pending_upgrades` | Queued Squads proposals that would upgrade a program, move an upgrade authority or change a multisig, with approvals against threshold and the timelock still to run. Visible before the change lands. |
| `solgov_signer_independence` | For teams with two or more multisigs, how distinct the signer sets are, with pairwise shared-signer counts. |
| `solgov_verified_builds` | Verified-build status per program, counted only when the registry record is signed by the upgrade authority and the deployed hash still matches. Separates "verified", "verified once but upgraded since" and "not verified". |
| `solgov_upgrade_cadence` | Upgrades observed per protocol, last 30 days, mean interval. |
| `solgov_health` | Freshness of every data surface with age and a stale flag. Check before relying on a number. |
| `solgov_stride_mapping` | How solgov fields map to the STRIDE Governance controls (G1 to G5). Vocabulary only, no scores. |

## Data provenance

Everything comes from the public API at `https://solgov.xyz/api/v1/` (OpenAPI at `/api/v1/openapi.json`). Multisig state is decoded from on-chain accounts and refreshed continuously. Each protocol carries `lastChecked` and `stalenessHours`; `solgov_health` reports the age of every surface. Language is neutral by design: the data states what the configuration is and leaves the conclusion to the reader.

## Licence

MIT.
