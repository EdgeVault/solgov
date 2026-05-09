import { Connection, PublicKey } from '@solana/web3.js';
import * as multisig from '@sqds/multisig';
import { SQUADS_V4_PROGRAM, SQUADS_V3_PROGRAM, DELAY_BETWEEN_CALLS } from '../utils/constants';
import { withRetry } from '../utils/connection';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface SquadsResult {
  isSquadsMultisig: boolean;
  squadsVersion: 'v4' | 'v3' | null;
  accountOwner: string;
  isVaultPDA: boolean;
  parentMultisig?: string;
  config?: {
    threshold: number;
    memberCount: number;
    members: Array<{
      key: string;
      permissions: number;
      permissionsReadable: string[];
    }>;
    timeLock: number;
    timeLockHours: number;
    configAuthority: string | null;
    createKey: string;
  };
  error?: string;
}

export async function checkSquadsConfig(
  connection: Connection,
  authorityAddress: string
): Promise<SquadsResult> {
  const authority = new PublicKey(authorityAddress);

  const accountInfo = await withRetry(
    () => connection.getAccountInfo(authority),
    `getAccountInfo(${authorityAddress})`
  );

  if (!accountInfo) {
    return { isSquadsMultisig: false, squadsVersion: null, accountOwner: 'unknown', isVaultPDA: false };
  }

  const owner = accountInfo.owner.toBase58();

  // === Direct Squads V4 account (multisig account itself, not vault) ===
  if (accountInfo.owner.equals(SQUADS_V4_PROGRAM)) {
    return await tryDecodeV4Direct(connection, authority, owner);
  }

  // === Direct Squads V3 account ===
  if (accountInfo.owner.equals(SQUADS_V3_PROGRAM)) {
    return await tryDecodeV3Direct(connection, authority, owner);
  }

  // === System Program account (0 data) - could be a vault PDA for V4 or V3 ===
  const isSystemAccount =
    owner === '11111111111111111111111111111111' &&
    accountInfo.data.length === 0;

  if (isSystemAccount) {
    // Try V4 vault reverse lookup first
    const v4Result = await reverseVaultLookup(connection, authorityAddress, SQUADS_V4_PROGRAM, 'v4');
    if (v4Result) return v4Result;

    // Try V3 vault reverse lookup
    const v3Result = await reverseVaultLookupV3(connection, authorityAddress);
    if (v3Result) return v3Result;
  }

  return { isSquadsMultisig: false, squadsVersion: null, accountOwner: owner, isVaultPDA: false };
}

// ============================================================
// Squads V4 decoding
// ============================================================

async function tryDecodeV4Direct(
  connection: Connection,
  authority: PublicKey,
  owner: string
): Promise<SquadsResult> {
  try {
    const ms = await multisig.accounts.Multisig.fromAccountAddress(connection, authority);
    return {
      isSquadsMultisig: true,
      squadsVersion: 'v4',
      accountOwner: owner,
      isVaultPDA: false,
      config: formatV4Config(ms),
    };
  } catch {
    // Owned by V4 but can't decode - try vault reverse lookup
    const result = await reverseVaultLookup(
      connection, authority.toBase58(), SQUADS_V4_PROGRAM, 'v4'
    );
    if (result) return result;

    return {
      isSquadsMultisig: true,
      squadsVersion: 'v4',
      accountOwner: owner,
      isVaultPDA: true,
      error: 'Squads V4 account but could not decode or find parent multisig',
    };
  }
}

function formatV4Config(ms: any) {
  return {
    threshold: ms.threshold,
    memberCount: ms.members.length,
    members: ms.members.map((m: any) => ({
      key: m.key.toBase58(),
      permissions: m.permissions.mask,
      permissionsReadable: decodePermissionsV4(m.permissions.mask),
    })),
    timeLock: ms.timeLock,
    timeLockHours: ms.timeLock / 3600,
    configAuthority: ms.configAuthority?.toBase58() || null,
    createKey: ms.createKey.toBase58(),
  };
}

