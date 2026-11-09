// Program upgrade / upgrade-authority detector. Pure: decides from ProgramData values whether a write
// was a real redeploy, an authority change, or neither, and how severe it is. Shared by the live
// listener and the replay engine.

import { PublicKey } from '@solana/web3.js';
import type { Severity } from './multisig-config';

export type ProgramRole = 'holds-funds' | 'routes-funds' | 'peripheral';

// Programs whose upgrade authority is a single wallet with no multisig found on-chain.
export const NO_MULTISIG_PROGRAMS = ['BisonFi', 'HumidiFi', 'Photon', 'Save'];

// Reads the upgrade authority and deploy slot from a ProgramData account. Returns null when the data
// is not a ProgramData account (too short, wrong tag) so a failed read is never recorded as IMMUTABLE.
export function readProgramData(data: Buffer): { authority: string; deploySlot: number } | null {
  if (data.length < 45 || data.readUInt32LE(0) !== 3) return null;
  const authority = data[12] === 1 ? new PublicKey(data.subarray(13, 45)).toBase58() : 'IMMUTABLE';
  return { authority, deploySlot: Number(data.readBigUInt64LE(4)) };
}

export interface ProgramObservation {
  prevAuthority?: string;   // last seen upgrade authority, undefined when there is no baseline
  authority: string;        // authority now ('IMMUTABLE' when none)
  prevDeploySlot?: number;  // last seen deploy slot, undefined when there is no baseline
  deploySlot: number;       // deploy slot now
  deployTime: number | null; // unix seconds of the deploy slot, when known
  nowSec: number;           // unix seconds at which the observation is evaluated
}

export interface ProgramDecision {
  isAuthorityChange: boolean;
  isRealUpgrade: boolean;
}

// A ProgramData write fires on any change to the account (rent top-up, a write that does not redeploy),
// not only on an upgrade. A redeploy is proven by the last-deployed slot (written only by the loader on
// deploy/upgrade) advancing past the baseline, or, with no baseline, by a deploy in the last 30 minutes.
// Authority changes are proven from the authority bytes and fire regardless.
export function decideProgramEvent(o: ProgramObservation): ProgramDecision {
  const isAuthorityChange = o.prevAuthority !== undefined && o.prevAuthority !== o.authority;
  const slotAdvanced = o.prevDeploySlot !== undefined && o.deploySlot > o.prevDeploySlot;
  const recentlyDeployed = o.prevDeploySlot === undefined && !!o.deployTime && (o.nowSec - o.deployTime) < 30 * 60;
  return { isAuthorityChange, isRealUpgrade: slotAdvanced || recentlyDeployed };
}

export function classifyProgramSeverity(args: { name: string; role: ProgramRole; isAuthorityChange: boolean; hourUtc: number }): { severity: Severity; header: string } {
  const { name, role, isAuthorityChange, hourUtc } = args;
  const isNoMultisig = NO_MULTISIG_PROGRAMS.some(s => name.includes(s));
  const isOffHours = hourUtc < 6 || hourUtc > 22;
  if (isNoMultisig) {
    return {
      severity: 'CRITICAL',
      header: isAuthorityChange
        ? '🔴 <b>CRITICAL: Who can upgrade this program changed (no multisig found on-chain)</b>'
        : '🔴 <b>CRITICAL: Program code updated by a single wallet (no multisig found on-chain)</b>',
    };
  }
  if (role === 'holds-funds' && isAuthorityChange) return { severity: 'CRITICAL', header: '🔴 <b>CRITICAL: Control of a program holding user funds changed</b>' };
  if (role === 'routes-funds' && isAuthorityChange) return { severity: 'HIGH', header: '🟠 <b>HIGH: Control of a program routing user funds changed</b>' };
  if (role === 'peripheral' && isAuthorityChange) return { severity: 'MONITOR', header: '🟦 <b>Control of a supporting program changed</b>' };
  if (role === 'holds-funds') {
    return { severity: 'HIGH', header: isOffHours ? '🟠 <b>HIGH: Code updated on a program holding user funds (outside 06:00-22:00 UTC)</b>' : '🟠 <b>HIGH: Code updated on a program holding user funds</b>' };
  }
  if (role === 'routes-funds') {
    return isOffHours
      ? { severity: 'HIGH', header: '🟠 <b>HIGH: Code updated on a program routing user funds (outside 06:00-22:00 UTC)</b>' }
      : { severity: 'MONITOR', header: '🟦 <b>Code updated on a program routing user funds</b>' };
  }
  return { severity: 'MONITOR', header: '🟦 <b>Supporting program code updated</b>' };
}
