/**
 * Test suite (node --test). No network: a fake HubSpot API and recording fetch stubs
 * stand in for HubSpot, Smartlead and Instantly, and the n8n Code nodes are executed
 * in-process against the same fake API as the Node.js mirror.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { isPlaceholderSecret, loadSuppressionConfig, suppressionFlag, validateSuppressionConfig } from '../src/core/config.js';
import { dedupeEntries, entriesForCompanyAndContacts, maskValue, normalizeDomain, normalizeEmailValue } from '../src/core/suppression.js';
import { authenticateCrmWebhook, computeHubSpotV3Signature, createCrmClient, parseCrmEvents } from '../src/core/hubspotSync.js';
import { buildSequencerBatches, executeSequencerBatch } from '../src/core/sequencers.js';
import { classifyResolved, handleCrmWebhook, handleSequencerOptOut, parseSequencerOptOut, runReconciliation } from '../src/core/pipeline.js';
import { createServer, runSimulation } from '../src/index.js';
import { buildWorkflow, serializeWorkflow } from '../scripts/build-workflow.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = (name) => fs.readFileSync(path.join(ROOT, 'fixtures', name), 'utf8');
const EVENTS_RAW = fixture('hubspot-webhook-events.json');
const OFFLINE = JSON.parse(fixture('offline-crm-objects.json'));
const NOW = Date.parse('2026-11-15T03:00:00Z');
const BASE_ENV = { INTERNAL_DOMAINS: 'yourcompany.example', COMPETITOR_DOMAINS: 'rival.example' };
const cfg = (env = {}) => loadSuppressionConfig({ ...BASE_ENV, ...env });

/** Fake HubSpot + sequencer API built from the offline fixture map. */
function fakeApis({ sandboxAccountType = 'SANDBOX' } = {}) {
  const companies = {};
  const contacts = {};
  for (const v of Object.values(OFFLINE)) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    for (const c of v.companies || []) companies[c.id] = c;
    for (const c of v.contacts || []) contacts[c.id] = c;
  }
  const calls = [];
  const handle = (url, method, body) => {
    const u = new URL(url);
    const p = u.pathname;
    let m;
    if ((m = p.match(/^\/crm\/v3\/objects\/deals\/(\d+)$/)) && method === 'GET') {
      const d = OFFLINE[`deal:${m[1]}`];
      if (!d) return { status: 404, body: {} };
      return {
        body: {
          id: m[1],
          properties: d.deal,
          associations: { companies: { results: d.companies.map((c) => ({ id: c.id })) }, contacts: { results: d.contacts.map((c) => ({ id: c.id })) } },
        },
      };
    }
    if ((m = p.match(/^\/crm\/v3\/objects\/companies\/(\d+)$/))) return companies[m[1]] ? { body: { id: m[1], properties: companies[m[1]] } } : { status: 404 };
    if ((m = p.match(/^\/crm\/v3\/objects\/contacts\/(\d+)$/)) && method === 'GET') return contacts[m[1]] ? { body: { id: m[1], properties: contacts[m[1]] } } : { status: 404 };
    if (p.endsWith('/companies/batch/read')) return { body: { results: body.inputs.map((i) => ({ id: i.id, properties: companies[i.id] })) } };
    if (p.endsWith('/contacts/batch/read')) return { body: { results: body.inputs.map((i) => ({ id: i.id, properties: contacts[i.id] })) } };
    if (p.endsWith('/deals/search')) return { body: { results: OFFLINE.recentDeals.map((d) => ({ id: d.objectId, properties: {} })) } };
    if (p.endsWith('/contacts/search')) return { body: { results: [{ id: '5999', properties: { email: body.filterGroups[0].filters[0].value } }] } };
    if (p.match(/^\/crm\/v3\/objects\/contacts\/\d+$/) && method === 'PATCH') return { body: {} };
    if (p.endsWith('/account-info/v3/details')) return { body: { portalId: 42, accountType: sandboxAccountType } };
    if (u.hostname === 'server.smartlead.ai' || u.hostname === 'api.instantly.ai') return { body: { ok: true } };
    return { status: 404, body: {} };
  };
  const respond = ({ status = 200, body = {} }) => {
    const text = JSON.stringify(body);
    return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => text };
  };
  const fetchImpl = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method: init.method || 'GET', headers: init.headers || {}, body });
    return respond(handle(url, init.method || 'GET', body));
  };
  const httpRequest = async (opts) => {
    const r = await fetchImpl(opts.url, { method: opts.method, headers: opts.headers, body: opts.body });
    return { statusCode: r.status, headers: {}, body: await r.text() };
  };
  return { fetchImpl, httpRequest, calls };
}

