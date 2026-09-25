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

Pin the exact signer set with `"members": ["<pubkey>", ...]` or upgrade authorities with `"programAuthorities": { "<program name>": "<authority>" }` if you want those to fail on change too. Key order and list order do not matter.

The valid fields are `threshold`, `totalMembers`, `timelockSeconds`, `configAuthority`, `members` and `programAuthorities`. Any other key (for example a misspelt one) fails the check, so a typo cannot pass silently.

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

The job also fails, whatever `fail-on-drift` is set to, when the comparison cannot be trusted: the expectation file is unreadable or has an unknown field, the API request fails, times out (15 seconds) or returns something other than JSON, the API answers for a different protocol than the one requested (names are compared case-insensitively), or the live state is older than `max-age-hours`.

Exit codes: `0` matches, `1` drift, `2` the check could not run or could not be trusted.

## Inputs

| Input | Default | Meaning |
|---|---|---|
| `protocol` | required | Name as tracked by solgov, exactly as listed by `/api/v1/protocols` (case-insensitive) |
| `expected` | `.solgov.json` | Path to the expectation file |
| `fail-on-drift` | `true` | Exit non-zero on any difference |
| `api-base` | `https://solgov.xyz` | API base URL |
| `max-age-hours` | `48` | Fail when the live state's `lastChecked` is older than this. `0` disables the check |

## Outputs

`drifted` (`true`/`false`) and `live` (the JSON that was compared), for use in later steps.

## Data

Read from `GET /api/v1/governance/{protocol}`, which carries `lastChecked` and `stalenessHours` so you can see how fresh the comparison is. No API key.
