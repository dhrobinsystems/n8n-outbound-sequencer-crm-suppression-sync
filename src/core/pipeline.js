/**
 * Stages shared by the Node.js runtime and the n8n workflow.
 *
 *   CRM -> sequencers  crmIngest -> crmResolve (router) -> buildBatches -> push
 *   Sequencer -> CRM   optOutIngest -> optOutBackSync -> buildBatches (cross-sequencer) -> push
 *   Reconciliation     reconcileCollect -> crmResolve -> buildBatches -> push
 *
 * Router rules (crmResolve):
 *   deal closed-won            -> "customer"   company domains (+ free-mail contact emails)
 *   deal open                  -> "open_deal"  company domains (+ free-mail contact emails)
 *   deal closed-lost           -> nothing pushed; reported as a release candidate (never auto-removed)
 *   company type = competitor  -> "competitor" company domains; COMPETITOR_DOMAINS always included in reconciliation
 *   company/contact customer   -> "customer"
 *   contact DNC / opt-out      -> "dnc"        contact email
 */
import { isPlaceholderSecret, SUPPRESSION_CATEGORIES, validateSuppressionConfig } from './config.js';
import { dedupeEntries, emailEntry, entriesForCompanyAndContacts, normalizeDomain, normalizeEmailValue } from './suppression.js';
import { authenticateCrmWebhook, constantTimeEqual, createCrmClient, parseCrmEvents } from './hubspotSync.js';
import { buildSequencerBatches, executeSequencerBatch } from './sequencers.js';

export function createSuppressionClients(config, { fetchImpl, sleep, offline } = {}) {
  return {
    crm: createCrmClient({
      token: config.hubspot.token,
      dryRun: config.dryRun,
      sandboxMode: config.sandboxMode,
      sandboxPortalId: config.hubspot.sandboxPortalId,
      baseUrl: config.hubspot.baseUrl,
      fetchImpl,
      ...(sleep ? { sleep } : {}),
      ...(offline ? { offline } : {}),
    }),
  };
}

const truthy = (v) => String(v).toLowerCase() === 'true';

export function crmIngestStage({ rawBody, headers = {}, query = {}, method = 'POST' }, { config, now = Date.now() }) {
  const base = { flow: 'crm', receivedAt: new Date(now).toISOString(), dryRun: config.dryRun, sandboxMode: config.sandboxMode };
  const { errors, warnings } = validateSuppressionConfig(config);
  if (errors.length) return { ...base, status: 'rejected', httpStatus: 500, reason: 'config_invalid', errors };
  const raw = typeof rawBody === 'string' ? rawBody : '';
  if (Buffer.byteLength(raw, 'utf8') > config.webhook.maxBodyBytes) return { ...base, status: 'rejected', httpStatus: 413, reason: 'payload_too_large' };
  const auth = authenticateCrmWebhook({ rawBody: raw, headers, method, webhookConfig: config.webhook, now });
  if (!auth.valid) return { ...base, status: 'rejected', httpStatus: 401, reason: auth.reason };
  let payload;
  try {
    payload = JSON.parse(raw || 'null');
  } catch {
    return { ...base, status: 'rejected', httpStatus: 400, reason: 'invalid_json' };
  }
  const events = parseCrmEvents(payload, query);
  if (!events.length) return { ...base, status: 'ignored', httpStatus: 200, reason: 'no_supported_events', warnings };
  return { ...base, status: 'accepted', httpStatus: 200, reason: auth.reason, events, warnings };
}

/** The router: maps one resolved HubSpot object to suppression entries. */
export function classifyResolved(event, resolved, config) {
  const rules = config.rules;
  const out = { entries: [], skipped: [], notes: [] };
  const add = (result) => {
    out.entries.push(...result.entries);
    out.skipped.push(...result.skipped);
  };
  if (!resolved) {
    out.notes.push(`${event.objectType}:${event.objectId} not found`);
    return out;
  }
  const source = `${event.objectType}:${event.objectId}`;
  if (resolved.deal) {
    const d = resolved.deal;
    if (truthy(d.hs_is_closed_won)) {
      if (rules.closedWon) add(entriesForCompanyAndContacts({ companies: resolved.companies, contacts: resolved.contacts, category: 'customer', reason: 'closed-won deal', source, rules }));
    } else if (truthy(d.hs_is_closed)) {
      out.notes.push(`closed-lost deal ${d.id}: release candidate (blocklist entries are never removed automatically)`);
    } else if (rules.openDeals && (!rules.openDealPipelines.length || rules.openDealPipelines.includes(String(d.pipeline)))) {
      add(entriesForCompanyAndContacts({ companies: resolved.companies, contacts: resolved.contacts, category: 'open_deal', reason: 'open deal', source, rules }));
    }
  }
  if (resolved.company) {
    const c = resolved.company;
    const domain = normalizeDomain(c.domain);
    const competitorValue = String(c[rules.competitorProperty] || '').toLowerCase();
    if (rules.competitors && (rules.competitorValues.includes(competitorValue) || (domain && rules.competitorDomains.includes(domain)))) {
      add(entriesForCompanyAndContacts({ companies: [c], category: 'competitor', reason: 'competitor company', source, rules }));
    }
    if (rules.customerLifecycle && String(c.lifecyclestage).toLowerCase() === 'customer') {
      add(entriesForCompanyAndContacts({ companies: [c], category: 'customer', reason: 'customer lifecycle stage', source, rules }));
    }
  }
  if (resolved.contact) {
    const p = resolved.contact;
    if (rules.dnc && rules.dncProperties.some((prop) => truthy(p[prop]))) add(emailEntry({ email: p.email, category: 'dnc', reason: 'do-not-contact / opt-out', source, rules }));
    if (rules.customerLifecycle && String(p.lifecyclestage).toLowerCase() === 'customer') add(emailEntry({ email: p.email, category: 'customer', reason: 'customer contact', source, rules }));
  }
  return out;
}