const noSleep = async () => {};

describe('configuration', () => {
  test('safe defaults and placeholder detection', () => {
    const c = loadSuppressionConfig({});
    assert.equal(c.dryRun, true);
    assert.equal(c.sandboxMode, true);
    assert.equal(c.webhook.authMode, 'hubspot_v3');
    assert.equal(suppressionFlag('maybe', true), true);
    assert.equal(isPlaceholderSecret('YOUR_SMARTLEAD_API_KEY_HERE'), true);
  });

  test('live mode requires secrets, public URL, HubSpot token and sandbox keys', () => {
    const { errors } = validateSuppressionConfig(loadSuppressionConfig({ DRY_RUN: 'false', SMARTLEAD_API_KEY: 'prod-key', INSTANTLY_API_KEY: 'prod-key' }));
    for (const needle of ['WEBHOOK_SIGNING_SECRET', 'PUBLIC_WEBHOOK_URL', 'SEQUENCER_WEBHOOK_SECRET', 'HUBSPOT_PRIVATE_APP_TOKEN', 'SMARTLEAD_SANDBOX_API_KEY', 'INSTANTLY_SANDBOX_API_KEY']) {
      assert.ok(errors.some((e) => e.includes(needle)), needle);
    }
    assert.ok(validateSuppressionConfig(loadSuppressionConfig({ SYNC_SMARTLEAD: 'false', SYNC_INSTANTLY: 'false' })).errors.length);
  });
});

describe('domain and email normalization', () => {
  test('normalizeDomain strips scheme, www, paths, ports and rejects junk', () => {
    assert.equal(normalizeDomain('https://www.Prospect.Example/pricing?x=1'), 'prospect.example');
    assert.equal(normalizeDomain('customer.example:443'), 'customer.example');
    assert.equal(normalizeDomain('person@customer.example'), 'customer.example');
    assert.equal(normalizeDomain('localhost'), null);
    assert.equal(normalizeDomain('not a domain'), null);
    assert.equal(normalizeEmailValue(' Buyer@Customer.Example '), 'buyer@customer.example');
    assert.equal(maskValue('buyer@customer.example'), 'b***@customer.example');
  });

  test('free-mail domains are never blocked; contact emails are; protected/internal domains are skipped', () => {
    const rules = cfg({ PROTECTED_DOMAINS: 'partner.example' }).rules;
    const r = entriesForCompanyAndContacts({
      companies: [{ domain: 'gmail.com' }, { domain: 'partner.example' }, { domain: 'customer.example', hs_additional_domains: 'customer-group.example;bad domain' }],
      contacts: [{ email: 'someone@gmail.com' }, { email: 'rep@yourcompany.example' }, { email: 'buyer@customer.example' }],
      category: 'customer',
      reason: 'test',
      source: 'deal:1',
      rules,
    });
    assert.deepEqual(r.entries.map((e) => e.value), ['customer.example', 'customer-group.example', 'someone@gmail.com']);
    assert.deepEqual(r.skipped.map((s) => s.reason).sort(), ['freemail_domain', 'protected_or_internal', 'protected_or_internal']);
  });

  test('dedupe keeps every category', () => {
    const d = dedupeEntries([
      { value: 'a.example', kind: 'domain', category: 'customer' },
      { value: 'a.example', kind: 'domain', category: 'competitor' },
    ]);
    assert.deepEqual(d[0].categories, ['customer', 'competitor']);
  });
});

