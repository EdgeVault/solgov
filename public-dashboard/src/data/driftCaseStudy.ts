export interface AffectedProtocol {
  name: string;
  loss: string;
  chainDepth: number;
  source: string;
}

export const DRIFT_CASE_STUDY = {
  date: '2026-04-01',
  totalStolen: '$285M',
  protocolsAffected: 22,
  quantifiedLosses: '$37.1M',
  warningDays: 7,

  affected: [
    { name: 'Prime Numbers Fi', loss: '>$10M', chainDepth: 1, source: 'tronweekly.com' },
    { name: 'Carrot', loss: '$8.4M', chainDepth: 1, source: 'nftevening.com' },
    { name: 'Gauntlet', loss: '$6.4M', chainDepth: 1, source: 'coinpedia.org' },
    { name: 'Neutral Trade', loss: '$3.67M', chainDepth: 1, source: 'coingabbar.com' },
    { name: 'Elemental DeFi', loss: '$2.9M', chainDepth: 1, source: 'coingabbar.com' },
    { name: 'Reflect Money', loss: '$1.95M', chainDepth: 1, source: 'coingabbar.com' },
    { name: 'Vectis', loss: '$1.69M', chainDepth: 1, source: 'coingabbar.com' },
    { name: 'Ranger Finance', loss: '$919K', chainDepth: 1, source: 'phemex.com' },
    { name: 'Pyra', loss: '$551K', chainDepth: 1, source: 'x.com/GetPyra' },
    { name: 'Titan', loss: '~$435K', chainDepth: 1, source: 'on-chain proposal decode' },
    { name: 'Loopscale', loss: '~$170K', chainDepth: 3, source: 'phemex.com' },
    { name: 'PiggyBank', loss: '$106K', chainDepth: 1, source: 'bsc.news' },
    { name: 'Lulo', loss: 'Undisclosed', chainDepth: 1, source: 'phemex.com' },
    { name: 'Fuse Wallet', loss: 'Undisclosed', chainDepth: 2, source: 'phemex.com' },
    { name: 'Exponent', loss: 'Undisclosed', chainDepth: 1, source: 'coinpedia.org' },
    { name: 'Asgard Finance', loss: 'Undisclosed', chainDepth: 1, source: 'phemex.com' },
    { name: 'xPlace', loss: 'Undisclosed', chainDepth: 1, source: 'phemex.com' },
    { name: 'Project 0', loss: 'Undisclosed', chainDepth: 1, source: 'phemex.com' },
    { name: 'Perena', loss: 'Undisclosed', chainDepth: 1, source: 'coinpedia.org' },
    { name: 'DiversiFi', loss: 'Undisclosed', chainDepth: 1, source: 'counterparty-risk report' },
    { name: 'Valeo', loss: 'Undisclosed', chainDepth: 1, source: 'coinpedia.org' },
    { name: 'Amp Pay', loss: 'Undisclosed', chainDepth: 1, source: 'coinpedia.org' },
  ] as AffectedProtocol[],
};
