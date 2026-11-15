/**
 * Smartlead and Instantly global blocklist requests.
 *
 *   Smartlead  POST {SMARTLEAD_BASE_URL}/leads/add-domain-block-list?api_key=...
 *              body { "domain_block_list": ["acme.example", "person@freemail.example"], "client_id"?: ... }
 *   Instantly  POST {INSTANTLY_BASE_URL}/block-lists-entries/bulk-create
 *              Authorization: Bearer ...   body { "bl_values": [...] }
 *
 * buildSequencerBatches() is shared by both runtimes: in n8n the batches feed HTTP Request
 * nodes (keys come from $env there); in Node.js executeSequencerBatch() sends them the same way.
 * Keys never appear in batch items.
 */
import { isPlaceholderSecret, sequencerKey } from './config.js';
import { maskValue } from './suppression.js';

export const SEQUENCER_NAMES = ['smartlead', 'instantly'];

export function buildSequencerBatches(entries, config) {
  const batches = [];
  for (const name of SEQUENCER_NAMES) {
    const s = config.sequencers[name];
    if (!s.enabled) continue;
    const values = [...new Set(entries.filter((e) => !(e.excludeSequencers || []).includes(name)).map((e) => e.value))];
    const keyMissing = isPlaceholderSecret(sequencerKey(config, name));
    for (let i = 0; i < values.length; i += config.sequencers.batchSize) {
      const chunk = values.slice(i, i + config.sequencers.batchSize);
      const categories = [...new Set(entries.filter((e) => chunk.includes(e.value)).flatMap((e) => e.categories || [e.category]))];
      const body = name === 'smartlead' ? { domain_block_list: chunk } : { bl_values: chunk };
      if (name === 'smartlead' && !isPlaceholderSecret(s.clientId)) body.client_id = /^\d+$/.test(s.clientId) ? Number(s.clientId) : s.clientId;
      batches.push({
        sequencer: name,
        mode: config.dryRun ? 'dry_run' : keyMissing ? 'blocked' : 'live',
        blockedReason: !config.dryRun && keyMissing ? `${name} ${config.sandboxMode ? 'sandbox ' : ''}API key missing` : null,
        sandbox: config.sandboxMode,
        method: 'POST',
        url: name === 'smartlead' ? `${s.baseUrl.replace(/\/+$/, '')}/leads/add-domain-block-list` : `${s.baseUrl.replace(/\/+$/, '')}/block-lists-entries/bulk-create`,
        body,
        count: chunk.length,
        categories,
        preview: chunk.slice(0, 5).map(maskValue),
      });
    }
  }
  return batches;
}

/** Node.js equivalent of the two n8n HTTP Request nodes. */
export async function executeSequencerBatch(batch, { config, fetchImpl, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  if (batch.mode !== 'live') return { sequencer: batch.sequencer, mode: batch.mode, count: batch.count, reason: batch.blockedReason };
  const key = sequencerKey(config, batch.sequencer);
  const url = batch.sequencer === 'smartlead' ? `${batch.url}?api_key=${encodeURIComponent(key)}` : batch.url;
  const headers = { 'content-type': 'application/json' };
  if (batch.sequencer === 'instantly') headers.authorization = `Bearer ${key}`;
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(batch.body) });
    if ((response.status === 429 || response.status >= 500) && attempt < 2) {
      await sleep(2000 * (attempt + 1));
      continue;
    }
    const text = await response.text();
    if (!response.ok) {
      const err = new Error(`${batch.sequencer} blocklist push failed with HTTP ${response.status}`);
      err.code = `${batch.sequencer}_http_${response.status}`;
      throw err;
    }
    return { sequencer: batch.sequencer, mode: 'pushed', count: batch.count, status: response.status, sandbox: batch.sandbox, responseBytes: text.length };
  }
}