describe('HubSpot webhook authentication and parsing', () => {
  const webhookConfig = { ...cfg().webhook, signingSecret: 'test-client-secret', publicUrl: 'https://n8n.example/webhook/hubspot-suppression' };

  test('valid v3 signature passes; tampering, stale timestamps and missing headers fail', () => {
    const ts = String(NOW);
    const sig = computeHubSpotV3Signature({ secret: 'test-client-secret', method: 'POST', uri: webhookConfig.publicUrl, rawBody: EVENTS_RAW, timestamp: ts });
    const headers = { 'X-HubSpot-Signature-v3': sig, 'X-HubSpot-Request-Timestamp': ts };
    assert.equal(authenticateCrmWebhook({ rawBody: EVENTS_RAW, headers, webhookConfig, now: NOW }).valid, true);
    assert.equal(authenticateCrmWebhook({ rawBody: `${EVENTS_RAW} `, headers, webhookConfig, now: NOW }).reason, 'signature_mismatch');
    assert.equal(authenticateCrmWebhook({ rawBody: EVENTS_RAW, headers, webhookConfig, now: NOW + 10 * 60 * 1000 }).reason, 'timestamp_outside_window');
    assert.equal(authenticateCrmWebhook({ rawBody: EVENTS_RAW, headers: {}, webhookConfig, now: NOW }).reason, 'signature_headers_missing');
  });

  test('shared-secret mode for HubSpot workflow webhooks', () => {
    const shared = { ...webhookConfig, authMode: 'shared_secret' };
    assert.equal(authenticateCrmWebhook({ rawBody: '{}', headers: { 'x-webhook-secret': 'test-client-secret' }, webhookConfig: shared }).valid, true);
    assert.equal(authenticateCrmWebhook({ rawBody: '{}', headers: { 'x-webhook-secret': 'nope' }, webhookConfig: shared }).valid, false);
  });

  test('event parsing: app webhook arrays, workflow bodies, de-duplication', () => {
    const events = parseCrmEvents(JSON.parse(EVENTS_RAW));
    assert.deepEqual(events.map((e) => `${e.objectType}:${e.objectId}`), ['deal:9001', 'deal:9002', 'deal:9003', 'company:7004', 'contact:5005']);
    assert.deepEqual(parseCrmEvents({ objectId: 123, properties: {} }, { objectType: 'deal' }), [{ objectType: 'deal', objectId: '123', trigger: 'workflow_webhook' }]);
    assert.deepEqual(parseCrmEvents({ objectType: 'contact', objectId: '55' }).length, 1);
    assert.deepEqual(parseCrmEvents([{ subscriptionType: 'ticket.creation', objectId: 1 }]), []);
  });
});

describe('router rules', () => {
  const config = cfg();
  const classify = (key) => classifyResolved({ objectType: key.split(':')[0], objectId: key.split(':')[1] }, OFFLINE[key], config);

  test('closed-won, open deal, closed-lost, competitor, DNC', () => {
    assert.deepEqual(classify('deal:9001').entries.map((e) => [e.value, e.category]), [
      ['customer.example', 'customer'],
      ['customer-group.example', 'customer'],
      ['placeholder.contact@gmail.com', 'customer'],
    ]);
    assert.deepEqual(classify('deal:9002').entries.map((e) => [e.value, e.category]), [['prospect.example', 'open_deal']]);
    const lost = classify('deal:9003');
    assert.equal(lost.entries.length, 0);
    assert.match(lost.notes[0], /release candidate/);
    assert.deepEqual(classify('company:7004').entries.map((e) => e.category), ['competitor']);
    assert.deepEqual(classify('contact:5005').entries.map((e) => [e.value, e.category]), [['optout.person@prospect.example', 'dnc']]);
  });

  test('rule switches and pipeline filters', () => {
    const off = cfg({ SUPPRESS_OPEN_DEALS: 'false', SUPPRESS_DNC: 'false' });
    assert.equal(classifyResolved({ objectType: 'deal', objectId: '9002' }, OFFLINE['deal:9002'], off).entries.length, 0);
    assert.equal(classifyResolved({ objectType: 'contact', objectId: '5005' }, OFFLINE['contact:5005'], off).entries.length, 0);
    const pipeline = cfg({ OPEN_DEAL_PIPELINES: 'enterprise' });
    assert.equal(classifyResolved({ objectType: 'deal', objectId: '9002' }, OFFLINE['deal:9002'], pipeline).entries.length, 0);
    assert.match(classifyResolved({ objectType: 'deal', objectId: '1' }, null, config).notes[0], /not found/);
  });
});