export async function crmResolveStage(ctx, { config, crm }) {
  if (ctx.status !== 'accepted') return ctx;
  const entries = [...(ctx.seedEntries || [])];
  const skipped = [];
  const notes = [];
  for (const event of ctx.events) {
    const resolved = await crm.resolveEvent(event, { maxContacts: config.hubspot.maxContactsPerDeal });
    const r = classifyResolved(event, resolved, config);
    entries.push(...r.entries);
    skipped.push(...r.skipped);
    notes.push(...r.notes);
  }
  const deduped = dedupeEntries(entries);
  const byCategory = Object.fromEntries(SUPPRESSION_CATEGORIES.map((c) => [c, deduped.filter((e) => e.categories.includes(c)).length]));
  return { ...ctx, status: 'resolved', entries: deduped, skipped, notes, byCategory };
}

export function parseSequencerOptOut({ body = {}, query = {}, headers = {} }, config) {
  const headerToken = Object.entries(headers || {}).find(([k]) => k.toLowerCase() === 'x-sequencer-secret');
  const token = query.token || (headerToken ? headerToken[1] : '') || '';
  const secret = config.webhook.sequencerSecret;
  const authOk = isPlaceholderSecret(secret) ? config.dryRun : constantTimeEqual(token, secret);
  if (!authOk) return { valid: false, reason: 'sequencer_secret_mismatch' };
  const source = ['smartlead', 'instantly'].includes(String(query.source).toLowerCase()) ? String(query.source).toLowerCase() : body.campaign_id && body.sl_email_lead_id ? 'smartlead' : 'unknown';
  const eventType = String(body.event_type || body.event || body.type || '').toLowerCase();
  if (!config.backSync.optOutEvents.includes(eventType)) return { valid: true, ignored: true, reason: `event_not_tracked:${eventType || 'none'}`, source };
  const candidates = [body.lead_email, body.to_email, body.sl_lead_email, body.email, body.lead && body.lead.email, body.data && body.data.email];
  const email = candidates.map(normalizeEmailValue).find(Boolean) || null;
  if (!email) return { valid: true, ignored: true, reason: 'no_email_in_payload', source };
  return { valid: true, ignored: false, source, eventType, email };
}

export function optOutIngestStage(input, { config, now = Date.now() }) {
  const base = { flow: 'sequencer_opt_out', receivedAt: new Date(now).toISOString(), dryRun: config.dryRun, sandboxMode: config.sandboxMode };
  const { errors } = validateSuppressionConfig(config);
  if (errors.length) return { ...base, status: 'rejected', httpStatus: 500, reason: 'config_invalid', errors };
  const parsed = parseSequencerOptOut(input, config);
  if (!parsed.valid) return { ...base, status: 'rejected', httpStatus: 401, reason: parsed.reason };
  if (parsed.ignored) return { ...base, status: 'ignored', httpStatus: 200, reason: parsed.reason, source: parsed.source };
  return { ...base, status: 'accepted', httpStatus: 200, source: parsed.source, eventType: parsed.eventType, email: parsed.email };
}

export async function optOutBackSyncStage(ctx, { config, crm, now = Date.now() }) {
  if (ctx.status !== 'accepted') return ctx;
  let hubspot = { mode: 'disabled' };
  if (config.backSync.toHubSpot) {
    try {
      hubspot = await crm.flagContactDnc({ email: ctx.email, dncProperty: config.hubspot.dncProperty, source: ctx.source, nowIso: new Date(now).toISOString() });
    } catch (err) {
      hubspot = { mode: 'error', code: err.code || null };
    }
  }
  const { entries } = emailEntry({ email: ctx.email, category: 'dnc', reason: `opt-out reported by ${ctx.source}`, source: `sequencer:${ctx.source}`, rules: config.rules });
  const crossEntries = config.backSync.crossSequencer
    ? dedupeEntries(entries).map((e) => ({ ...e, excludeSequencers: ctx.source === 'unknown' ? [] : [ctx.source] }))
    : [];
  const { email, ...rest } = ctx;
  return { ...rest, status: 'resolved', hubspot, entries: crossEntries, byCategory: { dnc: crossEntries.length } };
}

