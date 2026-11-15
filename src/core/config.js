/**
 * Configuration shared by the Node.js runtime and the n8n workflow.
 *
 * Fail-safe rules:
 * - DRY_RUN and SANDBOX_MODE stay true unless explicitly set to false/0/no/off.
 * - "YOUR_..._HERE" values count as "not configured".
 * - With SANDBOX_MODE=true, blocklist pushes use the *sandbox* sequencer keys only
 *   (a separate Smartlead account / Instantly workspace). Without them, nothing is pushed.
 *
 * Embedded verbatim into the n8n Code nodes by scripts/build-workflow.js:
 * top-level names must be unique across src/core/.
 */

const SUPPRESSION_PLACEHOLDER_RE = /^(?:|your_[a-z0-9_]*_here|changeme|change_me|placeholder|x{3,})$/i;

export const SUPPRESSION_CATEGORIES = ['customer', 'open_deal', 'competitor', 'dnc'];

export function isPlaceholderSecret(value) {
  if (value === undefined || value === null) return true;
  return SUPPRESSION_PLACEHOLDER_RE.test(String(value).trim());
}

export function suppressionFlag(value, defaultValue) {
  if (value === undefined || value === null) return defaultValue;
  const v = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(v)) return true;
  if (['false', '0', 'no', 'off'].includes(v)) return false;
  return defaultValue;
}

function suppressionInt(value, fallback) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function suppressionList(value, fallback = [], lower = true) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  return String(value).split(',').map((s) => (lower ? s.trim().toLowerCase() : s.trim())).filter(Boolean);
}

export function loadSuppressionConfig(env = {}) {
  const read = (key, fallback = '') => {
    const value = env[key];
    return value === undefined || value === null ? fallback : String(value).trim();
  };
  return {
    dryRun: suppressionFlag(env.DRY_RUN, true),
    sandboxMode: suppressionFlag(env.SANDBOX_MODE, true),
    webhook: {
      authMode: read('WEBHOOK_AUTH_MODE', 'hubspot_v3').toLowerCase() === 'shared_secret' ? 'shared_secret' : 'hubspot_v3',
      signingSecret: read('WEBHOOK_SIGNING_SECRET'),
      publicUrl: read('PUBLIC_WEBHOOK_URL'),
      sharedSecretHeader: read('WEBHOOK_SHARED_SECRET_HEADER', 'x-webhook-secret').toLowerCase(),
      maxAgeSeconds: suppressionInt(env.SIGNATURE_MAX_AGE_SECONDS, 300),
      sequencerSecret: read('SEQUENCER_WEBHOOK_SECRET'),
      maxBodyBytes: suppressionInt(env.WEBHOOK_MAX_BODY_BYTES, 1048576),
    },
    hubspot: {
      token: read('HUBSPOT_PRIVATE_APP_TOKEN'),
      sandboxPortalId: read('HUBSPOT_SANDBOX_PORTAL_ID'),
      baseUrl: read('HUBSPOT_BASE_URL', 'https://api.hubapi.com'),
      dncProperty: read('HUBSPOT_DNC_PROPERTY', 'outbound_do_not_contact'),
      maxContactsPerDeal: suppressionInt(env.MAX_CONTACTS_PER_DEAL, 50),
    },
    rules: {
      closedWon: suppressionFlag(env.SUPPRESS_CLOSED_WON, true),
      openDeals: suppressionFlag(env.SUPPRESS_OPEN_DEALS, true),
      competitors: suppressionFlag(env.SUPPRESS_COMPETITORS, true),
      dnc: suppressionFlag(env.SUPPRESS_DNC, true),
      customerLifecycle: suppressionFlag(env.SUPPRESS_CUSTOMER_LIFECYCLE, true),
      openDealPipelines: suppressionList(env.OPEN_DEAL_PIPELINES, [], false),
      competitorProperty: read('COMPETITOR_PROPERTY', 'type'),
      competitorValues: suppressionList(env.COMPETITOR_VALUES, ['competitor']),
      competitorDomains: suppressionList(env.COMPETITOR_DOMAINS),
      dncProperties: suppressionList(env.DNC_PROPERTIES, ['hs_email_optout', 'outbound_do_not_contact'], false),
      protectedDomains: suppressionList(env.PROTECTED_DOMAINS),
      internalDomains: suppressionList(env.INTERNAL_DOMAINS),
      blockContactEmailsForFreemail: suppressionFlag(env.BLOCK_CONTACT_EMAILS_FOR_FREEMAIL, true),
    },
    sequencers: {
      smartlead: {
        enabled: suppressionFlag(env.SYNC_SMARTLEAD, true),
        apiKey: read('SMARTLEAD_API_KEY'),
        sandboxApiKey: read('SMARTLEAD_SANDBOX_API_KEY'),
        clientId: read('SMARTLEAD_CLIENT_ID'),
        baseUrl: read('SMARTLEAD_BASE_URL', 'https://server.smartlead.ai/api/v1'),
      },
      instantly: {
        enabled: suppressionFlag(env.SYNC_INSTANTLY, true),
        apiKey: read('INSTANTLY_API_KEY'),
        sandboxApiKey: read('INSTANTLY_SANDBOX_API_KEY'),
        baseUrl: read('INSTANTLY_BASE_URL', 'https://api.instantly.ai/api/v2'),
      },
      batchSize: Math.min(suppressionInt(env.BATCH_SIZE, 100), 500),
    },
    backSync: {
      optOutEvents: suppressionList(env.SEQUENCER_OPT_OUT_EVENTS, ['lead_unsubscribed', 'unsubscribed', 'lead_opted_out']),
      toHubSpot: suppressionFlag(env.BACK_SYNC_TO_HUBSPOT, true),
      crossSequencer: suppressionFlag(env.CROSS_SEQUENCER_SYNC, true),
    },
    reconcile: {
      lookbackHours: suppressionInt(env.RECONCILE_LOOKBACK_HOURS, 26),
      maxDeals: suppressionInt(env.RECONCILE_MAX_DEALS, 2000),
    },
    log: { webhookUrl: read('LOG_WEBHOOK_URL') },
  };
}