describe('sequencer batches', () => {
  const entries = [
    { value: 'customer.example', categories: ['customer'] },
    { value: 'optout@prospect.example', categories: ['dnc'], excludeSequencers: ['smartlead'] },
  ];

  test('request shapes for Smartlead and Instantly, sandbox flag, no keys in batches', () => {
    const batches = buildSequencerBatches(entries, cfg({ SMARTLEAD_CLIENT_ID: '77' }));
    const sl = batches.find((b) => b.sequencer === 'smartlead');
    const inst = batches.find((b) => b.sequencer === 'instantly');
    assert.equal(sl.url, 'https://server.smartlead.ai/api/v1/leads/add-domain-block-list');
    assert.deepEqual(sl.body, { domain_block_list: ['customer.example'], client_id: 77 });
    assert.equal(inst.url, 'https://api.instantly.ai/api/v2/block-lists-entries/bulk-create');
    assert.deepEqual(inst.body, { bl_values: ['customer.example', 'optout@prospect.example'] });
    assert.equal(sl.mode, 'dry_run');
    assert.equal(sl.sandbox, true);
    assert.ok(!JSON.stringify(batches).includes('YOUR_'));
  });

  test('chunking and blocked mode when the active key is missing', () => {
    const many = Array.from({ length: 230 }, (_, i) => ({ value: `d${i}.example`, categories: ['open_deal'] }));
    const batches = buildSequencerBatches(many, cfg({ SYNC_INSTANTLY: 'false' }));
    assert.deepEqual(batches.map((b) => b.count), [100, 100, 30]);
    const blocked = buildSequencerBatches(entries, cfg({ DRY_RUN: 'false', SMARTLEAD_API_KEY: 'prod-only' }));
    assert.equal(blocked.find((b) => b.sequencer === 'smartlead').mode, 'blocked');
  });

  test('execution: api_key query for Smartlead, Bearer for Instantly, sandbox keys in sandbox mode', async () => {
    const { fetchImpl, calls } = fakeApis();
    const config = cfg({ DRY_RUN: 'false', SMARTLEAD_SANDBOX_API_KEY: 'sl-sandbox', INSTANTLY_SANDBOX_API_KEY: 'in-sandbox', SMARTLEAD_API_KEY: 'sl-prod', INSTANTLY_API_KEY: 'in-prod' });
    for (const batch of buildSequencerBatches(entries, config)) await executeSequencerBatch(batch, { config, fetchImpl, sleep: noSleep });
    assert.match(calls[0].url, /add-domain-block-list\?api_key=sl-sandbox$/);
    assert.equal(calls[1].headers.authorization, 'Bearer in-sandbox');
    assert.ok(!calls.some((c) => c.url.includes('sl-prod') || c.headers.authorization === 'Bearer in-prod'));
  });
});

