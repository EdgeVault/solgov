/**
 * LLM wrapper for solgov features. Defaults to free-tier Groq (Llama 3.3 70B)
 * so the whole triage + digest stack runs at zero marginal cost. Falls back to
 * Anthropic Claude Haiku 4.5 if GROQ_API_KEY is missing but ANTHROPIC_API_KEY
 * is set. Returns null if neither is configured.
 *
 * Groq free tier: 14,400 requests/day, 30 RPM. Our usage is ~40 requests/month
 * total (daily digest + triage on CRITICAL), so we never touch the ceiling.
 *
 * Function name kept as askClaude() for backward compatibility with existing
 * callers - the name lies slightly but the behaviour (LLM-in, text-out) is
 * identical and it keeps triage/digest code unchanged.
 */

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
// Primary model has better reasoning but a 100k TPD free-tier cap. When the
// daily cap bites (429), we retry with 8b-instant which has a 500k TPD cap and
// is fast enough that triage/digest quality barely changes. Effect: daily
// digest + CRITICAL triage keep running even on the busiest days.
const GROQ_PRIMARY_MODEL = 'llama-3.3-70b-versatile';
const GROQ_FALLBACK_MODEL = 'llama-3.1-8b-instant';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';

function isRateLimitError(status: number): boolean {
  return status === 429;
}

/**
 * 70b-versatile intermittently fails Groq's strict JSON validation on
 * tool_calls output (json_validate_failed, 400). 8b-instant is reliable on
 * structured output and we already use it as the rate-limit fallback.
 * Treat both as "fall back to 8b" signals.
 */
function shouldFallbackToSecondary(status: number, rawBody: string | null): boolean {
  if (status === 429) return true;
  if (status === 400 && rawBody && rawBody.includes('json_validate_failed')) return true;
  return false;
}

async function groqChatOnce(model: string, apiKey: string, messages: any[], maxTokens: number): Promise<{ ok: boolean; status: number; text: string | null; raw: any; errorBody: string | null }> {
  try {
    const resp = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model, max_tokens: maxTokens, messages }),
    });
    if (!resp.ok) {
      const t = (await resp.text()).slice(0, 400);
      console.error(`[LLM-Groq ${model}] ${resp.status}: ${t.slice(0, 200)}`);
      return { ok: false, status: resp.status, text: null, raw: null, errorBody: t };
    }
    const data: any = await resp.json();
    return { ok: true, status: 200, text: data?.choices?.[0]?.message?.content ?? null, raw: data, errorBody: null };
  } catch (e: any) {
    console.error(`[LLM-Groq ${model}] Error:`, e.message?.slice(0, 120));
    return { ok: false, status: 0, text: null, raw: null, errorBody: null };
  }
}

async function askGroq(prompt: string, system: string | undefined, maxTokens: number): Promise<string | null> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;
  const messages: any[] = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });

  let res = await groqChatOnce(GROQ_PRIMARY_MODEL, apiKey, messages, maxTokens);
  if (!res.ok && shouldFallbackToSecondary(res.status, res.errorBody)) {
    console.log(`[LLM-Groq] Falling back to ${GROQ_FALLBACK_MODEL} (status=${res.status})`);
    res = await groqChatOnce(GROQ_FALLBACK_MODEL, apiKey, messages, maxTokens);
  }
  return res.ok ? res.text : null;
}

async function askAnthropic(prompt: string, system: string | undefined, maxTokens: number): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  try {
    const resp = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!resp.ok) {
      console.error(`[LLM-Anthropic] Request failed: ${resp.status} ${await resp.text().then(t => t.slice(0, 200))}`);
      return null;
    }
    const data: any = await resp.json();
    return data?.content?.[0]?.text ?? null;
  } catch (e: any) {
    console.error('[LLM-Anthropic] Error:', e.message?.slice(0, 120));
    return null;
  }
}

export async function askClaude(prompt: string, opts?: {
  model?: string;
  maxTokens?: number;
  system?: string;
}): Promise<string | null> {
  const maxTokens = opts?.maxTokens ?? 800;
  // Try Groq first (free), then Anthropic (paid fallback), then null.
  const groqResult = await askGroq(prompt, opts?.system, maxTokens);
  if (groqResult !== null) return groqResult;
  const anthropicResult = await askAnthropic(prompt, opts?.system, maxTokens);
  return anthropicResult;
}

/**
 * Standard system prompt for solgov LLM output - matches our neutral-facts
 * brand and ensures no em dashes, UK English, no judgement words.
 */
