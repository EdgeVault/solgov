# solgov-check

A GitHub Action that fails CI when your protocol's live on-chain governance drifts from what you have committed. It reads the same on-chain facts [solgov.xyz](https://solgov.xyz) tracks (multisig threshold, signer count and set, timelock, config authority, program upgrade authorities) and compares them with a file in your repository. It makes no judgement about the values; it only tells you when they change.

Use it to catch an unexpected signer swap, a lowered threshold or a removed timelock before it reaches users, or simply to keep your documented governance honest.

## Setup

1. Find your protocol name: `https://solgov.xyz/api/v1/protocols`
2. Commit `.solgov.json` with the fields you want pinned. Any subset is fine:

```json
{
  "threshold": 4,
  "totalMembers": 7,
  "timelockSeconds": 86400,
  "configAuthority": "autonomous"
}
```

Pin the exact signer set with `"members": ["<pubkey>", ...]` or upgrade authorities with `"programAuthorities": { "<program name>": "<authority>" }` if you want those to fail on change too.

3. Add a workflow:

```yaml
name: governance
on:
  schedule:
    - cron: '0 */6 * * *'
  workflow_dispatch:
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: EdgeVault/solgov/solgov-check@main
        with:
          protocol: 'Your Protocol'
```

The job fails on drift and writes a comparison table to the run summary. Set `fail-on-drift: 'false'` to report without failing.

## Inputs

| Input | Default | Meaning |
|---|---|---|
| `protocol` | required | Name as tracked by solgov |
| `expected` | `.solgov.json` | Path to the expectation file |
| `fail-on-drift` | `true` | Exit non-zero on any difference |
| `api-base` | `https://solgov.xyz` | API base URL |

## Outputs

`drifted` (`true`/`false`) and `live` (the JSON that was compared), for use in later steps.

## Data

Read from `GET /api/v1/governance/{protocol}`, which carries `lastChecked` and `stalenessHours` so you can see how fresh the comparison is. No API key.