describe('end-to-end flows', () => {
  test('offline simulation: dry run, nothing sent', async () => {
    const { fetchImpl, calls } = fakeApis();
    const r = await runSimulation({ env: {}, fetchImpl });
    assert.equal(r.crm.summary.entries, 6);
    assert.deepEqual(r.crm.summary.byCategory, { customer: 3, open_deal: 1, competitor: 1, dnc: 1 });
    assert.ok(r.crm.batches.every((b) => b.mode === 'dry_run'));
    assert.deepEqual(r.smartleadOptOut.batches.map((b) => b.sequencer), ['instantly']);
    assert.deepEqual(r.instantlyOptOut.batches.map((b) => b.sequencer), ['smartlead']);
    assert.ok(r.reconciliation.batches[0].body.domain_block_list.includes('rival.example'));
    assert.equal(calls.length, 0);
  });

  test('live sandbox: HubSpot reads, both sequencers pushed with sandbox keys', async () => {
    const { fetchImpl, calls } = fakeApis();
    const config = cfg({
      DRY_RUN: 'false',
      HUBSPOT_PRIVATE_APP_TOKEN: 'test-token',
      WEBHOOK_SIGNING_SECRET: 'test-client-secret',
      PUBLIC_WEBHOOK_URL: 'https://n8n.example/webhook/hubspot-suppression',
      SEQUENCER_WEBHOOK_SECRET: 'seq-secret',
      SMARTLEAD_SANDBOX_API_KEY: 'sl-sandbox',
      INSTANTLY_SANDBOX_API_KEY: 'in-sandbox',
    });
    const ts = String(Date.now());
    const sig = computeHubSpotV3Signature({ secret: 'test-client-secret', method: 'POST', uri: config.webhook.publicUrl, rawBody: EVENTS_RAW, timestamp: ts });
    const r = await handleCrmWebhook({ rawBody: EVENTS_RAW, headers: { 'x-hubspot-signature-v3': sig, 'x-hubspot-request-timestamp': ts } }, { config, fetchImpl, sleep: noSleep });
    assert.equal(r.summary.status, 'processed');
    assert.deepEqual(r.summary.pushes.map((p) => [p.sequencer, p.mode]), [['smartlead', 'pushed'], ['instantly', 'pushed']]);
    const sl = calls.find((c) => c.url.includes('add-domain-block-list'));
    assert.deepEqual(sl.body.domain_block_list.sort(), ['competitor.example', 'customer-group.example', 'customer.example', 'optout.person@prospect.example', 'placeholder.contact@gmail.com', 'prospect.example']);
    const bad = await handleCrmWebhook({ rawBody: EVENTS_RAW, headers: { 'x-hubspot-signature-v3': 'forged', 'x-hubspot-request-timestamp': ts } }, { config, fetchImpl });
    assert.equal(bad.httpStatus, 401);
  });

  test('opt-out back-sync: secret enforced, HubSpot flagged behind the sandbox check, cross-sequencer only', async () => {
    const env = { DRY_RUN: 'false', HUBSPOT_PRIVATE_APP_TOKEN: 'test-token', WEBHOOK_SIGNING_SECRET: 's', PUBLIC_WEBHOOK_URL: 'https://n8n.example/x', SEQUENCER_WEBHOOK_SECRET: 'seq-secret', SMARTLEAD_SANDBOX_API_KEY: 'sl', INSTANTLY_SANDBOX_API_KEY: 'in' };
    const body = JSON.parse(fixture('smartlead-unsubscribe-webhook.json'));
    const live = fakeApis();
    const denied = await handleSequencerOptOut({ body, query: { source: 'smartlead', token: 'wrong' } }, { config: cfg(env), fetchImpl: live.fetchImpl });
    assert.equal(denied.httpStatus, 401);
    const ok = await handleSequencerOptOut({ body, query: { source: 'smartlead', token: 'seq-secret' } }, { config: cfg(env), fetchImpl: live.fetchImpl, sleep: noSleep });
    assert.equal(ok.summary.hubspotBackSync.mode, 'written');
    const patch = live.calls.find((c) => c.method === 'PATCH');
    assert.equal(patch.body.properties.outbound_do_not_contact, 'true');
    assert.equal(patch.body.properties.outbound_dnc_source, 'smartlead');
    assert.deepEqual(ok.summary.pushes.map((p) => p.sequencer), ['instantly']);
    const prod = fakeApis({ sandboxAccountType: 'STANDARD' });
    const refused = await handleSequencerOptOut({ body, query: { source: 'smartlead', token: 'seq-secret' } }, { config: cfg(env), fetchImpl: prod.fetchImpl, sleep: noSleep });
    assert.equal(refused.summary.hubspotBackSync.code, 'sandbox_account_required');
    assert.ok(!prod.calls.some((c) => c.method === 'PATCH'));
  });

  test('opt-out parsing: untracked events and missing emails are ignored', () => {
    const config = cfg();
    assert.equal(parseSequencerOptOut({ body: { event_type: 'EMAIL_SENT', to_email: 'a@b.example' }, query: {} }, config).ignored, true);
    assert.equal(parseSequencerOptOut({ body: { event_type: 'lead_unsubscribed' }, query: {} }, config).reason, 'no_email_in_payload');
    assert.equal(parseSequencerOptOut({ body: JSON.parse(fixture('instantly-unsubscribe-webhook.json')), query: { source: 'instantly' } }, config).email, 'another.lead@prospect-three.example');
  });

  test('reconciliation searches recent deals and seeds competitor domains', async () => {
    const { fetchImpl, calls } = fakeApis();
    const r = await runReconciliation({ config: cfg({ HUBSPOT_PRIVATE_APP_TOKEN: 'test-token' }), fetchImpl, sleep: noSleep, now: () => NOW });
    const search = calls.find((c) => c.url.endsWith('/deals/search'));
    assert.equal(search.body.filterGroups[0].filters[0].value, String(NOW - 26 * 3600 * 1000));
    assert.equal(r.summary.byCategory.competitor, 1);
    assert.equal(r.summary.byCategory.customer, 3);
    assert.ok(r.batches.every((b) => b.mode === 'dry_run'));
  });

  test('HTTP server routes and limits', async () => {
    const { server } = createServer({ env: BASE_ENV, logger: () => {}, fetchImpl: fakeApis().fetchImpl });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      assert.equal((await (await fetch(`${base}/healthz`)).json()).dryRun, true);
      const r = await fetch(`${base}/webhooks/hubspot`, { method: 'POST', body: EVENTS_RAW });
      assert.equal(r.status, 200);
      const o = await fetch(`${base}/webhooks/sequencer-optout?source=instantly`, { method: 'POST', body: fixture('instantly-unsubscribe-webhook.json') });
      assert.equal((await o.json()).status, 'processed');
      assert.equal((await fetch(`${base}/webhooks/hubspot`, { method: 'POST', body: 'x'.repeat(1100000) })).status, 413);
    } finally {
      server.close();
    }
  });
});

