// Location of the dashboard's protocols.ts for scanners that parse it as text. In the repository it
// sits beside sentinel/; the VPS has no dashboard checkout, so a copy is kept at data/protocols.ts
// there and updated whenever the dashboard is deployed.

import * as fs from 'fs';
import * as path from 'path';

const DASHBOARD_COPY = path.join(__dirname, '..', '..', '..', 'public-dashboard', 'src', 'data', 'protocols.ts');
const DATA_COPY = path.join(__dirname, '..', '..', 'data', 'protocols.ts');

export function protocolsSourcePath(): string {
  return fs.existsSync(DASHBOARD_COPY) ? DASHBOARD_COPY : DATA_COPY;
}
