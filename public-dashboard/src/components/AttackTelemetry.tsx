import { useMemo } from 'react';

type Classification =
  | 'legitimate'
  | 'probe:deleted-opcode'
  | 'probe:failed'
  | 'unclear';

type ActivityEntry = {
  signature: string;
  blockTime: number | null;
  slot: number;
  feePayer: string;
  instructionTag: number | null;
  instructionName: string;
  err: unknown;
  cu: number | null;
  targetsLiveSlab: boolean;
  classification: Classification;
  logsPreview: string;
  recordedAt: string;
};

const activityModules = import.meta.glob<{ default: ActivityEntry[] }>(
  '../data/percolator-activity.json',
  { eager: true }
);
const activity: ActivityEntry[] = Object.values(activityModules)[0]?.default ?? [];

const PROGRAM_ID = 'BCGNFw6vDinWTF9AybAbi8vr69gx5nk5w8o2vEWgpsiw';
const LIVE_SLAB = '5ZamUkAiXtvYQijNiRcuGaea66TVbbTPusHfwMX1kTqB';
const INSURANCE_SOL_AT_LAUNCH = 5;

function shortSig(sig: string): string {
  if (!sig) return '';
  return sig.slice(0, 8) + '…' + sig.slice(-6);
}

function shortAddr(addr: string): string {
  if (!addr) return '';
  return addr.slice(0, 4) + '…' + addr.slice(-4);
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString('en-GB', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function classificationBadge(c: Classification) {
  const map: Record<Classification, { label: string; cls: string; title: string }> = {
    'legitimate': {
      label: 'legitimate',
      cls: 'border-white/[0.08] bg-white/[0.04] text-gray-300',
      title: 'Successful on-chain call against a live instruction tag.',
    },
    'probe:deleted-opcode': {
      label: 'probe / deleted opcode',
      cls: 'border-orange-300/30 bg-orange-300/[0.06] text-orange-200/80',
      title: 'Call targeted an instruction tag that was removed from the deployed program.',
    },
    'probe:failed': {
      label: 'probe / failed',
      cls: 'border-orange-300/30 bg-orange-300/[0.06] text-orange-200/80',
      title: 'Failed tx with anomalous compute, multiple signers, or unusual account layout.',
    },
    'unclear': {
      label: 'unclear',
      cls: 'border-white/[0.08] bg-white/[0.04] text-gray-400',
      title: 'Failed tx that looks like routine user error. Not classified as a probe.',
    },
  };
  const entry = map[c];
  return (
    <span
      className={`text-[9px] px-1.5 py-0.5 rounded border uppercase tracking-wider whitespace-nowrap ${entry.cls}`}
      title={entry.title}
    >
      {entry.label}
    </span>
  );
}

type TagRow = {
  tagName: string;
  count: number;
  probeCount: number;
  lastSeen: string;
};

function buildTagBreakdown(entries: ActivityEntry[]): TagRow[] {
  const map = new Map<string, TagRow>();
  for (const e of entries) {
    const key = e.instructionName || 'Unknown';
    let row = map.get(key);
    if (!row) {
      row = { tagName: key, count: 0, probeCount: 0, lastSeen: e.recordedAt };
      map.set(key, row);
    }
    row.count++;
    if (e.classification === 'probe:deleted-opcode' || e.classification === 'probe:failed') {
      row.probeCount++;
    }
    if (e.recordedAt > row.lastSeen) row.lastSeen = e.recordedAt;
  }
  return Array.from(map.values()).sort((a, b) => b.count - a.count);
}

export default function AttackTelemetry() {
  const sorted = useMemo(() => {
    const copy = activity.slice();
    copy.sort((a, b) => (a.recordedAt < b.recordedAt ? 1 : -1));
    return copy;
  }, []);

  const total = sorted.length;
  const probeCount = useMemo(
    () => sorted.filter(e => e.classification.startsWith('probe')).length,
    [sorted]
  );
  const tagRows = useMemo(() => buildTagBreakdown(sorted), [sorted]);
  const recent = sorted.slice(0, 20);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-white mb-1">🧪 Percolator challenge telemetry</h2>
        <p className="text-[11px] text-gray-500 mb-4">
          Toly's Percolator program has had all admin keys burned, with roughly {INSURANCE_SOL_AT_LAUNCH} SOL sat in the insurance vault as a public bug bounty target. This panel logs every transaction that touches the program, decodes the instruction tag, and classifies the call as legitimate, probe, or unclear. Observational only: no claims are made about whether any call has extracted value.
        </p>
        <div className="bg-[#0a0a0f] border border-white/[0.04] rounded-md px-4 py-3 grid grid-cols-2 md:grid-cols-4 gap-3">
          <div>
            <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Transactions observed</div>
            <div className="text-xl font-semibold text-white tabular-nums">{total}</div>
          </div>
          <div>
            <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Probes</div>
            <div className="text-xl font-semibold text-white tabular-nums">{probeCount}</div>
            <div className="text-[10px] text-gray-600">failed + deleted-opcode calls</div>
          </div>
          <div>
            <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Insurance vault</div>
            <div className="text-xl font-semibold text-white tabular-nums">{INSURANCE_SOL_AT_LAUNCH} SOL</div>
            <div className="text-[10px] text-gray-600">balance at launch</div>
          </div>
          <div>
            <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Target slab</div>
            <div className="text-xs font-mono text-gray-300 break-all">{shortAddr(LIVE_SLAB)}</div>
            <div className="text-[10px] text-gray-600">SOL/USD inverted</div>
          </div>
        </div>
      </div>

      <div>
        <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-2">Breakdown by instruction tag</div>
        <div className="bg-[#0a0a0f] border border-white/[0.04] rounded-md overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead className="text-[10px] text-gray-500 uppercase tracking-wider">
                <tr className="border-b border-white/[0.04]">
                  <th className="text-left px-4 py-2.5 font-normal">Instruction</th>
                  <th className="text-right px-4 py-2.5 font-normal">Calls</th>
                  <th className="text-right px-4 py-2.5 font-normal">Probes</th>
                  <th className="text-right px-4 py-2.5 font-normal">Last seen</th>
                </tr>
              </thead>
              <tbody>
                {tagRows.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-4 py-6 text-center text-[11px] text-gray-600">
                      No transactions recorded yet. The listener starts populating this table on the first on-chain call to the program.
                    </td>
                  </tr>
                )}
                {tagRows.map((r, i) => (
                  <tr key={i} className="border-b border-white/[0.04] last:border-b-0">
                    <td className="px-4 py-2.5 text-white font-mono">{r.tagName}</td>
                    <td className="px-4 py-2.5 text-right text-gray-300 tabular-nums">{r.count}</td>
                    <td className="px-4 py-2.5 text-right text-gray-300 tabular-nums">
                      {r.probeCount > 0 ? <span className="text-orange-200/80">{r.probeCount}</span> : '0'}
                    </td>
                    <td className="px-4 py-2.5 text-right text-gray-500 tabular-nums">{formatTime(r.lastSeen)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div>
        <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-2">Recent activity</div>
        <p className="text-[10px] text-gray-600 mb-3">Latest 20 calls, newest first. Signatures link to solana.fm.</p>
        <div className="bg-[#0a0a0f] border border-white/[0.04] rounded-md overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead className="text-[10px] text-gray-500 uppercase tracking-wider">
                <tr className="border-b border-white/[0.04]">
                  <th className="text-left px-4 py-2.5 font-normal">Time</th>
                  <th className="text-left px-4 py-2.5 font-normal">Instruction</th>
                  <th className="text-left px-4 py-2.5 font-normal">Fee payer</th>
                  <th className="text-right px-4 py-2.5 font-normal">CU</th>
                  <th className="text-left px-4 py-2.5 font-normal">Classification</th>
                  <th className="text-left px-4 py-2.5 font-normal">Signature</th>
                </tr>
              </thead>
              <tbody>
                {recent.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-6 text-center text-[11px] text-gray-600">
                      No activity recorded yet.
                    </td>
                  </tr>
                )}
                {recent.map((e, i) => (
                  <tr key={i} className="border-b border-white/[0.04] last:border-b-0">
                    <td className="px-4 py-2.5 text-gray-400 tabular-nums">{formatTime(e.recordedAt)}</td>
                    <td className="px-4 py-2.5 text-white font-mono">
                      {e.instructionName}
                      {e.targetsLiveSlab && (
                        <span
                          className="ml-2 text-[9px] px-1.5 py-0.5 rounded border border-white/[0.08] bg-white/[0.04] text-gray-400 uppercase tracking-wider"
                          title="Transaction references the live SOL/USD slab account."
                        >
                          live slab
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-gray-300 font-mono">{shortAddr(e.feePayer)}</td>
                    <td className="px-4 py-2.5 text-right text-gray-400 tabular-nums">
                      {e.cu !== null ? e.cu.toLocaleString('en-GB') : '-'}
                    </td>
                    <td className="px-4 py-2.5">{classificationBadge(e.classification)}</td>
                    <td className="px-4 py-2.5">
                      <a
                        href={`https://solana.fm/tx/${e.signature}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-gray-300 font-mono hover:text-white underline decoration-white/[0.15] hover:decoration-white/40"
                      >
                        {shortSig(e.signature)}
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div>
        <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Methodology</div>
        <div className="bg-[#0a0a0f] border border-white/[0.04] rounded-md px-4 py-3 space-y-2">
          <p className="text-[11px] text-gray-400">
            Program ID <span className="font-mono text-gray-300">{PROGRAM_ID}</span>. The listener subscribes to program-mention logs over WebSocket, fetches each transaction, reads the first byte of the instruction data as the tag, and writes an entry to the activity file. Classification rules, full schema, and run instructions are documented in the telemetry readme.
          </p>
          <p className="text-[11px] text-gray-400">
            Classifications used here: <span className="font-mono">legitimate</span> (successful call on a live tag), <span className="font-mono">probe:deleted-opcode</span> (tag 11, 12, 15, 16, 22, or 24, none of which exist in the current deployed program), <span className="font-mono">probe:failed</span> (failed tx with anomalous compute, multiple signers, or unusual account layout), and <span className="font-mono">unclear</span> (failed tx that resembles routine user error). Heuristics are deliberately conservative and will be retuned as the dataset grows.
          </p>
          <p className="text-[11px] text-gray-500">
            No claim is made about any specific call having extracted value, or about the security posture of any other protocol. The panel reports on-chain activity against a single immutable program.
          </p>
        </div>
      </div>
    </div>
  );
}