export const SOLGOV_SYSTEM_PROMPT = `You are a security analyst writing for solgov.xyz, a Solana governance transparency platform. House style:
- Neutral, fact-stating language. Never use judgement words like "alarming" or "catastrophic".
- UK English spelling.
- No em dashes. Use periods or commas.
- State facts. Let readers draw their own conclusions.
- Use HTML <b> tags for emphasis when appropriate.
- Be concise. Skip filler sentences.`;

// ---------------- Tool-use loop ----------------
//
// Groq (OpenAI-compatible) is the primary path. The conversation alternates:
//   user prompt → assistant (tool_calls) → tool results → assistant (final text)

interface ToolCallResult {
  id: string;
  name: string;
  result: any;
}

interface ToolUseResponse {
  text: string | null;
  toolCalls: ToolCallResult[];  // everything the model actually invoked, for audit
  iterations: number;
}

async function askGroqWithTools(
  prompt: string,
  tools: any[],
  system: string | undefined,
  maxTokens: number,
  executeTool: (name: string, args: any) => Promise<any>,
  maxIterations: number,
): Promise<ToolUseResponse | null> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;

  const messages: any[] = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });

  const allCalls: ToolCallResult[] = [];
  // Model can switch mid-loop if the primary hits 429 on an iteration.
  let currentModel = GROQ_PRIMARY_MODEL;

  async function chat(model: string): Promise<{ ok: boolean; status: number; data: any; errorBody: string | null }> {
    try {
      const resp = await fetch(GROQ_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          messages,
          tools,
          tool_choice: 'auto',
        }),
      });
      if (!resp.ok) {
        const t = (await resp.text()).slice(0, 400);
        console.error(`[LLM-Groq tools ${model}] ${resp.status}: ${t.slice(0, 200)}`);
        return { ok: false, status: resp.status, data: null, errorBody: t };
      }
      return { ok: true, status: 200, data: await resp.json(), errorBody: null };
    } catch (e: any) {
      console.error(`[LLM-Groq tools ${model}] Error:`, e.message?.slice(0, 120));
      return { ok: false, status: 0, data: null, errorBody: null };
    }
  }

  for (let i = 0; i < maxIterations; i++) {
    try {
      let r = await chat(currentModel);
      if (!r.ok && shouldFallbackToSecondary(r.status, r.errorBody) && currentModel === GROQ_PRIMARY_MODEL) {
        console.log(`[LLM-Groq tools] Iter ${i + 1}: switching to ${GROQ_FALLBACK_MODEL} (status=${r.status})`);
        currentModel = GROQ_FALLBACK_MODEL;
        r = await chat(currentModel);
      }
      if (!r.ok) return null;
      const data = r.data;
      const msg = data?.choices?.[0]?.message;
      if (!msg) return null;

      // Terminal: no tool calls → final text.
      const toolCalls = msg.tool_calls;
      if (!toolCalls || toolCalls.length === 0) {
        return { text: msg.content ?? null, toolCalls: allCalls, iterations: i + 1 };
      }

      // Record assistant turn as-is so the provider sees its own tool_calls
      messages.push(msg);

      for (const tc of toolCalls) {
        let args: any = {};
        try { args = JSON.parse(tc.function?.arguments || '{}'); } catch { args = {}; }
        const toolName = tc.function?.name || '';
        const result = await executeTool(toolName, args);
        allCalls.push({ id: tc.id, name: toolName, result });
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify(result).slice(0, 8000),
        });
      }
    } catch (e: any) {
      console.error('[LLM-Groq tools] Error:', e.message?.slice(0, 120));
      return null;
    }
  }

  // Ran out of iterations. Ask once more with no tools to force a final answer.
  let finalRes = await groqChatOnce(currentModel, apiKey, messages, maxTokens);
  if (!finalRes.ok && isRateLimitError(finalRes.status) && currentModel === GROQ_PRIMARY_MODEL) {
    finalRes = await groqChatOnce(GROQ_FALLBACK_MODEL, apiKey, messages, maxTokens);
  }
  return { text: finalRes.text, toolCalls: allCalls, iterations: maxIterations };
}

/**
 * Ask the LLM with tools available. Executes tool calls autonomously until
 * the model returns a plain-text response or iterations exhaust. Returns the
 * final text plus the full trace of tool calls (for logging/audit).
 */
export async function askClaudeWithTools(
  prompt: string,
  tools: any[],
  executeTool: (name: string, args: any) => Promise<any>,
  opts?: { system?: string; maxTokens?: number; maxIterations?: number },
): Promise<ToolUseResponse | null> {
  const maxTokens = opts?.maxTokens ?? 800;
  const maxIterations = opts?.maxIterations ?? 6;
  // Currently only Groq supports the OpenAI-compatible tools API here.
  // Anthropic tool-use uses a different schema, deferred until needed.
  return askGroqWithTools(prompt, tools, opts?.system, maxTokens, executeTool, maxIterations);
}
