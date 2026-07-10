// DAO governance watch. Realms DAOs use token-weighted voting, a different model
// from Squads multisigs, so they get their own tab and feed. Facts only, no scores.
// Data is API-driven (served in /api/state). Structure mirrors the GovWatch table.

import { ProtocolLogo } from '../App';
import { Tooltip, InfoIcon } from './Tooltip';
import type { DaoProfile, ActivityEvent } from '../hooks/useLiveData';

const fmtUsd = (n: number): string =>
  n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}K` : n > 0 ? `$${Math.round(n)}` : 'unpriced';

const fmtNum = (n: number): string =>
  n <= 0 ? '-' : n >= 1e12 ? `${(n / 1e12).toFixed(1)}T` : n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(0)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}K` : `${Math.round(n)}`;

const fmtDur = (h: number): string => h <= 0 ? '-' : h >= 24 ? `${Math.round(h / 24)}d` : `${Math.round(h)}h`;

const eventLabel = (type: string): string =>
  type === 'ProposalCreated' ? 'Proposal created'
    : type === 'TreasuryProposal' ? 'Proposal moves treasury'
    : type === 'VoteConcentration' ? 'Vote concentration'
    : type === 'ConfigChange' ? 'Config change'
    : type;

const typeColor = (type: string): string =>
  type === 'VoteConcentration' || type === 'TreasuryProposal' ? 'text-orange-400'
    : type === 'ConfigChange' ? 'text-gray-300'
    : 'text-gray-400';

const TH = 'px-3 py-2.5 text-center text-[11px] font-medium text-gray-400 uppercase tracking-wide whitespace-nowrap';
const TD = 'px-3 py-2 text-xs text-center text-gray-300 whitespace-nowrap';

