// Step-by-step LLM triage with a per-alert-type playbook and inline 'Scan deeper' continuation.

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { askClaudeWithTools, SOLGOV_SYSTEM_PROMPT } from './llm-client';
import { executeTool, getPlaybook, toolsByNames, PlaybookStep } from './llm-tools';

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TG_RISK_TEAM_THREAD = 75;

export type AlertType = 'AuthorityChange' | 'ProgramUpgrade' | 'ConfigChange' | 'NONCE' | 'VaultTx' | 'NewSigner' | 'Generic';

// Map event types from the listener into playbook keys.
function playbookKeyFor(type: string): string {
  const t = type.toLowerCase();
  if (t.includes('nonce')) return 'NONCE';
  if (t.includes('programupgrade') || t.includes('program_upgrade') || t.includes('upgrade')) return 'PROGRAM_UPGRADE';
  if (t.includes('authoritychange') || t.includes('config') || t.includes('threshold')) return 'CONFIG_CHANGE';
  if (t.includes('newsigner') || t.includes('new_signer') || t.includes('member')) return 'NEW_SIGNER';
  return 'GENERIC';
}

export interface TriageInput {
  protocol: string;
  severity: 'CRITICAL' | 'HIGH' | 'MONITOR';
  type: string;
  programId?: string;
  authority?: string;
  message: string;
  timestamp: string;
  /** Which playbook step to run. 0 = first (root cause). Defaults to 0. */
  stepIndex?: number;
}

export interface TriageOutput {
  text: string;
  stepIndex: number;
  stepId: string;
  hasNextStep: boolean;
  nextStepLabel?: string;
  toolCallsMade: number;
}

/**
 * Run a single playbook step. Returns the model's narrative + metadata
 * needed to offer a "Scan deeper" button.
 */
export async function runTriageStep(input: TriageInput): Promise<TriageOutput | null> {
  const playbookKey = playbookKeyFor(input.type);
  const playbook = getPlaybook(playbookKey);
  const stepIndex = Math.max(0, Math.min(input.stepIndex ?? 0, playbook.steps.length - 1));
  const step = playbook.steps[stepIndex];
  const hasNextStep = stepIndex + 1 < playbook.steps.length;
  const nextStep: PlaybookStep | undefined = hasNextStep ? playbook.steps[stepIndex + 1] : undefined;

  const tools = toolsByNames(step.tools);

  const prompt = `${input.severity} alert for ${input.protocol}.
Event type: ${input.type}
Program: ${input.programId || 'n/a'}
Authority: ${input.authority || 'n/a'}
Raw alert: ${input.message}
Timestamp: ${input.timestamp}

Investigation step ${stepIndex + 1} of ${playbook.steps.length}: ${step.label}.
Instruction: ${step.instruction}

Available tools for this step: ${step.tools.join(', ')}.
Call only the tools you need, then write a short finding (4-5 bullets max, 120 words).

Rules:
- Only cite facts that appear in the alert above or in tool results you have actually called.
- Do NOT invent timestamps, addresses, signer names, upgrade authorities, or any numeric claim (amounts, counts, thresholds) that is not in the input or a tool return.
- If a tool returned no data, say so and move on; do not fabricate a finding.
- UK English, neutral fact-stating language, no em dashes, no judgement words.

End with one line: "<b>Verdict:</b> routine" or "<b>Verdict:</b> worth a deeper look".

Do NOT emit pseudo function-call markup such as <function=name>...</function>, <function ... />, [tool_call: ...], or any other inline syntax that mimics a tool invocation. Tool calls go through the tool-call API only. The text response must be plain narrative readable as-is in Telegram.`;

  const response = await askClaudeWithTools(prompt, tools, executeTool, {
    system: SOLGOV_SYSTEM_PROMPT,
    maxTokens: 600,
    maxIterations: 4,
  });
  if (!response?.text) return null;

  return {
    text: sanitiseTriageText(response.text),
    stepIndex,
    stepId: step.id,
    hasNextStep,
    nextStepLabel: nextStep?.label,
    toolCallsMade: response.toolCalls.length,
  };
}

/**
 * Strip pseudo function-call markup that some LLMs emit in their narrative
 * response (especially Llama 3.x when nudged toward tool use). Keeps the
 * plain prose so the Telegram message reads cleanly. Targets every variant
 * seen in the wild rather than trying to be cute about it.
 */
