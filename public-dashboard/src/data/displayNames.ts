// User-facing display-name overrides. The internal key (used for every data join:
// live monitor-state lookups, DefiLlama TVL slugs, GOV_PROFILES, exposure and
// relationship cross-references, logo files, and the sentinel backend) stays
// stable. Only the rendered label changes.
//
// Drift Protocol rebranded to Velocity DEX (announced July 2026). The live entry
// shows "Velocity (formerly Drift)"; the historical exploit, case study, and dated
// activity keep the "Drift" label because that was the name at the time.
export const DISPLAY_NAMES: Record<string, string> = {
  Drift: 'Velocity (formerly Drift)',
};

export function displayName(name: string): string {
  return DISPLAY_NAMES[name] ?? name;
}