export function DaoRiskTab({ daos, activity }: { daos: DaoProfile[]; activity: ActivityEvent[] }) {
  const rows = daos || [];
  const feed = [...(activity || [])].sort((a, b) => (b.timestamp || b.date).localeCompare(a.timestamp || a.date));

  return (
    <>
      <div className="mb-6">
        <h2 className="text-lg font-semibold text-white mb-1">DAO Governance</h2>
        <p className="text-xs text-gray-500">Token-weighted Realms DAOs. On-chain verified. A different governance model from Squads multisigs.</p>
      </div>

      <div className="overflow-auto max-h-[80vh] border border-white/[0.06] rounded-md scroll-thin">
        <table className="w-full text-sm">
          <thead className="bg-[#0e0e14] sticky top-0 z-20">
            <tr>
              <th className="px-3 py-2.5 text-left text-[11px] font-medium text-gray-400 uppercase tracking-wide whitespace-nowrap">DAO</th>
              <th className={TH}>Quorum <Tooltip text="Share of the governing token that must vote yes for a proposal to pass."><InfoIcon /></Tooltip></th>
              <th className={TH}>Timelock <Tooltip text="Delay between a proposal passing and executing. None means it executes immediately."><InfoIcon /></Tooltip></th>
              <th className={TH}>Voting <Tooltip text="How long voting stays open on a proposal."><InfoIcon /></Tooltip></th>
              <th className={TH}>Threshold <Tooltip text="Minimum governing-token weight a wallet needs to create a proposal."><InfoIcon /></Tooltip></th>
              <th className={TH}>Cost to Seize <Tooltip text="Capital needed to reach quorum: quorum share of the governing token's market cap."><InfoIcon /></Tooltip></th>
              <th className={TH}>Vote Reach <Tooltip text="Value a passed proposal can move directly, held in the governance's own accounts. None or low typically means the treasury is held in a separate multisig or wallet, out of a governance vote's reach."><InfoIcon /></Tooltip></th>
              <th className={TH}>Token Cap <Tooltip text="Market cap of the governing token (supply times price)."><InfoIcon /></Tooltip></th>
              <th className={TH}>Voter Model <Tooltip text="Direct means one token one vote. Plugin means a voter-weight addin is set, which may reweight or lock votes."><InfoIcon /></Tooltip></th>
              <th className={TH}>Proposals <Tooltip text="Proposals currently in voting / total proposals."><InfoIcon /></Tooltip></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => (
              <tr key={d.realm} className="border-t border-white/[0.04] hover:bg-white/[0.02]">
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <ProtocolLogo name={d.name} />
                    <a href={`https://app.realms.today/dao/${d.realm}`} target="_blank" rel="noopener noreferrer" className="font-medium text-white whitespace-nowrap hover:underline">{d.name}</a>
                  </div>
                </td>
                <td className={TD}>{d.quorumLabel}</td>
                <td className={`${TD} text-gray-400`}>{d.timelockHours === 0 ? 'none' : fmtDur(d.timelockHours)}</td>
                <td className={`${TD} text-gray-400`}>{fmtDur(d.votingPeriodHours)}</td>
                <td className={`${TD} text-gray-400`}>{fmtNum(d.proposalThresholdTokens)}</td>
                <td className={TD}>{d.costToSeizeUsd > 0 ? fmtUsd(d.costToSeizeUsd) : <span className="text-gray-500">unpriced</span>}</td>
                <td className={TD}>{d.governanceHeldUsd >= 100 ? fmtUsd(d.governanceHeldUsd) : <span className="text-gray-500">none exposed</span>}</td>
                <td className={`${TD} text-gray-400`}>{d.tokenMcapUsd > 0 ? fmtUsd(d.tokenMcapUsd) : <span className="text-gray-500">unpriced</span>}</td>
                <td className={`${TD} text-gray-400`}>{d.voterWeightPlugin ? 'plugin' : 'direct'}</td>
                <td className={`${TD} text-gray-400`}>{d.liveProposals} live / {d.totalProposals}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={10} className="px-3 py-6 text-center text-gray-500 text-xs">No DAO data yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-6">
        <h3 className="text-sm font-semibold text-white mb-3">DAO Activity</h3>
        <div className="space-y-1 max-h-96 overflow-y-auto">
          {feed.slice(0, 200).map((e, i) => (
            <div key={i} className="text-xs border-b border-white/[0.03]">
              {/* Mobile: label + detail merged into one column (leave this alone). */}
              <div className="flex md:hidden items-center gap-3 py-1.5">
                <span className="text-gray-500 font-mono w-20 flex-shrink-0">{e.date}</span>
                <span className="text-white font-medium w-36 flex-shrink-0 truncate">{e.protocol}</span>
                <span className="min-w-0">
                  <span className={typeColor(e.type)}>{eventLabel(e.type)}</span>
                  {e.detail && e.detail !== e.type && <span className="text-gray-500"> {e.detail}</span>}
                </span>
              </div>
              {/* Desktop: 4 separate columns, name sized to the longest DAO name. */}
              <div className="hidden md:flex items-center gap-3 py-1.5">
                <span className="text-gray-500 font-mono w-20 flex-shrink-0">{e.date}</span>
                <span className="text-white font-medium w-24 flex-shrink-0 truncate">{e.protocol}</span>
                <span className={`${typeColor(e.type)} w-44 flex-shrink-0 truncate`}>{eventLabel(e.type)}</span>
                {e.detail && e.detail !== e.type && <span className="text-gray-500 min-w-0 truncate">{e.detail}</span>}
              </div>
            </div>
          ))}
          {feed.length === 0 && (
            <p className="text-gray-500 text-center py-4">No DAO activity recorded</p>
          )}
        </div>
      </div>

      <div className="mt-8 pt-5 border-t border-white/[0.04] text-[11px] text-gray-500 space-y-1">
        <p>Vote reach is the governance-attack blast radius, the value a passed proposal can move directly. A DAO showing none exposed has little a vote can drain, its treasury sits behind a separate multisig or wallet. Realms coverage is a starting set and expanding.</p>
      </div>
    </>
  );
}
