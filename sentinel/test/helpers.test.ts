import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeJsonAtomic, readJsonStrict, readJsonLoose, JsonReadError } from '../src/utils/json-file';
import { escapeHtml, splitTelegramHtml } from '../src/utils/telegram-html';
import { isPrivateAddress, checkWebhookUrl } from '../src/utils/net-guard';
import { trackedName, isTrackedName } from '../src/user-tracked-multisigs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'solgov-test-'));

test('writeJsonAtomic round-trips and leaves no temp file', () => {
  const f = path.join(tmp, 'a.json');
  writeJsonAtomic(f, { x: 1 });
  assert.deepEqual(readJsonStrict(f, null), { x: 1 });
  assert.deepEqual(fs.readdirSync(tmp).filter(n => n.endsWith('.tmp')), []);
});

test('readJsonStrict returns the fallback only when the file is absent', () => {
  assert.deepEqual(readJsonStrict(path.join(tmp, 'missing.json'), { empty: true }), { empty: true });
  const bad = path.join(tmp, 'bad.json');
  fs.writeFileSync(bad, '{"half": ');
  assert.throws(() => readJsonStrict(bad, {}), JsonReadError);
  assert.deepEqual(readJsonLoose(bad, { fallback: 1 }), { fallback: 1 });
});

test('escapeHtml neutralises markup', () => {
  assert.equal(escapeHtml('<a href="x">a & b</a>'), '&lt;a href=&quot;x&quot;&gt;a &amp; b&lt;/a&gt;');
  assert.equal(escapeHtml(undefined), '');
});

test('splitTelegramHtml keeps parts under the limit and splits on lines', () => {
  const line = '<b>row</b> ' + 'x'.repeat(90);
  const text = Array.from({ length: 100 }, () => line).join('\n');
  const parts = splitTelegramHtml(text, 1000);
  assert.ok(parts.length > 1);
  for (const p of parts) {
    assert.ok(p.length <= 1000);
    assert.equal((p.match(/<b>/g) || []).length, (p.match(/<\/b>/g) || []).length);
  }
  assert.deepEqual(splitTelegramHtml('short'), ['short']);
});

test('splitTelegramHtml closes a tag left open in an over-long line', () => {
  const parts = splitTelegramHtml('<b>' + 'y'.repeat(2000) + '</b>', 500);
  assert.ok(parts[0].endsWith('</b>…'));
});

test('isPrivateAddress covers v4, v6, mapped and bracket-free forms', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '192.168.0.1', '172.20.0.1', '100.64.0.1', '::1', '::', 'fc00::1', 'fd12::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700::1111']) assert.equal(isPrivateAddress(ip), false, ip);
});

test('checkWebhookUrl rejects internal targets, accepts ordinary hosts', () => {
  for (const u of ['http://[::1]:3847/', 'http://[::ffff:7f00:1]/', 'http://127.0.0.1/', 'http://localhost/', 'ftp://example.com', 'http://user:pw@example.com/']) {
    assert.equal(checkWebhookUrl(u).ok, false, u);
  }
  // A hostname that merely starts with "fc" is not an IPv6 literal.
  assert.equal(checkWebhookUrl('https://fcbarcelona.com/hook').ok, true);
  assert.equal(checkWebhookUrl('https://partner.example.com/solgov').ok, true);
});

test('tracked names are namespaced and cannot collide with a curated protocol name', () => {
  const addr = '7qipzLR9j1JcvdxE1XJEFgvoyFmgBpgw5hMdHBMPcJtM';
  const n = trackedName(addr, 'Drift');
  assert.equal(n, 'Tracked: Drift (7qip...cJtM)');
  assert.ok(isTrackedName(n));
  assert.equal(trackedName(addr, '<b>Kamino</b> & co'), 'Tracked: bKamino/b co (7qip...cJtM)');
  assert.equal(trackedName(addr, ''), 'Tracked: multisig (7qip...cJtM)');
  // Normalising an already-namespaced name is stable.
  assert.equal(trackedName(addr, n), n);
});