// ============================================================
// Squads V3 decoding
// ============================================================

async function tryDecodeV3Direct(
  connection: Connection,
  authority: PublicKey,
  owner: string
): Promise<SquadsResult> {
  try {
    const accountInfo = await connection.getAccountInfo(authority);
    if (!accountInfo) throw new Error('Account not found');

    const config = parseV3MultisigData(accountInfo.data);
    return {
      isSquadsMultisig: true,
      squadsVersion: 'v3',
      accountOwner: owner,
      isVaultPDA: false,
      config,
    };
  } catch (e) {
    return {
      isSquadsMultisig: true,
      squadsVersion: 'v3',
      accountOwner: owner,
      isVaultPDA: false,
      error: `Squads V3 account but could not decode: ${(e as Error).message}`,
    };
  }
}

/**
 * Parse Squads V3 (squads-mpl) multisig account data.
 * Layout (from IDL):
 *   8 bytes: Anchor discriminator
 *   2 bytes: threshold (u16 LE)
 *   2 bytes: authorityIndex (u16 LE)
 *   4 bytes: transactionIndex (u32 LE)
 *   4 bytes: msChangeIndex (u32 LE)
 *   1 byte:  bump
 *   32 bytes: createKey
 *   1 byte:  allowExternalExecute (bool)
 *   4 bytes: keys vec length (u32 LE)
 *   N * 32 bytes: member pubkeys
 *
 * V3 has NO timelock - all executions are instant.
 */
function parseV3MultisigData(data: Buffer) {
  // Skip 8-byte Anchor discriminator
  let offset = 8;

  const threshold = data.readUInt16LE(offset); offset += 2;
  const _authorityIndex = data.readUInt16LE(offset); offset += 2;
  const _transactionIndex = data.readUInt32LE(offset); offset += 4;
  const _msChangeIndex = data.readUInt32LE(offset); offset += 4;
  const _bump = data[offset]; offset += 1;
  const createKey = new PublicKey(data.subarray(offset, offset + 32)); offset += 32;
  const _allowExternalExecute = data[offset]; offset += 1;

  // Members vec
  const memberCount = data.readUInt32LE(offset); offset += 4;
  const members = [];
  for (let i = 0; i < memberCount; i++) {
    const key = new PublicKey(data.subarray(offset, offset + 32));
    offset += 32;
    members.push({
      key: key.toBase58(),
      permissions: 7, // V3: all members have full permissions (no role separation)
      permissionsReadable: ['Initiate', 'Vote', 'Execute'],
    });
  }

  return {
    threshold,
    memberCount,
    members,
    timeLock: 0,        // V3 has no timelock feature
    timeLockHours: 0,
    configAuthority: null,
    createKey: createKey.toBase58(),
  };
}

// ============================================================
// V4 Vault PDA reverse lookup (with rate limiting)
// ============================================================

const REVERSE_LOOKUP_DELAY = 1500; // ms between RPC calls inside reverse lookup to avoid burst 429s