function sanitiseTriageText(text: string): string {
  return text
    // <function=name>...</function>
    .replace(/<function=[^>]*>[\s\S]*?<\/function>/g, '')
    // self-closing variants: <function name=... /> or <function ... />
    .replace(/<function\s[^>]*\/?>/g, '')
    // [tool_call: ...] or [tool_use: ...]
    .replace(/\[tool[_-](?:call|use):[^\]]*\]/gi, '')
    // ```tool_code blocks
    .replace(/```(?:tool_code|tool_call|function)[\s\S]*?```/gi, '')
    // collapse the whitespace the strips left behind
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

async function postToRiskTeam(message: string, replyMarkup?: any, threadId = TG_RISK_TEAM_THREAD) {
  if (!TG_TOKEN || !TG_CHAT_ID) {
    console.log('[TRIAGE]', message);
    if (replyMarkup) console.log('[TRIAGE] keyboard:', JSON.stringify(replyMarkup));
    return;
  }
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TG_CHAT_ID,
        text: message,
        parse_mode: 'HTML',
        message_thread_id: threadId,
        reply_markup: replyMarkup,
      }),
    });
  } catch (e: any) {
    console.error('[TRIAGE] Telegram post failed:', e.message);
  }
}

/**
 * Pending triage context, keyed by a short id. Bot callback handlers look
 * this up when the user clicks "Scan deeper" so they don't need to round-trip
 * all the raw alert data through Telegram's callback_data 64-byte limit.
 */
const PENDING_FILE = path.join(__dirname, '..', 'data', 'pending-triage.json');
type PendingMap = Record<string, TriageInput>;

function loadPending(): PendingMap {
  try { return fs.existsSync(PENDING_FILE) ? JSON.parse(fs.readFileSync(PENDING_FILE, 'utf-8')) : {}; }
  catch { return {}; }
}
function savePending(map: PendingMap) {
  try { fs.writeFileSync(PENDING_FILE, JSON.stringify(map, null, 2)); } catch {}
}

/** Store the triage input under a short id and return the id. */
export function stashTriage(input: TriageInput): string {
  const id = Math.random().toString(36).slice(2, 10);
  const map = loadPending();
  // Prune anything older than 3 days so this file stays small.
  const cutoff = Date.now() - 3 * 86400 * 1000;
  for (const [k, v] of Object.entries(map)) {
    const t = Date.parse(v.timestamp);
    if (!isNaN(t) && t < cutoff) delete map[k];
  }
  map[id] = input;
  savePending(map);
  return id;
}

export function getTriage(id: string): TriageInput | null {
  return loadPending()[id] || null;
}

// De-dupe recent triage fires. 6-hour bucket per (protocol, programId, type),
// 24-hour bucket for high-frequency single-signer protocols. A different
// alert type bypasses the dedupe key and triages immediately.
const recentTriage: Map<string, number> = new Map();
const TRIAGE_DEDUPE_MS_DEFAULT = 6 * 60 * 60 * 1000;        // 6h
const TRIAGE_DEDUPE_MS_HIGH_FREQ = 24 * 60 * 60 * 1000;     // 24h

// Protocols where every triage of a routine ProgramUpgrade has come back
// "routine" because the protocol's setup is publicly known to be a
// single-signer, frequent-upgrade pattern. Triage adds no new info on each
// run, so suppress for 24h instead of 6h. Listed by canonical name (case
// case-insensitive substring match against the alert's protocol field).
const HIGH_FREQ_ROUTINE_PROTOCOLS = ['BisonFi', 'HumidiFi', 'Photon'];

function triageKey(input: TriageInput): string {
  // Dropped authority from the key - for routine upgrades the authority
  // doesn't change, and including it offered no extra dedupe value.
  return `${input.protocol}|${input.programId || ''}|${input.type}`;
}

function dedupeWindowMs(input: TriageInput): number {
  const isHighFreq = HIGH_FREQ_ROUTINE_PROTOCOLS.some(p =>
    input.protocol.toLowerCase().includes(p.toLowerCase())
  );
  return isHighFreq ? TRIAGE_DEDUPE_MS_HIGH_FREQ : TRIAGE_DEDUPE_MS_DEFAULT;
}

function shouldSuppressTriage(input: TriageInput): boolean {
  const key = triageKey(input);
  const now = Date.now();
  const window = dedupeWindowMs(input);
  // Opportunistic prune (use the longer window to avoid dropping hot keys early)
  for (const [k, t] of recentTriage) if (now - t > TRIAGE_DEDUPE_MS_HIGH_FREQ) recentTriage.delete(k);
  const last = recentTriage.get(key);
  if (last !== undefined && now - last < window) return true;
  recentTriage.set(key, now);
  return false;
}

/**
 * Timeout wrapper around runTriageStep. Returns null on timeout or thrown
 * error. Catches late settlement so a rejected LLM call after timeout can't
 * bubble up as an unhandled rejection.
 */