export async function reconcileCollectStage({ config, crm, now = Date.now() }) {
  const base = { flow: 'reconciliation', receivedAt: new Date(now).toISOString(), dryRun: config.dryRun, sandboxMode: config.sandboxMode };
  const { errors } = validateSuppressionConfig(config);
  if (errors.length) return { ...base, status: 'rejected', reason: 'config_invalid', errors };
  const sinceMs = now - config.reconcile.lookbackHours * 3600 * 1000;
  const events = await crm.searchRecentDeals({ sinceMs, maxDeals: config.reconcile.maxDeals });
  const seedEntries = config.rules.competitors
    ? config.rules.competitorDomains.map(normalizeDomain).filter(Boolean).map((value) => ({ value, kind: 'domain', category: 'competitor', reason: 'COMPETITOR_DOMAINS', source: 'config' }))
    : [];
  return { ...base, status: 'accepted', events, seedEntries, since: new Date(sinceMs).toISOString() };
}

export function buildBatchesStage(ctx, { config }) {
  if (ctx.status !== 'resolved') return { ...ctx, batches: [] };
  return { ...ctx, batches: buildSequencerBatches(ctx.entries, config) };
}

export function summarizeRun(ctx, results = []) {
  return {
    flow: ctx.flow,
    status: ctx.status === 'resolved' ? 'processed' : ctx.status,
    reason: ctx.reason || null,
    dryRun: ctx.dryRun,
    sandboxMode: ctx.sandboxMode,
    events: ctx.events ? ctx.events.length : undefined,
    entries: ctx.entries ? ctx.entries.length : 0,
    byCategory: ctx.byCategory || {},
    skipped: ctx.skipped ? ctx.skipped.length : 0,
    notes: ctx.notes || [],
    hubspotBackSync: ctx.hubspot || undefined,
    batches: (ctx.batches || []).map((b) => ({ sequencer: b.sequencer, mode: b.mode, count: b.count, categories: b.categories })),
    pushes: results,
    errors: ctx.errors || [],
  };
}

/** Node.js mirror: run batches like the n8n HTTP Request nodes would. Failures are reported per batch. */
export async function pushBatches(batches, { config, fetchImpl, sleep }) {
  const results = [];
  for (const batch of batches) {
    try {
      results.push(await executeSequencerBatch(batch, { config, fetchImpl, ...(sleep ? { sleep } : {}) }));
    } catch (err) {
      results.push({ sequencer: batch.sequencer, mode: 'failed', count: batch.count, code: err.code || null });
    }
  }
  return results;
}

export async function handleCrmWebhook(input, { config, fetchImpl = globalThis.fetch, clients, sleep, now = () => Date.now() }) {
  const { crm } = clients || createSuppressionClients(config, { fetchImpl, sleep });
  let ctx = crmIngestStage(input, { config, now: now() });
  ctx = await crmResolveStage(ctx, { config, crm });
  ctx = buildBatchesStage(ctx, { config });
  const results = await pushBatches(ctx.batches, { config, fetchImpl, sleep });
  return { httpStatus: ctx.httpStatus || 200, summary: summarizeRun(ctx, results), batches: ctx.batches };
}

export async function handleSequencerOptOut(input, { config, fetchImpl = globalThis.fetch, clients, sleep, now = () => Date.now() }) {
  const { crm } = clients || createSuppressionClients(config, { fetchImpl, sleep });
  let ctx = optOutIngestStage(input, { config, now: now() });
  ctx = await optOutBackSyncStage(ctx, { config, crm, now: now() });
  ctx = buildBatchesStage(ctx, { config });
  const results = await pushBatches(ctx.batches, { config, fetchImpl, sleep });
  return { httpStatus: ctx.httpStatus || 200, summary: summarizeRun(ctx, results), batches: ctx.batches };
}

export async function runReconciliation({ config, fetchImpl = globalThis.fetch, clients, sleep, now = () => Date.now() }) {
  const { crm } = clients || createSuppressionClients(config, { fetchImpl, sleep });
  let ctx = await reconcileCollectStage({ config, crm, now: now() });
  ctx = await crmResolveStage(ctx, { config, crm });
  ctx = buildBatchesStage(ctx, { config });
  const results = await pushBatches(ctx.batches, { config, fetchImpl, sleep });
  return { summary: summarizeRun(ctx, results), batches: ctx.batches };
}

export async function postRunLog(summary, { config, fetchImpl }) {
  const url = config.log.webhookUrl;
  if (!/^https:\/\//.test(String(url || ''))) return { mode: 'not_configured' };
  const response = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'outbound_suppression_sync', summary }) });
  return { mode: response.ok ? 'sent' : 'failed', status: response.status };
}
