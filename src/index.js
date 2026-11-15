#!/usr/bin/env node
/**
 * Node.js mirror of the n8n workflow.
 *
 *   node src/index.js                  HTTP server:
 *                                        POST /webhooks/hubspot            HubSpot -> sequencer blocklists
 *                                        POST /webhooks/sequencer-optout   Smartlead / Instantly opt-outs -> HubSpot + other sequencer
 *                                        GET  /healthz
 *   node src/index.js --simulate       offline run of all fixtures (DRY_RUN forced on)
 *   node src/index.js --reconcile      one reconciliation pass (cron-friendly)
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadSuppressionConfig, validateSuppressionConfig } from './core/config.js';
import { createSuppressionClients, handleCrmWebhook, handleSequencerOptOut, postRunLog, runReconciliation } from './core/pipeline.js';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = (name) => fs.readFileSync(path.join(ROOT_DIR, 'fixtures', name), 'utf8');

export function loadDotEnvFile(filePath = path.join(ROOT_DIR, '.env'), target = process.env) {
  if (!fs.existsSync(filePath)) return false;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    let value = match[2];
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');
    if (target[match[1]] === undefined) target[match[1]] = value;
  }
  return true;
}

function log(level, msg, data = {}) {
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(`${JSON.stringify({ ts: new Date().toISOString(), level, msg, ...data })}\n`);
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size <= maxBytes) chunks.push(chunk);
    });
    req.on('end', () => (size > maxBytes ? reject(Object.assign(new Error('payload_too_large'), { statusCode: 413 })) : resolve(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(json), 'cache-control': 'no-store' });
  res.end(json);
}

export function createServer({ env = process.env, fetchImpl = globalThis.fetch, logger = log, now = () => Date.now() } = {}) {
  const config = loadSuppressionConfig(env);
  const clients = createSuppressionClients(config, { fetchImpl });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const query = Object.fromEntries(url.searchParams);
    try {
      if (req.method === 'GET' && url.pathname === '/healthz') {
        const { errors, warnings } = validateSuppressionConfig(config);
        return sendJson(res, 200, { ok: !errors.length, dryRun: config.dryRun, sandboxMode: config.sandboxMode, errors: errors.length, warnings: warnings.length });
      }
      if (req.method === 'POST' && url.pathname === '/webhooks/hubspot') {
        const rawBody = await readBody(req, config.webhook.maxBodyBytes);
        const result = await handleCrmWebhook({ rawBody, headers: req.headers, query, method: 'POST' }, { config, fetchImpl, clients, now });
        logger('info', 'crm_webhook', { status: result.summary.status, reason: result.summary.reason, entries: result.summary.entries, batches: result.summary.batches });
        postRunLog(result.summary, { config, fetchImpl }).catch(() => {});
        return sendJson(res, result.httpStatus, { status: result.summary.status, reason: result.summary.reason, entries: result.summary.entries, dryRun: config.dryRun });
      }
      if (req.method === 'POST' && url.pathname === '/webhooks/sequencer-optout') {
        const raw = await readBody(req, config.webhook.maxBodyBytes);
        let body = {};
        try {
          body = JSON.parse(raw || '{}');
        } catch {
          return sendJson(res, 400, { status: 'rejected', reason: 'invalid_json' });
        }
        const result = await handleSequencerOptOut({ body, query, headers: req.headers }, { config, fetchImpl, clients, now });
        logger('info', 'sequencer_opt_out', { status: result.summary.status, reason: result.summary.reason, batches: result.summary.batches, hubspot: result.summary.hubspotBackSync });
        postRunLog(result.summary, { config, fetchImpl }).catch(() => {});
        return sendJson(res, result.httpStatus, { status: result.summary.status, reason: result.summary.reason, dryRun: config.dryRun });
      }
      return sendJson(res, 404, { error: 'not_found' });
    } catch (err) {
      const status = err.statusCode || 500;
      logger('error', 'request_failed', { status, message: err.message });
      return sendJson(res, status, { status: 'failed', reason: status === 413 ? 'payload_too_large' : 'internal_error' });
    }
  });
  return { server, config };
}

export async function runSimulation({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const config = loadSuppressionConfig({ INTERNAL_DOMAINS: 'yourcompany.example', COMPETITOR_DOMAINS: 'rival.example', ...env, DRY_RUN: 'true', HUBSPOT_PRIVATE_APP_TOKEN: '' });
  const offline = JSON.parse(fixture('offline-crm-objects.json'));
  const clients = createSuppressionClients(config, { fetchImpl, offline });
  const crm = await handleCrmWebhook({ rawBody: fixture('hubspot-webhook-events.json'), headers: {}, query: {} }, { config, fetchImpl, clients });
  const smartleadOptOut = await handleSequencerOptOut({ body: JSON.parse(fixture('smartlead-unsubscribe-webhook.json')), query: { source: 'smartlead' }, headers: {} }, { config, fetchImpl, clients });
  const instantlyOptOut = await handleSequencerOptOut({ body: JSON.parse(fixture('instantly-unsubscribe-webhook.json')), query: { source: 'instantly' }, headers: {} }, { config, fetchImpl, clients });
  const reconciliation = await runReconciliation({ config, fetchImpl, clients });
  return { crm, smartleadOptOut, instantlyOptOut, reconciliation };
}

async function main(argv) {
  loadDotEnvFile();
  if (argv.includes('--simulate')) {
    const r = await runSimulation();
    const show = (label, s, batches) => {
      process.stdout.write(`\n▶ ${label}: status=${s.status}${s.reason ? ` (${s.reason})` : ''} entries=${s.entries} byCategory=${JSON.stringify(s.byCategory)}\n`);
      for (const b of batches) process.stdout.write(`   ${b.sequencer.padEnd(9)} ${b.mode.padEnd(8)} ${String(b.count).padStart(3)} values  ${b.preview.join(', ')}\n`);
      for (const n of s.notes || []) process.stdout.write(`   note: ${n}\n`);
      if (s.hubspotBackSync) process.stdout.write(`   hubspot back-sync: ${s.hubspotBackSync.mode}\n`);
    };
    show('HubSpot webhook (6 events)', r.crm.summary, r.crm.batches);
    show('Smartlead opt-out', r.smartleadOptOut.summary, r.smartleadOptOut.batches);
    show('Instantly opt-out', r.instantlyOptOut.summary, r.instantlyOptOut.batches);
    show('Nightly reconciliation', r.reconciliation.summary, r.reconciliation.batches);
    process.stdout.write('\nSimulation ran offline with DRY_RUN forced to true. No blocklist or CRM write was sent.\n');
    return;
  }
  if (argv.includes('--reconcile')) {
    const config = loadSuppressionConfig(process.env);
    const r = await runReconciliation({ config });
    await postRunLog(r.summary, { config, fetchImpl: globalThis.fetch }).catch(() => {});
    process.stdout.write(`${JSON.stringify(r.summary, null, 2)}\n`);
    process.exitCode = r.summary.status === 'rejected' ? 1 : 0;
    return;
  }
  const { server, config } = createServer();
  const { errors, warnings } = validateSuppressionConfig(config);
  warnings.forEach((w) => log('warn', 'config_warning', { warning: w }));
  if (errors.length) {
    errors.forEach((e) => log('error', 'config_error', { error: e }));
    process.exitCode = 1;
    return;
  }
  const port = Number(process.env.PORT) || 3000;
  server.requestTimeout = 30000;
  server.listen(port, () => log('info', 'server_started', { port, dryRun: config.dryRun, sandboxMode: config.sandboxMode }));
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`${err.stack || err.message}\n`);
    process.exitCode = 1;
  });
}