async function runTriageWithTimeout(input: TriageInput, timeoutMs: number): Promise<TriageOutput | null> {
  return new Promise<TriageOutput | null>(resolve => {
    let settled = false;
    const finish = (val: TriageOutput | null) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    runTriageStep(input)
      .then(out => { clearTimeout(timer); finish(out || null); })
      .catch(err => {
        clearTimeout(timer);
        console.error('[TRIAGE] step error:', err?.message?.slice(0, 200));
        finish(null);
      });
  });
}

/**
 * Entry point used by the listener when CRITICAL fires. Runs step 1 and
 * posts to the Risk Team thread with a "Scan deeper" button if more steps
 * are available.
 */
export async function runTriageAndPost(input: TriageInput): Promise<void> {
  if (shouldSuppressTriage(input)) {
    const windowH = Math.round(dedupeWindowMs(input) / 3600000);
    console.log(`[TRIAGE] suppressed re-fire for ${triageKey(input)} within ${windowH}h window`);
    return;
  }
  const output = await runTriageWithTimeout({ ...input, stepIndex: 0 }, 30000);
  if (!output) return;

  const id = stashTriage(input);
  const header = `🧠 <b>Auto-triage: ${input.protocol}</b>\nRe: ${input.type} at ${input.timestamp}\nStep 1: ${getPlaybook(playbookKeyFor(input.type)).steps[0].label} (${output.toolCallsMade} tools)`;
  const body = `${header}\n\n${output.text}`;

  const replyMarkup = output.hasNextStep
    ? { inline_keyboard: [[{ text: `🔎 ${output.nextStepLabel} (step 2)`, callback_data: `triage:${id}:1` }]] }
    : undefined;

  await postToRiskTeam(body, replyMarkup);
}

/**
 * Handler called from solgov-bot on the "Scan deeper" button.
 * Runs the next step and returns the message + whether to offer another button.
 */
export async function runStoredTriageStep(id: string, stepIndex: number): Promise<{ text: string; replyMarkup?: any } | null> {
  const input = getTriage(id);
  if (!input) return { text: '⚠️ Triage context expired. Re-trigger the scan from the source alert.' };

  // 30s timeout. Late LLM rejections are caught inside the wrapper.
  const output = await runTriageWithTimeout({ ...input, stepIndex }, 30000);
  if (!output) return null;

  const header = `🧠 <b>Auto-triage: ${input.protocol}</b>\nStep ${stepIndex + 1}: ${getPlaybook(playbookKeyFor(input.type)).steps[stepIndex].label} (${output.toolCallsMade} tools)`;
  const replyMarkup = output.hasNextStep
    ? { inline_keyboard: [[{ text: `🔎 ${output.nextStepLabel} (step ${stepIndex + 2})`, callback_data: `triage:${id}:${stepIndex + 1}` }]] }
    : undefined;
  return { text: `${header}\n\n${output.text}`, replyMarkup };
}

// CLI usage: npx tsx src/llm-triage.ts <protocol> [alertType] [step] [programId] [authority]
// Flags also accepted: --programId=... --authority=... --step=...
if (require.main === module) {
  const argv = process.argv.slice(2);
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (const a of argv) {
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (k) flags[k] = v ?? '';
    } else {
      positional.push(a);
    }
  }
  const [protocol, alertType, stepArg, programIdArg, authorityArg] = positional;
  if (!protocol) {
    console.error('Usage: npx tsx src/llm-triage.ts <protocol> [alertType=ProgramUpgrade] [step=0] [programId] [authority]');
    console.error('       or: npx tsx src/llm-triage.ts <protocol> --programId=<addr> --authority=<addr> --step=0');
    process.exit(1);
  }
  const stepIndex = parseInt(flags.step ?? stepArg ?? '0', 10) || 0;
  const programId = flags.programId ?? programIdArg;
  const authority = flags.authority ?? authorityArg;
  const type = alertType || 'ProgramUpgrade';
  runTriageStep({
    protocol,
    severity: 'CRITICAL',
    type,
    programId,
    authority,
    message: `[CLI] ${type} on ${protocol}${programId ? ` (program ${programId})` : ''}${authority ? ` by ${authority}` : ''}`,
    timestamp: new Date().toISOString(),
    stepIndex,
  }).then(out => {
    if (!out) {
      console.log('(no LLM output - GROQ_API_KEY / ANTHROPIC_API_KEY missing or request failed)');
      return;
    }
    console.log(`--- Step ${out.stepIndex + 1} (${out.stepId}) - ${out.toolCallsMade} tool calls ---\n`);
    console.log(out.text);
    if (out.hasNextStep) console.log(`\n[Next step available: ${out.nextStepLabel}]`);
  });
}
