// Minimal provider-agnostic LLM client that always asks for (and parses) a JSON object.
// Called only from extension contexts (background worker / options page), never from web pages.

import { PROVIDERS } from './storage.js';

export class LLMError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LLMError';
  }
}

const TIMEOUT_MS = 120_000;

/**
 * @param {{provider:string, apiKey:string, model:string, system:string, user:string, maxTokens?:number, onUsage?:(usage:{input:number|null,output:number|null,total:number|null})=>void}} opts
 * @returns {Promise<any>} parsed JSON object returned by the model
 */
export async function completeJSON({ provider, apiKey, model, system, user, maxTokens = 8192, onUsage }) {
  const info = PROVIDERS[provider];
  if (!info) throw new LLMError(`Unknown AI provider "${provider}".`);
  if (!apiKey) throw new LLMError(`No API key set for ${info.label}. Add one in the extension options.`);
  const m = model || info.defaultModel;

  let response;
  if (provider === 'openai') response = await callOpenAI({ apiKey, model: m, system, user, maxTokens });
  else if (provider === 'anthropic') response = await callAnthropic({ apiKey, model: m, system, user, maxTokens });
  else response = await callGemini({ apiKey, model: m, system, user, maxTokens });

  if (response.usage) await onUsage?.(response.usage);
  return parseJSONLoose(response.text);
}

export async function testConnection({ provider, apiKey, model, onUsage }) {
  const res = await completeJSON({
    provider,
    apiKey,
    model,
    system: 'You are a health check. Reply with JSON only.',
    user: 'Return exactly this JSON object: {"ok": true}',
    maxTokens: 1024,
    onUsage,
  });
  if (!res || res.ok !== true) throw new LLMError('Unexpected response from the model.');
  return true;
}

/** Parses JSON that may be wrapped in markdown fences or surrounded by prose. */
export function parseJSONLoose(text) {
  if (typeof text !== 'string' || !text.trim()) throw new LLMError('The AI returned an empty response.');
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  try {
    return JSON.parse(t);
  } catch {
    /* fall through */
  }
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(t.slice(start, end + 1));
    } catch {
      /* fall through */
    }
  }
  throw new LLMError('The AI response was not valid JSON. Try again or pick a different model.');
}

async function postJSON(url, headers, body) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const reason = e?.name === 'TimeoutError' ? 'request timed out' : e?.message || String(e);
    throw new LLMError(`Could not reach the AI provider (${reason}).`);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = data?.error?.message || data?.message || res.statusText || 'request failed';
    const hint = res.status === 401 || res.status === 403 ? ' Check your API key.' : res.status === 404 ? ' Check the model name.' : '';
    throw new LLMError(`AI provider error ${res.status}: ${msg}.${hint}`);
  }
  return data;
}

async function callOpenAI({ apiKey, model, system, user, maxTokens }) {
  const data = await postJSON(
    'https://api.openai.com/v1/responses',
    { authorization: `Bearer ${apiKey}` },
    {
      model,
      instructions: system,
      input: user,
      max_output_tokens: maxTokens,
      text: { format: { type: 'json_object' } },
    }
  );
  if (data.status === 'incomplete') {
    throw new LLMError(`The model stopped early (${data.incomplete_details?.reason || 'incomplete'}).`);
  }
  const text = typeof data.output_text === 'string' && data.output_text
    ? data.output_text
    : (data.output || [])
        .filter((item) => item.type === 'message')
        .flatMap((item) => item.content || [])
        .filter((c) => c.type === 'output_text')
        .map((c) => c.text)
        .join('');
  return { text, usage: normalizeUsage(data.usage?.input_tokens, data.usage?.output_tokens, data.usage?.total_tokens) };
}

async function callAnthropic({ apiKey, model, system, user, maxTokens }) {
  const data = await postJSON(
    'https://api.anthropic.com/v1/messages',
    {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      // Required for requests from browser contexts; the key never leaves this extension.
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    {
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    }
  );
  if (data.stop_reason === 'max_tokens') throw new LLMError('The model ran out of output tokens.');
  const text = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  return { text, usage: normalizeUsage(data.usage?.input_tokens, data.usage?.output_tokens) };
}

async function callGemini({ apiKey, model, system, user, maxTokens }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const data = await postJSON(
    url,
    { 'x-goog-api-key': apiKey },
    {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { responseMimeType: 'application/json', maxOutputTokens: maxTokens },
    }
  );
  const cand = data.candidates?.[0];
  if (!cand) {
    const reason = data.promptFeedback?.blockReason;
    throw new LLMError(reason ? `Gemini blocked the request (${reason}).` : 'Gemini returned no answer.');
  }
  if (cand.finishReason === 'MAX_TOKENS') throw new LLMError('The model ran out of output tokens.');
  const text = (cand.content?.parts || [])
    .filter((p) => !p.thought && typeof p.text === 'string')
    .map((p) => p.text)
    .join('');
  const usage = data.usageMetadata;
  return { text, usage: normalizeUsage(usage?.promptTokenCount, usage?.candidatesTokenCount, usage?.totalTokenCount) };
}

function normalizeUsage(inputTokens, outputTokens, totalTokens) {
  const input = Number.isFinite(inputTokens) ? inputTokens : null;
  const output = Number.isFinite(outputTokens) ? outputTokens : null;
  const total = Number.isFinite(totalTokens) ? totalTokens : input !== null && output !== null ? input + output : null;
  return input === null && output === null && total === null ? null : { input, output, total };
}