export function sequencerKey(config, name) {
  const s = config.sequencers[name];
  return config.sandboxMode ? s.sandboxApiKey : s.apiKey;
}

export function validateSuppressionConfig(config) {
  const errors = [];
  const warnings = [];
  const live = !config.dryRun;
  if (isPlaceholderSecret(config.webhook.signingSecret)) {
    if (live) errors.push('WEBHOOK_SIGNING_SECRET is missing or a placeholder');
    else warnings.push('WEBHOOK_SIGNING_SECRET is a placeholder: HubSpot webhook verification is skipped in dry run');
  }
  if (config.webhook.authMode === 'hubspot_v3' && live && !/^https:\/\//.test(config.webhook.publicUrl)) {
    errors.push('PUBLIC_WEBHOOK_URL (the exact https URL HubSpot calls) is required for v3 signature checks');
  }
  if (isPlaceholderSecret(config.webhook.sequencerSecret)) {
    if (live) errors.push('SEQUENCER_WEBHOOK_SECRET is missing or a placeholder');
    else warnings.push('SEQUENCER_WEBHOOK_SECRET is a placeholder: sequencer webhooks are accepted unauthenticated in dry run');
  }
  if (!config.sequencers.smartlead.enabled && !config.sequencers.instantly.enabled) errors.push('Enable at least one of SYNC_SMARTLEAD / SYNC_INSTANTLY');
  if (live) {
    if (isPlaceholderSecret(config.hubspot.token)) errors.push('HUBSPOT_PRIVATE_APP_TOKEN is missing or a placeholder');
    for (const name of ['smartlead', 'instantly']) {
      if (!config.sequencers[name].enabled) continue;
      if (isPlaceholderSecret(sequencerKey(config, name))) {
        errors.push(`${config.sandboxMode ? `${name.toUpperCase()}_SANDBOX_API_KEY` : `${name.toUpperCase()}_API_KEY`} is missing or a placeholder`);
      }
    }
    if (!config.sandboxMode) warnings.push('SANDBOX_MODE=false and DRY_RUN=false: production blocklists and HubSpot are modified');
  }
  return { errors, warnings };
}
