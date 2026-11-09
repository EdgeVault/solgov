// Squads V4 multisig configuration detector. Pure: takes two snapshots, returns the typed changes.
// Shared by the live listener (solgov-listener.ts) and the replay engine (replay.ts), so a replayed
// window runs exactly the rules that alert in production.

export type Severity = 'CRITICAL' | 'HIGH' | 'MONITOR';

export interface TypedChange {
  type: string;
  detail: string;
  severity: Severity;
}

export interface MultisigSnapshot {
  address?: string;
  threshold: number;
  memberCount: number;
  voterCount?: number;
  timeLock: number;
  configAuthority: string; // 'autonomous' when unset or the System Program
  memberKeys: string[];
}

export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const PERM_VOTE = 2;

export function normaliseConfigAuthority(ca: string | null | undefined): string {
  return !ca || ca === SYSTEM_PROGRAM ? 'autonomous' : ca;
}

// Snapshot from a decoded @sqds/multisig Multisig account.
export function snapshotFromV4(ms: any, address?: string): MultisigSnapshot {
  const maskOf = (m: any) => { const mask = (m.permissions as any)?.mask ?? (m.permissions as any) ?? 0; return typeof mask === 'number' ? mask : 0; };
  const ca = (ms as any).configAuthority;
  return {
    ...(address ? { address } : {}),
    threshold: ms.threshold,
    memberCount: ms.members.length,
    voterCount: ms.members.filter((m: any) => maskOf(m) & PERM_VOTE).length,
    timeLock: ms.timeLock,
    configAuthority: normaliseConfigAuthority(ca ? ca.toBase58() : null),
    memberKeys: ms.members.map((m: any) => m.key.toBase58()),
  };
}

export function timelockLabel(s: number): string {
  if (s === 0) return 'none';
  const h = s / 3600;
  if (h >= 1) return `${Math.round(h)}h`;
  return `${Math.round(s / 60)}min`;
}

export function classifyV4Change(prev: MultisigSnapshot, now: MultisigSnapshot): TypedChange[] {
  const events: TypedChange[] = [];

  if (now.threshold < prev.threshold) {
    events.push({ type: 'ThresholdLowered', detail: `Threshold: ${prev.threshold} → ${now.threshold}`, severity: 'CRITICAL' });
  } else if (now.threshold > prev.threshold) {
    events.push({ type: 'ThresholdRaised', detail: `Threshold: ${prev.threshold} → ${now.threshold}`, severity: 'HIGH' });
  }

  const added = now.memberKeys.filter(k => !prev.memberKeys.includes(k));
  const removed = prev.memberKeys.filter(k => !now.memberKeys.includes(k));
  if (added.length > 0 && removed.length > 0 && added.length === removed.length && now.memberCount === prev.memberCount) {
    // Intra-tx rotation: members swapped out 1:1 with count unchanged.
    events.push({ type: 'SignerRotation', detail: `Signer rotation: ${added.length} swapped (total signers unchanged at ${now.memberCount})`, severity: 'HIGH' });
  } else {
    if (removed.length > 0) {
      const sev: Severity = removed.length >= 3 ? 'CRITICAL' : 'HIGH';
      events.push({ type: 'SignersRemoved', detail: `Total signers: ${prev.memberCount} → ${now.memberCount} (-${removed.length})`, severity: sev });
    }
    if (added.length > 0) {
      events.push({ type: 'SignersAdded', detail: `Total signers: ${prev.memberCount} → ${now.memberCount} (+${added.length})`, severity: 'MONITOR' });
    }
  }

  if (prev.timeLock === 0 && now.timeLock > 0) {
    events.push({ type: 'TimelockAdded', detail: `Timelock: none → ${timelockLabel(now.timeLock)}`, severity: 'HIGH' });
  } else if (prev.timeLock > 0 && now.timeLock === 0) {
    events.push({ type: 'TimelockRemoved', detail: `Timelock: ${timelockLabel(prev.timeLock)} → none`, severity: 'CRITICAL' });
  } else if (now.timeLock !== prev.timeLock) {
    const sev: Severity = now.timeLock < prev.timeLock ? 'HIGH' : 'MONITOR';
    events.push({ type: 'TimelockChanged', detail: `Timelock: ${timelockLabel(prev.timeLock)} → ${timelockLabel(now.timeLock)}`, severity: sev });
  }

  // Members that lost the Vote permission lower the number of signers who can approve without any
  // change to threshold or member count. Only compared when both sides recorded a voter count.
  if (typeof prev.voterCount === 'number' && typeof now.voterCount === 'number' && prev.voterCount !== now.voterCount) {
    const sev: Severity = now.voterCount < prev.voterCount ? 'HIGH' : 'MONITOR';
    events.push({ type: 'VotersChanged', detail: `Members who can vote on proposals: ${prev.voterCount} → ${now.voterCount}`, severity: sev });
  }

  if (prev.configAuthority !== now.configAuthority) {
    if (now.configAuthority !== 'autonomous' && prev.configAuthority !== 'autonomous') {
      events.push({ type: 'ExternalAdminKeyChanged', detail: `External admin key on multisig: ${prev.configAuthority.slice(0, 12)}... → ${now.configAuthority.slice(0, 12)}...`, severity: 'CRITICAL' });
    } else if (now.configAuthority !== 'autonomous') {
      events.push({ type: 'ExternalAdminKeyAdded', detail: `External admin key on multisig: none → ${now.configAuthority.slice(0, 12)}...`, severity: 'CRITICAL' });
    } else {
      events.push({ type: 'ExternalAdminKeyCleared', detail: `External admin key on multisig: ${prev.configAuthority.slice(0, 12)}... → none`, severity: 'HIGH' });
    }
  }

  return events;
}

export function overallSeverity(events: { severity: Severity }[]): Severity {
  const rank: Record<Severity, number> = { MONITOR: 0, HIGH: 1, CRITICAL: 2 };
  let max: Severity = 'MONITOR';
  for (const e of events) if (rank[e.severity] > rank[max]) max = e.severity;
  return max;
}