async function reverseVaultLookup(
  connection: Connection,
  vaultAddress: string,
  programId: PublicKey,
  version: 'v4' | 'v3'
): Promise<SquadsResult | null> {
  const vaultPubkey = new PublicKey(vaultAddress);

  try {
    const signatures = await withRetry(
      () => connection.getSignaturesForAddress(vaultPubkey, { limit: 20 }),
      `getSignatures(${vaultAddress.slice(0, 8)}...)`
    );
    if (signatures.length === 0) return null;

    await sleep(REVERSE_LOOKUP_DELAY);

    // Check earliest and most recent txs
    const txsToCheck = [
      signatures[signatures.length - 1],
      signatures[0],
    ];

    for (const sig of txsToCheck) {
      const tx = await withRetry(
        () => connection.getParsedTransaction(sig.signature, {
          maxSupportedTransactionVersion: 0,
        }),
        `getParsedTx(${sig.signature.slice(0, 8)}...)`
      );
      if (!tx?.transaction?.message) continue;

      await sleep(REVERSE_LOOKUP_DELAY);

      // === Approach 1: Instruction-level parsing (no extra RPC calls) ===
      // When Squads V3/V4 is invoked, the multisig account is typically
      // the first or second account in the instruction. Parse instructions
      // to find which accounts are passed to the Squads program.
      const programIdStr = programId.toBase58();
      const instructions = tx.transaction.message.instructions ?? [];
      const innerInstructions = tx.meta?.innerInstructions ?? [];

      // Check both outer and inner instructions for Squads program invocations
      const allInstructions: Array<{ programId: string; accounts: string[] }> = [];

      for (const ix of instructions) {
        const ixProgram = (ix as any).programId?.toBase58?.() ?? (ix as any).programId ?? '';
        const ixAccounts = ((ix as any).accounts ?? []).map((a: any) =>
          typeof a === 'string' ? a : a?.toBase58?.() ?? String(a)
        );
        allInstructions.push({ programId: ixProgram, accounts: ixAccounts });
      }

      for (const inner of innerInstructions) {
        for (const ix of inner.instructions ?? []) {
          const ixProgram = (ix as any).programId?.toBase58?.() ?? (ix as any).programId ?? '';
          const ixAccounts = ((ix as any).accounts ?? []).map((a: any) =>
            typeof a === 'string' ? a : a?.toBase58?.() ?? String(a)
          );
          allInstructions.push({ programId: ixProgram, accounts: ixAccounts });
        }
      }

      // Find instructions that invoke the target Squads program
      for (const ix of allInstructions) {
        if (ix.programId !== programIdStr) continue;
        if (ix.accounts.length === 0) continue;

        // In Squads V3/V4, the multisig account is typically the first account
        // Try the first few accounts as potential multisig candidates
        for (const candidateAddr of ix.accounts.slice(0, 3)) {
          if (candidateAddr === vaultAddress) continue;

          // Verify vault PDA derivation (pure math, no RPC)
          const match = verifyVaultDerivation(vaultPubkey, candidateAddr, programId, version);
          if (!match) continue;

          // Confirmed match - fetch and decode the multisig
          await sleep(REVERSE_LOOKUP_DELAY);
          const msInfo = await withRetry(
            () => connection.getAccountInfo(new PublicKey(candidateAddr)),
            `getAccountInfo(multisig ${candidateAddr.slice(0, 8)}...)`
          );
          if (msInfo?.owner.equals(programId)) {
            return await decodeParentMultisig(connection, candidateAddr, version, msInfo);
          }
        }
      }

      // === Approach 2: Top-level accountKeys with owner check (fewer calls) ===
      // Only check accounts that we haven't already checked via instructions
      const checkedAddrs = new Set(allInstructions.flatMap((ix) => ix.accounts));

      const candidates: string[] = [];
      for (const key of tx.transaction.message.accountKeys) {
        const addr = typeof key === 'string'
          ? key
          : (key as any).pubkey?.toBase58?.() ?? String(key);
        if (addr === vaultAddress || checkedAddrs.has(addr)) continue;
        candidates.push(addr);
      }

      for (const addr of candidates) {
        let info;
        try {
          info = await connection.getAccountInfo(new PublicKey(addr));
        } catch { continue; }

        await sleep(REVERSE_LOOKUP_DELAY);

        if (!info?.owner.equals(programId)) continue;

        const match = verifyVaultDerivation(vaultPubkey, addr, programId, version);
        if (!match) continue;

        return await decodeParentMultisig(connection, addr, version, info);
      }

      // === Approach 3 (V3 only): createKey-based derivation ===
      if (version === 'v3') {
        const allAddrs = [...checkedAddrs, ...candidates];
        for (const candidateCreateKey of allAddrs) {
          try {
            const createKeyPubkey = new PublicKey(candidateCreateKey);
            const [derivedMultisig] = PublicKey.findProgramAddressSync(
              [
                Buffer.from('squad'),
                createKeyPubkey.toBuffer(),
                Buffer.from('multisig'),
              ],
              programId
            );

            if (verifyVaultDerivation(vaultPubkey, derivedMultisig.toBase58(), programId, 'v3')) {
              await sleep(REVERSE_LOOKUP_DELAY);
              const msInfo = await connection.getAccountInfo(derivedMultisig);
              if (msInfo?.owner.equals(programId)) {
                return await decodeParentMultisig(
                  connection, derivedMultisig.toBase58(), 'v3', msInfo
                );
              }
            }
          } catch { /* skip */ }
        }
      }
    }
  } catch {
    // Fall through
  }

  return null;
}

