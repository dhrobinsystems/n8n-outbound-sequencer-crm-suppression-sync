#!/usr/bin/env node
/**
 * Generates workflow.json from src/core/.
 *
 * Code nodes embed the same core modules the Node.js mirror imports (imports and
 * `export` keywords stripped) plus a few lines that run one stage. Blocklist pushes
 * use native n8n HTTP Request nodes whose keys come from $env. The tests rebuild the
 * workflow, fail on drift, and execute the Code nodes against a fake HubSpot API.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const OUTPUT_PATH = path.join(ROOT, 'workflow.json');
export const CORE_MODULES = ['src/core/config.js', 'src/core/suppression.js', 'src/core/hubspotSync.js', 'src/core/sequencers.js', 'src/core/pipeline.js'];
const PRELUDE_NAMES = ['crypto', 'env', 'config', 'n8nHelpers', 'n8nFetch', 'n8nSleep', 'clients', 'ctx', 'item', 'items', 'rawBody', 'entries', 'batches', 'summary', 'logResult'];
const TOP_LEVEL_DECL = /^(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm;

function stripModuleSyntax(source, file) {
  const out = source
    .replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"];\s*$/gm, '')
    .replace(/^export\s+(?=(?:async\s+)?(?:function|const|let|class)\s)/gm, '');
  if (/^(?:import|export)\s/m.test(out)) throw new Error(`${file}: unsupported import/export syntax`);
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

export function buildLibrarySource(root = ROOT) {
  const seen = new Map(PRELUDE_NAMES.map((n) => [n, 'n8n prelude']));
  return CORE_MODULES.map((rel) => {
    const body = stripModuleSyntax(fs.readFileSync(path.join(root, rel), 'utf8'), rel);
    for (const m of body.matchAll(TOP_LEVEL_DECL)) {
      if (seen.has(m[1])) throw new Error(`Top-level name "${m[1]}" in ${rel} collides with ${seen.get(m[1])}`);
      seen.set(m[1], rel);
    }
    return `// ---- ${rel} ----\n${body}`;
  }).join('\n\n');
}

const PRELUDE = `
const env = $env;
const config = loadSuppressionConfig(env);
const n8nHelpers = this.helpers;
const n8nSleep = (ms) => new Promise((resolve) => (typeof setTimeout === 'function' ? setTimeout(resolve, ms) : resolve()));
const n8nFetch = async (url, init = {}) => {
  const response = await n8nHelpers.httpRequest({
    url,
    method: init.method || 'GET',
    headers: init.headers || {},
    body: init.body,
    json: false,
    returnFullResponse: true,
    ignoreHttpStatusErrors: true,
    timeout: 20000,
  });
  const raw = response.body;
  const text = typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf8') : raw == null ? '' : JSON.stringify(raw);
  return {
    ok: response.statusCode >= 200 && response.statusCode < 300,
    status: response.statusCode,
    headers: { get: (name) => (response.headers || {})[String(name).toLowerCase()] ?? null },
    text: async () => text,
    json: async () => JSON.parse(text),
  };
};
const clients = createSuppressionClients(config, { fetchImpl: n8nFetch, sleep: n8nSleep });
`;

const toEntryItems = `const entries = (ctx.entries || []).map((entry) => ({ json: { ...entry, flow: ctx.flow, dryRun: ctx.dryRun } }));
if (!entries.length) return [{ json: { category: 'none', flow: ctx.flow, summary: summarizeRun(ctx) } }];
return entries;`;

const STAGES = {
  'Verify HubSpot Signature': `const item = $input.first();
let rawBody = '';
if (item.binary && item.binary.data) {
  rawBody = (await n8nHelpers.getBinaryDataBuffer(0, 'data')).toString('utf8');
} else {
  rawBody = typeof item.json.body === 'string' ? item.json.body : JSON.stringify(item.json.body ?? null);
}
const ctx = crmIngestStage({ rawBody, headers: item.json.headers || {}, query: item.json.query || {}, method: 'POST' }, { config, now: Date.now() });
return [{ json: ctx }];`,
  'Resolve CRM Objects (Router Input)': `const ctx = await crmResolveStage($input.first().json, { config, crm: clients.crm });
${toEntryItems}`,
  'Verify & Parse Opt-Out': `const item = $input.first();
const ctx = optOutIngestStage({ body: item.json.body || {}, query: item.json.query || {}, headers: item.json.headers || {} }, { config, now: Date.now() });
return [{ json: ctx }];`,
  'Flag DNC in HubSpot (Back-Sync)': `const ctx = await optOutBackSyncStage($input.first().json, { config, crm: clients.crm, now: Date.now() });
${toEntryItems}`,
  'Search Recent Deals & Resolve': `let ctx = await reconcileCollectStage({ config, crm: clients.crm, now: Date.now() });
ctx = await crmResolveStage(ctx, { config, crm: clients.crm });
${toEntryItems}`,
  'Build Blocklist Batches': `const items = $input.all().map((entry) => entry.json).filter((entry) => entry.value);
const batches = buildSequencerBatches(items, config);
return batches.map((batch) => ({ json: batch }));`,
  'Record Push Results': `const items = $input.all();
const summary = { type: 'blocklist_push', status: 'pushed', responses: items.length, dryRun: config.dryRun, sandboxMode: config.sandboxMode, at: new Date().toISOString() };
const logResult = await postRunLog(summary, { config, fetchImpl: n8nFetch });
return [{ json: { ...summary, log: logResult } }];`,
  'Record Push Failure': `const items = $input.all();
const summary = { type: 'blocklist_push', status: 'failed', failures: items.length, errors: items.map((i) => String((i.json && (i.json.error && (i.json.error.message || i.json.error))) || 'unknown').slice(0, 200)), dryRun: config.dryRun, sandboxMode: config.sandboxMode, at: new Date().toISOString() };
const logResult = await postRunLog(summary, { config, fetchImpl: n8nFetch });
return [{ json: { ...summary, log: logResult } }];`,
  'Record Skipped Batches (Dry Run / Blocked)': `const items = $input.all().map((i) => i.json);
const summary = { type: 'blocklist_push', status: items.some((b) => b.mode === 'blocked') ? 'blocked' : 'dry_run', batches: items.map((b) => ({ sequencer: b.sequencer, mode: b.mode, count: b.count, categories: b.categories, preview: b.preview, reason: b.blockedReason })), dryRun: config.dryRun, sandboxMode: config.sandboxMode, at: new Date().toISOString() };
const logResult = await postRunLog(summary, { config, fetchImpl: n8nFetch });
return [{ json: { ...summary, log: logResult } }];`,
};

const id = (n) => `e8b3d6f1-0000-4a00-9c00-${String(n).padStart(12, '0')}`;
const RETRY = { retryOnFail: true, maxTries: 3, waitBetweenTries: 2000 };

function switchRules(leftValue, rules, fallback = 'extra') {
  return {
    rules: {
      values: rules.map(([value, outputKey], i) => ({
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
          conditions: [{ id: id(900 + i + (leftValue.includes('mode') ? 50 : 0)), leftValue, rightValue: value, operator: { type: 'string', operation: 'equals' } }],
          combinator: 'and',
        },
        renameOutput: true,
        outputKey,
      })),
    },
    options: { fallbackOutput: fallback },
  };
}

function ifAccepted(n) {
  return {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
      conditions: [{ id: id(n), leftValue: '={{ $json.status }}', rightValue: 'accepted', operator: { type: 'string', operation: 'equals' } }],
      combinator: 'and',
    },
    options: {},
  };
}

const NOTE = `## Outbound Sequencer ↔ CRM Suppression Firewall

Generated from src/core/ by scripts/build-workflow.js. Edit src/core/, run \`npm run build:workflow\`, re-import.

**Safe by default:** DRY_RUN and SANDBOX_MODE stay true unless set to false. In sandbox mode the HTTP nodes use SMARTLEAD_SANDBOX_API_KEY / INSTANTLY_SANDBOX_API_KEY. Dry runs and missing keys route to "Record Skipped Batches".

**Rows:** (1) HubSpot webhook → router → blocklists, (2) Smartlead/Instantly opt-out → HubSpot DNC + other sequencer, (3) nightly reconciliation.

**n8n host:** NODE_FUNCTION_ALLOW_BUILTIN=crypto, N8N_BLOCK_ENV_ACCESS_IN_NODE=false, plus .env.example variables.

Full text: DISCLAIMER.md · Licensed under the MIT License. License: MIT © 2026 dhRobin Systems · Provided as-is, see the disclaimer.`;

export function buildWorkflow(root = ROOT) {
  const library = buildLibrarySource(root);
  const header = "// AUTO-GENERATED by scripts/build-workflow.js from src/core/. Edit src/core/, then run `npm run build:workflow`.\nconst crypto = require('crypto');";
  const code = (name, n, position, extra = {}) => ({
    parameters: { jsCode: `${header}\n\n${library}\n\n// ---- n8n stage runner ----${PRELUDE}\n${STAGES[name]}\n` },
    id: id(n),
    name,
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position,
    ...extra,
  });
  const respond = (n, name, position) => ({
    parameters: {
      respondWith: 'json',
      responseBody: '={{ JSON.stringify({ status: $json.status, reason: $json.reason || null }) }}',
      options: { responseCode: '={{ $json.httpStatus }}' },
    },
    id: id(n),
    name,
    type: 'n8n-nodes-base.respondToWebhook',
    typeVersion: 1.1,
    position,
  });
  const nodes = [
    { parameters: { content: NOTE, height: 400, width: 620 }, id: id(1), name: 'Read Me', type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position: [-120, -500] },
    {
      parameters: { httpMethod: 'POST', path: 'hubspot-suppression', responseMode: 'responseNode', options: { rawBody: true } },
      id: id(2),
      name: 'HubSpot CRM Webhook',
      type: 'n8n-nodes-base.webhook',
      typeVersion: 2,
      position: [0, 0],
      webhookId: id(98),
    },
    code('Verify HubSpot Signature', 3, [220, 0]),
    respond(4, 'Acknowledge HubSpot', [440, 0]),
    { parameters: ifAccepted(51), id: id(5), name: 'Events Accepted?', type: 'n8n-nodes-base.if', typeVersion: 2, position: [660, 0] },
    code('Resolve CRM Objects (Router Input)', 6, [880, 0], RETRY),
    {
      parameters: { httpMethod: 'POST', path: 'sequencer-optout', responseMode: 'responseNode', options: {} },
      id: id(7),
      name: 'Sequencer Opt-Out Webhook',
      type: 'n8n-nodes-base.webhook',
      typeVersion: 2,
      position: [0, 320],
      webhookId: id(99),
    },
    code('Verify & Parse Opt-Out', 8, [220, 320]),
    respond(9, 'Acknowledge Sequencer', [440, 320]),
    { parameters: ifAccepted(52), id: id(10), name: 'Opt-Out Accepted?', type: 'n8n-nodes-base.if', typeVersion: 2, position: [660, 320] },
    code('Flag DNC in HubSpot (Back-Sync)', 11, [880, 320], RETRY),
    {
      parameters: { rule: { interval: [{ field: 'cronExpression', expression: '15 2 * * *' }] } },
      id: id(12),
      name: 'Nightly Reconciliation',
      type: 'n8n-nodes-base.scheduleTrigger',
      typeVersion: 1.2,
      position: [0, 620],
    },
    code('Search Recent Deals & Resolve', 13, [880, 620], RETRY),
    {
      parameters: switchRules('={{ $json.category }}', [
        ['customer', 'Closed-Won Customer'],
        ['open_deal', 'Open Deal Domain'],
        ['competitor', 'Competitor Domain'],
        ['dnc', 'Do Not Contact Opt-Out'],
      ]),
      id: id(14),
      name: 'Route by Suppression Category',
      type: 'n8n-nodes-base.switch',
      typeVersion: 3,
      position: [1120, 300],
    },
    { parameters: {}, id: id(15), name: 'No Suppression Needed', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [1360, 620] },
    code('Build Blocklist Batches', 16, [1360, 300]),
    {
      parameters: switchRules('={{ $json.mode + ":" + $json.sequencer }}', [
        ['live:smartlead', 'Live: Smartlead'],
        ['live:instantly', 'Live: Instantly'],
      ]),
      id: id(17),
      name: 'Route by Sequencer',
      type: 'n8n-nodes-base.switch',
      typeVersion: 3,
      position: [1580, 300],
    },
    {
      parameters: {
        method: 'POST',
        url: '={{ $json.url }}',
        sendQuery: true,
        queryParameters: { parameters: [{ name: 'api_key', value: '={{ $json.sandbox ? $env.SMARTLEAD_SANDBOX_API_KEY : $env.SMARTLEAD_API_KEY }}' }] },
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={{ JSON.stringify($json.body) }}',
        options: { timeout: 15000 },
      },
      id: id(18),
      name: 'Smartlead: Add to Global Block List',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [1820, 160],
      ...RETRY,
      onError: 'continueErrorOutput',
    },
    {
      parameters: {
        method: 'POST',
        url: '={{ $json.url }}',
        sendHeaders: true,
        headerParameters: { parameters: [{ name: 'Authorization', value: '=Bearer {{ $json.sandbox ? $env.INSTANTLY_SANDBOX_API_KEY : $env.INSTANTLY_API_KEY }}' }] },
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={{ JSON.stringify($json.body) }}',
        options: { timeout: 15000 },
      },
      id: id(19),
      name: 'Instantly: Bulk Add Block List Entries',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [1820, 340],
      ...RETRY,
      onError: 'continueErrorOutput',
    },
    code('Record Push Results', 20, [2060, 200]),
    code('Record Push Failure', 21, [2060, 400]),
    code('Record Skipped Batches (Dry Run / Blocked)', 22, [1820, 540]),
  ];
  const link = (node) => ({ node, type: 'main', index: 0 });
  const router = 'Route by Suppression Category';
  const connections = {
    'HubSpot CRM Webhook': { main: [[link('Verify HubSpot Signature')]] },
    'Verify HubSpot Signature': { main: [[link('Acknowledge HubSpot')]] },
    'Acknowledge HubSpot': { main: [[link('Events Accepted?')]] },
    'Events Accepted?': { main: [[link('Resolve CRM Objects (Router Input)')], []] },
    'Resolve CRM Objects (Router Input)': { main: [[link(router)]] },
    'Sequencer Opt-Out Webhook': { main: [[link('Verify & Parse Opt-Out')]] },
    'Verify & Parse Opt-Out': { main: [[link('Acknowledge Sequencer')]] },
    'Acknowledge Sequencer': { main: [[link('Opt-Out Accepted?')]] },
    'Opt-Out Accepted?': { main: [[link('Flag DNC in HubSpot (Back-Sync)')], []] },
    'Flag DNC in HubSpot (Back-Sync)': { main: [[link(router)]] },
    'Nightly Reconciliation': { main: [[link('Search Recent Deals & Resolve')]] },
    'Search Recent Deals & Resolve': { main: [[link(router)]] },
    [router]: {
      main: [[link('Build Blocklist Batches')], [link('Build Blocklist Batches')], [link('Build Blocklist Batches')], [link('Build Blocklist Batches')], [link('No Suppression Needed')]],
    },
    'Build Blocklist Batches': { main: [[link('Route by Sequencer')]] },
    'Route by Sequencer': {
      main: [[link('Smartlead: Add to Global Block List')], [link('Instantly: Bulk Add Block List Entries')], [link('Record Skipped Batches (Dry Run / Blocked)')]],
    },
    'Smartlead: Add to Global Block List': { main: [[link('Record Push Results')], [link('Record Push Failure')]] },
    'Instantly: Bulk Add Block List Entries': { main: [[link('Record Push Results')], [link('Record Push Failure')]] },
  };
  return {
    name: 'Outbound Sequencer ↔ CRM Suppression Sync (HubSpot, Smartlead, Instantly)',
    nodes,
    connections,
    active: false,
    settings: { executionOrder: 'v1', saveDataSuccessExecution: 'none', saveDataErrorExecution: 'all', saveManualExecutions: false, timezone: 'UTC' },
    pinData: {},
    meta: { templateCredsSetupCompleted: true },
    tags: [],
  };
}

export function serializeWorkflow(workflow) {
  return `${JSON.stringify(workflow, null, 2)}\n`;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  const json = serializeWorkflow(buildWorkflow());
  fs.writeFileSync(OUTPUT_PATH, json);
  process.stdout.write(`Wrote ${path.relative(ROOT, OUTPUT_PATH)} (${(json.length / 1024).toFixed(1)} KiB)\n`);
}
