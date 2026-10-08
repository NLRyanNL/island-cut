// Optional Anthropic API client (used by Auto Trailer when the user has saved an API key).
// Runs in the main process so the key never reaches the renderer.
import { net } from 'electron';
import type { AiRequest } from '../../shared/api';

const API = 'https://api.anthropic.com/v1';
const FALLBACK_MODEL = 'claude-sonnet-4-5';
let cachedModel: string | null = null;

function headers(key: string): Record<string, string> {
  return {
    'x-api-key': key,
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
  };
}

/** Pick the newest Sonnet model available to this key (falls back to a known id). */
async function pickModel(key: string): Promise<string> {
  if (cachedModel) return cachedModel;
  try {
    const r = await net.fetch(`${API}/models?limit=50`, { headers: headers(key) });
    if (r.ok) {
      const j = (await r.json()) as { data?: { id: string; created_at?: string }[] };
      const models = (j.data ?? []).filter((m) => /sonnet/i.test(m.id));
      models.sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));
      if (models[0]) return (cachedModel = models[0].id);
    }
  } catch {
    /* offline or blocked: use fallback */
  }
  return (cachedModel = FALLBACK_MODEL);
}

export async function aiComplete(key: string, req: AiRequest, model?: string): Promise<string> {
  const m = model?.trim() || (await pickModel(key));
  const content: unknown[] = [];
  for (const img of req.images ?? []) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: img } });
  content.push({ type: 'text', text: req.prompt });
  const body = {
    model: m,
    max_tokens: req.maxTokens ?? 4000,
    system: req.system,
    messages: [{ role: 'user', content }],
  };
  let r: Response;
  try {
    r = await net.fetch(`${API}/messages`, { method: 'POST', headers: headers(key), body: JSON.stringify(body) });
  } catch (e) {
    throw new Error(`Could not reach the Anthropic API (${(e as Error).message}). Check your internet connection.`);
  }
  const text = await r.text();
  if (!r.ok) {
    let msg = text;
    try {
      msg = JSON.parse(text).error?.message ?? text;
    } catch {
      /* keep raw */
    }
    if (r.status === 401) throw new Error('The Anthropic API key was rejected (401). Check it in Settings.');
    if (r.status === 404 && !model) cachedModel = FALLBACK_MODEL;
    throw new Error(`Anthropic API error ${r.status}: ${msg.slice(0, 300)}`);
  }
  const j = JSON.parse(text) as { content?: { type: string; text?: string }[] };
  return (j.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('');
}