describe('n8n workflow', () => {
  const committed = fs.readFileSync(path.join(ROOT, 'workflow.json'), 'utf8');
  const workflow = JSON.parse(committed);
  const nodes = Object.fromEntries(workflow.nodes.map((n) => [n.name, n]));

  test('structure: three triggers, router, HTTP nodes with env-only keys, error outputs', () => {
    assert.equal(new Set(workflow.nodes.map((n) => n.name)).size, workflow.nodes.length);
    for (const [from, out] of Object.entries(workflow.connections)) {
      assert.ok(nodes[from], from);
      for (const branch of out.main) for (const l of branch) assert.ok(nodes[l.node], l.node);
    }
    assert.deepEqual(nodes['Route by Suppression Category'].parameters.rules.values.map((r) => r.outputKey), ['Closed-Won Customer', 'Open Deal Domain', 'Competitor Domain', 'Do Not Contact Opt-Out']);
    const sl = nodes['Smartlead: Add to Global Block List'];
    assert.equal(sl.type, 'n8n-nodes-base.httpRequest');
    assert.match(sl.parameters.queryParameters.parameters[0].value, /\$env\.SMARTLEAD_SANDBOX_API_KEY : \$env\.SMARTLEAD_API_KEY/);
    const inst = nodes['Instantly: Bulk Add Block List Entries'];
    assert.match(inst.parameters.headerParameters.parameters[0].value, /^=Bearer \{\{ \$json\.sandbox \? \$env\.INSTANTLY_SANDBOX_API_KEY : \$env\.INSTANTLY_API_KEY \}\}$/);
    for (const n of [sl, inst]) {
      assert.equal(n.onError, 'continueErrorOutput');
      assert.equal(n.retryOnFail, true);
      assert.equal(workflow.connections[n.name].main[1][0].node, 'Record Push Failure');
    }
    assert.ok(workflow.nodes.every((n) => !n.credentials));
    assert.ok(!/pat-(?:na|eu)\d-[0-9a-f-]{20,}|xox[abpr]-|hooks\.slack\.com\/services\/T|sk-[A-Za-z0-9]{20,}/.test(committed));
    assert.equal(workflow.active, false);
  });

  test('committed workflow equals a fresh build', () => {
    assert.equal(serializeWorkflow(buildWorkflow()), committed);
  });

  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const requireFn = createRequire(import.meta.url);
  async function runNode(name, items, env, httpRequest, binary) {
    const fn = new AsyncFunction('$input', '$env', '$getWorkflowStaticData', 'require', nodes[name].parameters.jsCode);
    const helpers = { httpRequest, getBinaryDataBuffer: async () => Buffer.from(binary || '', 'utf8') };
    return fn.call({ helpers }, { first: () => items[0], all: () => items }, env, () => ({}), requireFn);
  }

  test('CRM branch through the real Code nodes produces the same batches as the Node.js mirror', async () => {
    const env = { ...BASE_ENV, HUBSPOT_PRIVATE_APP_TOKEN: 'test-token' };
    const api = fakeApis();
    let items = await runNode('Verify HubSpot Signature', [{ json: { headers: {}, query: {} }, binary: { data: {} } }], env, api.httpRequest, EVENTS_RAW);
    assert.equal(items[0].json.status, 'accepted');
    items = await runNode('Resolve CRM Objects (Router Input)', items, env, api.httpRequest);
    const categories = items.map((i) => i.json.category);
    assert.deepEqual([...new Set(categories)].sort(), ['competitor', 'customer', 'dnc', 'open_deal']);
    const n8nBatches = (await runNode('Build Blocklist Batches', items, env, api.httpRequest)).map((i) => i.json);
    const mirror = await handleCrmWebhook({ rawBody: EVENTS_RAW, headers: {} }, { config: loadSuppressionConfig(env), fetchImpl: fakeApis().fetchImpl, sleep: noSleep });
    assert.deepEqual(n8nBatches, mirror.batches);
    assert.ok(n8nBatches.every((b) => b.mode === 'dry_run'));
  });

  test('opt-out branch and skipped-batch logging', async () => {
    const env = { ...BASE_ENV };
    const api = fakeApis();
    let items = await runNode('Verify & Parse Opt-Out', [{ json: { body: JSON.parse(fixture('instantly-unsubscribe-webhook.json')), query: { source: 'instantly' }, headers: {} } }], env, api.httpRequest);
    items = await runNode('Flag DNC in HubSpot (Back-Sync)', items, env, api.httpRequest);
    assert.equal(items[0].json.category, 'dnc');
    const batches = await runNode('Build Blocklist Batches', items, env, api.httpRequest);
    assert.deepEqual(batches.map((b) => b.json.sequencer), ['smartlead']);
    const skipped = await runNode('Record Skipped Batches (Dry Run / Blocked)', batches, env, api.httpRequest);
    assert.equal(skipped[0].json.status, 'dry_run');
    assert.equal(skipped[0].json.log.mode, 'not_configured');
    assert.equal(api.calls.length, 0);
  });
});