/**
 * V3-specific vault reverse lookup.
 */
async function reverseVaultLookupV3(
  connection: Connection,
  vaultAddress: string
): Promise<SquadsResult | null> {
  return reverseVaultLookup(connection, vaultAddress, SQUADS_V3_PROGRAM, 'v3');
}

/**
 * Decode a confirmed parent multisig account (V4 or V3).
 */
async function decodeParentMultisig(
  connection: Connection,
  addr: string,
  version: 'v4' | 'v3',
  accountInfo: { data: Buffer } | null
): Promise<SquadsResult | null> {
  if (version === 'v4') {
    try {
      const ms = await multisig.accounts.Multisig.fromAccountAddress(
        connection, new PublicKey(addr)
      );
      return {
        isSquadsMultisig: true,
        squadsVersion: 'v4',
        accountOwner: '11111111111111111111111111111111',
        isVaultPDA: true,
        parentMultisig: addr,
        config: formatV4Config(ms),
      };
    } catch { return null; }
  } else {
    try {
      if (accountInfo) {
        return {
          isSquadsMultisig: true,
          squadsVersion: 'v3',
          accountOwner: '11111111111111111111111111111111',
          isVaultPDA: true,
          parentMultisig: addr,
          config: parseV3MultisigData(accountInfo.data),
        };
      }
    } catch { /* fall through */ }
  }
  return null;
}

// ============================================================
// Vault PDA derivation verification (expanded range)
// ============================================================

function verifyVaultDerivation(
  vaultPubkey: PublicKey,
  multisigAddr: string,
  programId: PublicKey,
  version: 'v4' | 'v3'
): boolean {
  const multisigPubkey = new PublicKey(multisigAddr);

  if (version === 'v4') {
    // V4 seeds: ["multisig", multisig_key, "vault", index_u8]
    // Check indices 0-10
    for (let i = 0; i < 11; i++) {
      const indexBuffer = Buffer.alloc(1);
      indexBuffer.writeUInt8(i);
      try {
        const [derived] = PublicKey.findProgramAddressSync(
          [
            Buffer.from('multisig'),
            multisigPubkey.toBuffer(),
            Buffer.from('vault'),
            indexBuffer,
          ],
          programId
        );
        if (derived.equals(vaultPubkey)) return true;
      } catch { /* invalid seed combo, skip */ }
    }
  } else {
    // V3 vault seeds: ["squad", multisig_key, "vault", vault_index_le_u32]
    // Also try legacy "authority" seed pattern
    // Check indices 0-10 for both patterns
    for (const seedWord of ['vault', 'authority']) {
      for (let i = 0; i < 11; i++) {
        const indexBuffer = Buffer.alloc(4);
        indexBuffer.writeUInt32LE(i);
        try {
          const [derived] = PublicKey.findProgramAddressSync(
            [
              Buffer.from('squad'),
              multisigPubkey.toBuffer(),
              Buffer.from(seedWord),
              indexBuffer,
            ],
            programId
          );
          if (derived.equals(vaultPubkey)) return true;
        } catch { /* skip */ }
      }
    }
  }

  return false;
}

// ============================================================
// Helpers
// ============================================================

function decodePermissionsV4(mask: number): string[] {
  const perms: string[] = [];
  if (mask & 1) perms.push('Initiate');
  if (mask & 2) perms.push('Vote');
  if (mask & 4) perms.push('Execute');
  return perms;
}
