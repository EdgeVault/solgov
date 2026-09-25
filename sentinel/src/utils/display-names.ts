// Names for protocols that rebranded. The internal name (state keys, subscriber matching, API keys)
// stays the same so partner integrations keep working; alert text shows the current name, and a query
// or subscription using the current name resolves to the internal one. Mirrors
// public-dashboard/src/data/displayNames.ts.

const DISPLAY: Record<string, string> = {
  Drift: 'Velocity (formerly Drift)',
};

// Normalised (lowercase alphanumeric) current names mapped to the normalised internal name.
export const REBRAND_ALIASES: Record<string, string> = {
  velocity: 'drift',
  velocitydex: 'drift',
  velocityexchange: 'drift',
};

// "Drift (interim recovery)" becomes "Velocity (formerly Drift), interim recovery".
export function alertName(name: string): string {
  if (DISPLAY[name]) return DISPLAY[name];
  const m = /^(.*?)\s*\((.*)\)$/.exec(name);
  if (m && DISPLAY[m[1]]) return `${DISPLAY[m[1]]}, ${m[2]}`;
  return name;
}

// Lowercased name with a rebrand alias replaced by the internal name ("Velocity" -> "drift").
export function canonicalLower(name: string): string {
  const lower = String(name || '').toLowerCase().trim();
  return REBRAND_ALIASES[lower.replace(/[^a-z0-9]/g, '')] ?? lower;
}
