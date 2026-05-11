# Percolator research surface

A supporting note for the "Percolator research surface" section of the [main README](../README.md).

## What it is

An observational research stream that runs alongside solgov. The target is an immutable Solana program whose admin keys have been burned and whose insurance vault is publicly designated as a bug bounty surface. Because the deployment is immutable and intentional, on-chain activity against it is a useful natural-experiment dataset for studying probe behaviour against a known-fixed target.

Every transaction the program receives is captured and decoded by instruction tag.

## What it observes

Each decoded transaction is classified into one of three buckets:

- **Legitimate.** Tag, account layout, signer count, and compute usage are consistent with the program's published interface.
- **Probe.** The transaction shows at least one anomaly versus the legitimate baseline. Anomaly types tracked include:
  - Use of an instruction tag that was deleted in a prior program version
  - Failed transaction with anomalously high compute consumption
  - Multiple signers on an instruction that the legitimate path expects to be single-signed
  - Unusual or duplicated account ordering in the instruction's account list
- **Unclear.** Insufficient information to classify confidently. Held for later review rather than auto-bucketed.

Probe transactions are logged with the timestamp, instruction tag, anomaly category, and signer set. No claim is made about whether any individual call extracted value or was malicious in intent. The bucket label is structural, not behavioural.

## How it feeds back into solgov

The probe patterns observed against the immutable target inform the signal filters applied to live tracked protocols on solgov. Concretely:

- **Anomalous compute fingerprints** seen on the research surface help the listener distinguish probable probe transactions from routine instruction-tag activity on a tracked protocol's authority wallet
- **Deleted-opcode hits** suggest a caller working from an outdated IDL or attempting tag confusion, which informs how the scanner classifies anomalous program-instruction patterns on tracked authorities
- **Multi-signer + unusual-account-layout combinations** on a tracked protocol's admin or upgrade authority elevate the alert tier, anchored to the same anomaly types observed empirically against the research target

In short: the research surface is a controlled environment for calibrating what "interesting" looks like on chain. Those calibrations shape solgov's noise floor on the protocols it actually monitors.

## Constraints

- **Observational only.** No transaction is ever sent to a tracked protocol from this research surface. The dataset is read-only.
- **No protocol-level claims.** Findings against the research target are not transposed onto tracked protocols. Pattern shapes inform detection thresholds; specific findings stay scoped to the target.
- **Neutral language.** Probe classifications are structural anomalies, not intent statements. The dataset does not assert anything about who sent any given transaction or why.
- **Private adjacent work.** Some of the deeper structural analysis on the research surface is held privately and selectively disclosed to affected protocol teams through standard responsible-disclosure channels. The public surface is the methodology and the calibration loop described above.

## Files in this repo

The research surface itself is not part of the solgov public repo. The detection logic that consumes its calibrated thresholds lives in [`sentinel/src/scanner/`](../sentinel/src/scanner/) and the LLM triage layer at [`sentinel/src/llm-triage.ts`](../sentinel/src/llm-triage.ts). Where a specific scanner threshold or anomaly category was tuned by observations on the research surface, the code comments at the call site flag it.
