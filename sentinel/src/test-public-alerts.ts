import 'dotenv/config';

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL = process.env.TELEGRAM_PUBLIC_CHANNEL_ID;

if (!TG_TOKEN || !CHANNEL) {
  console.error('TELEGRAM_BOT_TOKEN and TELEGRAM_PUBLIC_CHANNEL_ID must be set in .env');
  process.exit(1);
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function send(message: string): Promise<void> {
  const resp = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHANNEL,
      text: message,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });
  const data = await resp.json() as any;
  if (!data.ok) {
    console.error('Send failed:', data);
  } else {
    console.log(`  ok message_id=${data.result.message_id}`);
  }
}

const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
const TAG = '<i>[dry-run, delete after review]</i>\n';

const templates: { label: string; body: string }[] = [
  {
    label: 'V4 config change (listener)',
    body:
      `<b>Drift</b>\n` +
      `Threshold: 4 → 3\n` +
      `Signers: 5 → 4\n` +
      `Timelock: 24h → none\n` +
      `Signers:\n  + Acme Hot Wallet (3F4kx2P...nq2t)\n  − 7Yr8s9k...m4Lz\n` +
      `${ts} UTC\nsolgov.xyz`,
  },
  {
    label: 'Stablecoin authority signed (listener)',
    body:
      `<b>USD1 Mint Authority</b>\n` +
      `Authority signed a transaction.\n` +
      `Address: <code>9FJk2nPq...8bYz</code>\n` +
      `${ts} UTC\nsolgov.xyz`,
  },
  {
    label: 'Off-hours authority signed (listener)',
    body:
      `<b>Solstice operations</b>\n` +
      `Authority signed a transaction.\n` +
      `Address: <code>2HnKx5tR...rL9q</code>\n` +
      `${ts} UTC\nsolgov.xyz`,
  },
  {
    label: 'Program upgrade (listener)',
    body:
      `<b>Kamino</b>\n` +
      `Program upgraded.\n` +
      `Program: <code>KLend2g3cP87...</code>\n` +
      `Authority: 6hhBGCtmg7tPWUSgp3LG6X2rsmYWAc4tNsA6G4CnfQbM (Kamino multisig)\n` +
      `${ts} UTC\nsolgov.xyz`,
  },
  {
    label: 'Upgrade authority changed (listener)',
    body:
      `<b>BisonFi</b>\n` +
      `Upgrade authority changed.\n` +
      `Program: <code>BiSoNHVpsVZW...</code>\n` +
      `Authority: 4xPq8Knm...hT2c\n` +
      `${ts} UTC\nsolgov.xyz`,
  },
  {
    label: 'Webhook critical (api)',
    body:
      `<b>Drift</b>\n` +
      `Threshold: 5 → 3\n` +
      `${ts} UTC\nsolgov.xyz`,
  },
  {
    label: 'Webhook high - vault tx (api)',
    body:
      `<b>Jupiter Agg</b>\n` +
      `Vault transaction executed\n` +
      `${ts} UTC\nsolgov.xyz`,
  },
  {
    label: 'Scan summary (monitor)',
    body:
      `<b>solgov scan</b>\n` +
      `2 governance changes\n\n` +
      `<b>Orca</b>\n` +
      `Threshold: 4 → 3\n\n` +
      `<b>Stabble</b>\n` +
      `Signers added: 3 → 4 (+1)\n\n` +
      `<i>${ts}</i>\nsolgov.xyz`,
  },
];

async function main() {
  console.log(`Posting ${templates.length} dry-run alerts to ${CHANNEL}\n`);
  await send(`<b>🧪 solgov public-alert dry run</b>\n${ts} UTC\nThe ${templates.length} posts below show every public message format. Delete them all once reviewed.`);
  await sleep(800);
  for (const t of templates) {
    console.log(`[${t.label}]`);
    await send(TAG + t.body);
    await sleep(800);
  }
  console.log('\nDone. Review @SolGovActivity, delete the dry-run block when finished.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
