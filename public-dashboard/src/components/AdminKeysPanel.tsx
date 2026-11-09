// Protocol admin keys (Admin Watch): the admin keys held inside each protocol's own settings account,
// who holds each one now, and the last change seen. Data: _adminWatch from the live API, written by
// the listener at start-up and on every change.

import type { AdminWatch, AdminWatchField, AdminHolder } from '../hooks/useLiveData';

const fmtDate = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso.slice(0, 10) : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
};
const short = (a: string) => `${a.slice(0, 4)}...${a.slice(-4)}`;
const solscan = (a: string) => `https://solscan.io/account/${a}`;

function tl(sec: number): string {
  if (!sec) return 'no timelock';
  const h = sec / 3600;
  return h >= 1 ? `${Math.round(h)}h timelock` : `${Math.round(sec / 60)}min timelock`;
}

// "Kamino Lend main market owner (the key that controls the market's settings)" -> title + note
function splitLabel(label: string): { title: string; note: string | null } {
  const i = label.indexOf(' (');
  if (!(i > 0 && label.endsWith(')'))) return { title: label, note: null };
  const note = label.slice(i + 2, -1);
  return { title: label.slice(0, i), note: note.charAt(0).toUpperCase() + note.slice(1) };
}

function Holder({ h, value }: { h: AdminHolder | null; value: string }) {
  if (!h) return <span className="text-gray-400">None set</span>;
  if (h.kind === 'immutable') return <span className="text-gray-300">Nobody (it can no longer be changed)</span>;
  if (h.kind === 'dao-treasury') {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="rounded border border-white/[0.12] bg-white/[0.04] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-gray-300">DAO</span>
          <a href={solscan(h.realm)} target="_blank" rel="noopener" className="text-gray-100 hover:underline decoration-gray-600">{h.realmName}</a>
        </div>
        <div className="text-[11px] text-gray-400">Governance treasury. Acts only through a proposal voted on in this DAO</div>
      </div>
    );
  }
  if (h.kind === 'multisig-vault') {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="rounded border border-white/[0.12] bg-white/[0.04] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-gray-300">Multisig</span>
          <a href={solscan(h.address)} target="_blank" rel="noopener" className="text-gray-100 hover:underline decoration-gray-600">{h.multisigName}</a>
        </div>
        <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-[11px] text-gray-400 tabular-nums">
          <span><span className="text-white font-medium">{h.threshold}</span> of {h.memberCount} signers</span>
          <span className="text-gray-700">&middot;</span>
          <span>{tl(h.timeLock)}</span>
          {h.configAuthority !== 'autonomous' && (<><span className="text-gray-700">&middot;</span><span>external admin key set</span></>)}
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-0.5">
      <a href={solscan(value)} target="_blank" rel="noopener" className="font-mono text-[11px] text-gray-200 hover:underline decoration-gray-600">{short(value)}</a>
      {h.scope !== 'unchecked' && <span className="text-[11px] text-gray-500">Not linked to a multisig solgov tracks</span>}
    </div>
  );
}

function KeyRow({ f }: { f: AdminWatchField }) {
  const { title, note } = splitLabel(f.label);
  return (
    <div className="rounded-md bg-white/[0.02] border border-white/[0.04] p-3">
      <div className="text-[12px] text-white font-medium">{title}</div>
      {note && <div className="text-[11px] text-gray-500 mt-0.5">{note}</div>}
      <div className="mt-2 text-[12px]">
        <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1">Held by</div>
        <Holder h={f.holder} value={f.value} />
      </div>
      <div className="mt-2 text-[11px] text-gray-500">
        {f.lastChange ? <>Changed {fmtDate(f.lastChange.at)}: <span className="text-gray-300">{f.lastChange.detail}</span></> : 'No change seen since watching began'}
      </div>
    </div>
  );
}

export function AdminKeysPanel({ data }: { data: AdminWatch }) {
  const since = data.targets.flatMap(t => t.fields.map(f => f.watchingSince)).filter(Boolean).sort()[0];
  return (
    <section className="mt-6 rounded-lg border border-white/[0.06] bg-white/[0.02] p-4 md:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-1">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-white">Protocol admin keys</h3>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-white/[0.08] px-2 py-0.5 text-[10px] uppercase tracking-wide text-gray-300">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />Live
          </span>
        </div>
        {since && <span className="text-[11px] text-gray-500">Watching since {fmtDate(since)}</span>}
      </div>
      <p className="text-[12px] text-gray-500 max-w-3xl leading-relaxed mb-4">
        These keys sit inside each protocol's own settings account, separate from the key that can upgrade the program. solgov reads them on-chain and sends an alert when one changes, describing who holds the new key. A proposed handover is flagged before it takes effect.
      </p>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 items-start">
        {data.targets.map(t => {
          const active = t.fields.filter(f => f.kind === 'active');
          const pending = t.fields.filter(f => f.kind === 'pending');
          return (
            <div key={t.account} className="rounded-lg border border-white/[0.06] bg-black/20 p-3 flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[13px] font-semibold text-white">{t.protocol}</span>
                <a href={solscan(t.account)} target="_blank" rel="noopener" className="text-[11px] text-gray-500 hover:text-gray-300 underline decoration-gray-700">Settings account</a>
              </div>
              {active.map(f => <KeyRow key={f.name} f={f} />)}
              {pending.map(f => (
                <div key={f.name} className={`rounded-md px-3 py-2 text-[11px] border ${f.handoverProposed ? 'border-amber-400/30 bg-amber-400/[0.06] text-amber-200' : 'border-white/[0.04] text-gray-500'}`}>
                  {f.handoverProposed ? <>Handover proposed to <span className="text-amber-100">{f.holderText}</span>. It takes effect only once the new key claims it.</> : 'Handover: none pending'}
                </div>
              ))}
            </div>
          );
        })}
      </div>
      <p className="mt-3 text-[10px] text-gray-600">Source: each protocol's on-chain settings account, read live. Holder details are read from the multisig or DAO governance account at the same time.</p>
    </section>
  );
}
