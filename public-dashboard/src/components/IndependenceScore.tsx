// Per-team signer-independence score: how distinct each team's multisig signer sets are from one another.

import scores from '../data/independence-scores.json';

type Overlap = { a: string; b: string; shared: number; sharedPctOfMinSet: number };
type Group = {
  team: string;
  context: 'live' | 'case-study';
  note?: string;
  multisigs: { label: string; address: string | null; memberCount: number }[];
  independenceScore: number;
  independencePct: number;
  totalSignerPositions: number;
  uniqueSigners: number;
  pairwiseOverlap: Overlap[];
};

const groups: Group[] = (scores as any).groups;

function scoreColour(_pct: number): string {
  return 'text-white border-white/[0.12] bg-white/[0.04]';
}

function ScoreBadge({ pct, context }: { pct: number; context: 'live' | 'case-study' }) {
  const c = scoreColour(pct);
  const label = pct >= 80 ? 'Strong separation' : pct >= 40 ? 'Partial separation' : 'No separation';
  return (
    <div className={`inline-flex items-baseline gap-2 rounded-lg border px-3 py-2 ${c}`}>
      <span className="text-2xl font-semibold leading-none">{pct}%</span>
      <span className="text-[10px] uppercase tracking-wide opacity-75">
        {label}{context === 'case-study' ? ' (pre-exploit)' : ''}
      </span>
    </div>
  );
}

export function IndependenceScorePanel({ group }: { group: Group }) {
  return (
    <div className="mt-4 rounded-lg border border-white/[0.06] bg-white/[0.02] p-4">
      <div className="flex items-start justify-between mb-3 gap-3">
        <div>
          <h4 className="text-xs font-semibold text-white">Signer Independence: {group.team}</h4>
          <p className="text-[11px] text-gray-500 mt-1">
            How distinct are the signer sets across this team's multisigs? 100% means no signer sits on more than one multisig. 0% means the same people staff every seat.
          </p>
        </div>
        <ScoreBadge pct={group.independencePct} context={group.context} />
      </div>

      {group.note && (
        <p className="text-[11px] text-gray-400 italic mb-3">{group.note}</p>
      )}

      <div className="grid grid-cols-3 gap-2 text-[11px] mb-3">
        <div className="bg-white/[0.03] rounded p-2">
          <p className="text-gray-500">Multisigs</p>
          <p className="text-gray-200">{group.multisigs.length}</p>
        </div>
        <div className="bg-white/[0.03] rounded p-2">
          <p className="text-gray-500">Total signer positions</p>
          <p className="text-gray-200">{group.totalSignerPositions}</p>
        </div>
        <div className="bg-white/[0.03] rounded p-2">
          <p className="text-gray-500">Unique signers</p>
          <p className="text-gray-200">{group.uniqueSigners}</p>
        </div>
      </div>

      <div className="space-y-1 mb-3">
        {group.multisigs.map((m, i) => (
          <div key={i} className="flex items-center justify-between py-1 px-2 bg-white/[0.02] rounded text-[11px]">
            <span className="text-gray-300">{m.label}</span>
            <span className="text-gray-500">{m.memberCount} signer{m.memberCount === 1 ? '' : 's'}</span>
          </div>
        ))}
      </div>

      {group.pairwiseOverlap.length > 0 && (
        <div>
          <p className="text-[10px] uppercase tracking-wide text-gray-500 mb-1">Pairwise overlap</p>
          <div className="space-y-1">
            {group.pairwiseOverlap.map((p, i) => (
              <div key={i} className="flex items-center justify-between py-1 px-2 bg-white/[0.01] rounded text-[11px]">
                <span className="text-gray-400 truncate">{p.a} × {p.b}</span>
                <span className={'text-white'}>
                  {p.shared} shared ({p.sharedPctOfMinSet}%)
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function findLiveGroupForProtocol(protocolName: string): Group | null {
  for (const g of groups) {
    if (g.context !== 'live') continue;
    if (g.multisigs.some(m => m.label === protocolName)) return g;
  }
  return null;
}

export function findCaseStudyGroup(teamPrefix: string): Group | null {
  for (const g of groups) {
    if (g.context !== 'case-study') continue;
    if (g.team.toLowerCase().startsWith(teamPrefix.toLowerCase())) return g;
  }
  return null;
}

export function IndependenceScoreSummary({ onJumpTo }: { onJumpTo?: (protocol: string) => void }) {
  const liveGroups = groups.filter(g => g.context === 'live');
  const caseStudies = groups.filter(g => g.context === 'case-study');

  return (
    <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-4 mb-4">
      <div className="flex items-start justify-between mb-2 gap-3">
        <div>
          <h3 className="text-sm font-semibold text-white">Signer Independence</h3>
          <p className="text-[11px] text-gray-500 mt-0.5">
            For teams running multiple multisigs, how distinct are the signer sets. 100% = no signer sits on more than one multisig. 0% = the same people staff every seat. Drift's pre-exploit 0% was one of the structural conditions that let two key compromises reach two products.
          </p>
        </div>
      </div>

      {liveGroups.length === 0 ? (
        <p className="text-[11px] text-gray-500">No teams currently tracked with multiple multisigs.</p>
      ) : (
        <div className="space-y-1 mb-3">
          {liveGroups.map((g, i) => {
            const pct = g.independencePct;
            const colour = 'text-white';
            const firstProtocol = g.multisigs[0]?.label;
            return (
              <button
                key={i}
                onClick={() => firstProtocol && onJumpTo?.(firstProtocol)}
                className="w-full text-left py-2 px-3 bg-white/[0.02] hover:bg-white/[0.04] rounded flex items-center justify-between transition-colors"
              >
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-white font-medium">{g.team}</div>
                  <div className="text-[10px] text-gray-500 mt-0.5">
                    {g.multisigs.map(m => m.label).join(', ')} · {g.uniqueSigners} unique signers across {g.totalSignerPositions} seats
                  </div>
                </div>
                <div className={`text-lg font-semibold ml-3 ${colour}`}>{pct}%</div>
              </button>
            );
          })}
        </div>
      )}

      {caseStudies.length > 0 && (
        <div className="mt-3 pt-3 border-t border-white/[0.04]">
          <p className="text-[10px] uppercase tracking-wide text-gray-500 mb-1">Historical reference</p>
          {caseStudies.map((g, i) => {
            const pct = g.independencePct;
            const colour = 'text-white';
            return (
              <div key={i} className="py-1.5 px-3 bg-white/[0.01] rounded flex items-center justify-between">
                <div className="flex-1 min-w-0">
                  <div className="text-[11px] text-gray-300">{g.team}</div>
                  {g.note && <div className="text-[10px] text-gray-600 mt-0.5 italic">{g.note}</div>}
                </div>
                <div className={`text-sm font-semibold ml-3 ${colour}`}>{pct}%</div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
