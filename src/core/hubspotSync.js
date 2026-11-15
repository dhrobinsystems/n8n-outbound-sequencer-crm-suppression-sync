/**
 * HubSpot side of the firewall:
 *   - webhook authentication (HubSpot signature v3, or a shared-secret header for workflow webhooks),
 *   - event parsing (app webhook event arrays, or a single { objectType, objectId } body),
 *   - object resolution (deal -> companies/contacts, company, contact),
 *   - reconciliation search, and the guarded DNC back-sync write.
 *
 * Writes honour DRY_RUN and SANDBOX_MODE (sandbox / developer-test portal only).
 * A placeholder token puts the client offline: reads use injected fixtures, writes are refused.
 */
import crypto from 'node:crypto';
import { isPlaceholderSecret } from './config.js';

export class CrmGuardError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'CrmGuardError';
    this.code = code;
  }
}

function headerOf(headers, name) {
  for (const [k, v] of Object.entries(headers || {})) if (k.toLowerCase() === name.toLowerCase()) return Array.isArray(v) ? v[0] : v;
  return null;
}

export function constantTimeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

/** HubSpot v3: base64(HMAC-SHA256(clientSecret, method + uri + body + timestamp)); timestamp within maxAge. */
export function computeHubSpotV3Signature({ secret, method, uri, rawBody, timestamp }) {
  return crypto.createHmac('sha256', String(secret)).update(`${method.toUpperCase()}${uri}${rawBody}${timestamp}`, 'utf8').digest('base64');
}

export function authenticateCrmWebhook({ rawBody, headers, method = 'POST', webhookConfig, now = Date.now() }) {
  if (isPlaceholderSecret(webhookConfig.signingSecret)) return { valid: true, reason: 'unauthenticated_dry_run' };
  if (webhookConfig.authMode === 'shared_secret') {
    return constantTimeEqual(headerOf(headers, webhookConfig.sharedSecretHeader), webhookConfig.signingSecret)
      ? { valid: true, reason: 'shared_secret' }
      : { valid: false, reason: 'shared_secret_mismatch' };
  }
  const signature = headerOf(headers, 'x-hubspot-signature-v3');
  const timestamp = headerOf(headers, 'x-hubspot-request-timestamp');
  if (!signature || !timestamp) return { valid: false, reason: 'signature_headers_missing' };
  if (!/^\d{10,13}$/.test(String(timestamp)) || Math.abs(now - Number(timestamp)) > webhookConfig.maxAgeSeconds * 1000) {
    return { valid: false, reason: 'timestamp_outside_window' };
  }
  const expected = computeHubSpotV3Signature({ secret: webhookConfig.signingSecret, method, uri: webhookConfig.publicUrl, rawBody, timestamp });
  return constantTimeEqual(signature, expected) ? { valid: true, reason: 'hubspot_v3' } : { valid: false, reason: 'signature_mismatch' };
}

const OBJECT_TYPES = { deal: 'deal', deals: 'deal', company: 'company', companies: 'company', contact: 'contact', contacts: 'contact', '0-3': 'deal', '0-2': 'company', '0-1': 'contact' };

/** Normalizes HubSpot payloads into [{ objectType, objectId, trigger }], de-duplicated. */
export function parseCrmEvents(payload, query = {}) {
  const list = Array.isArray(payload) ? payload : [payload];
  const events = [];
  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    const fromSubscription = e.subscriptionType ? String(e.subscriptionType).split('.')[0] : null;
    const type = OBJECT_TYPES[String(e.objectType || e.objectTypeId || fromSubscription || query.objectType || '').toLowerCase()];
    const idRaw = e.objectId ?? e.hs_object_id ?? (e.properties && e.properties.hs_object_id && (e.properties.hs_object_id.value ?? e.properties.hs_object_id));
    const id = idRaw !== undefined && /^\d{1,20}$/.test(String(idRaw)) ? String(idRaw) : null;
    if (!type || !id) continue;
    events.push({ objectType: type, objectId: id, trigger: e.subscriptionType ? `${e.subscriptionType}${e.propertyName ? `:${e.propertyName}` : ''}` : 'workflow_webhook' });
  }
  const seen = new Set();
  return events.filter((e) => {
    const key = `${e.objectType}:${e.objectId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export const DEAL_PROPERTIES = ['dealname', 'dealstage', 'pipeline', 'hs_is_closed', 'hs_is_closed_won', 'hs_lastmodifieddate'];
export const COMPANY_PROPERTIES = ['name', 'domain', 'hs_additional_domains', 'lifecyclestage', 'type'];
export const CONTACT_PROPERTIES = ['email', 'lifecyclestage', 'hs_email_optout', 'outbound_do_not_contact'];

export function createCrmClient({
  token,
  dryRun = true,
  sandboxMode = true,
  sandboxPortalId = '',
  baseUrl = 'https://api.hubapi.com',
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  offline: offlineData = {},
}) {
  const offline = isPlaceholderSecret(token);
  const api = String(baseUrl).replace(/\/+$/, '');
  let sandboxCheck = null;

  async function call(method, path, body, { allow404 = false } = {}) {
    if (offline) throw new CrmGuardError('hubspot_offline', 'HubSpot token is a placeholder; live API calls are disabled');
    for (let attempt = 0; ; attempt += 1) {
      const response = await fetchImpl(`${api}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (response.status === 404 && allow404) return null;
      if ((response.status === 429 || response.status >= 500) && attempt < 3) {
        await sleep(Math.min(1000 * 2 ** attempt, 8000));
        continue;
      }
      const text = await response.text();
      if (!response.ok) throw new CrmGuardError(`http_${response.status}`, `HubSpot ${method} ${path.split('?')[0]} failed with HTTP ${response.status}`);
      return text ? JSON.parse(text) : {};
    }
  }

  async function batchRead(objectType, ids, properties) {
    if (!ids.length) return [];
    const r = await call('POST', `/crm/v3/objects/${objectType}/batch/read`, { properties, inputs: ids.slice(0, 100).map((id) => ({ id })) });
    return ((r && r.results) || []).map((o) => ({ id: String(o.id), ...o.properties }));
  }

  async function getWithAssociations(objectType, id, properties, associations) {
    const assoc = associations.length ? `&associations=${associations.join(',')}` : '';
    const r = await call('GET', `/crm/v3/objects/${objectType}/${encodeURIComponent(id)}?properties=${properties.join(',')}${assoc}`, undefined, { allow404: true });
    if (!r) return null;
    const ids = (type) => ((r.associations && r.associations[type] && r.associations[type].results) || []).map((x) => String(x.id));
    return { id: String(r.id), properties: r.properties || {}, companyIds: ids('companies'), contactIds: ids('contacts') };
  }

  /** Returns { deal?, company?, contact?, companies, contacts } for one event. */
  async function resolveEvent(event, { maxContacts = 50 } = {}) {
    if (offline) {
      const key = `${event.objectType}:${event.objectId}`;
      return offlineData[key] || null;
    }
    if (event.objectType === 'deal') {
      const deal = await getWithAssociations('deals', event.objectId, DEAL_PROPERTIES, ['companies', 'contacts']);
      if (!deal) return null;
      return {
        deal: { id: deal.id, ...deal.properties },
        companies: await batchRead('companies', deal.companyIds, COMPANY_PROPERTIES),
        contacts: await batchRead('contacts', deal.contactIds.slice(0, maxContacts), CONTACT_PROPERTIES),
      };
    }
    if (event.objectType === 'company') {
      const company = await getWithAssociations('companies', event.objectId, COMPANY_PROPERTIES, []);
      return company ? { company: { id: company.id, ...company.properties }, companies: [{ id: company.id, ...company.properties }], contacts: [] } : null;
    }
    const contact = await getWithAssociations('contacts', event.objectId, CONTACT_PROPERTIES, []);
    return contact ? { contact: { id: contact.id, ...contact.properties }, companies: [], contacts: [{ id: contact.id, ...contact.properties }] } : null;
  }

  /** Deals modified since `sinceMs` that are closed-won or still open. */
  async function searchRecentDeals({ sinceMs, maxDeals }) {
    if (offline) return (offlineData.recentDeals || []).slice(0, maxDeals);
    const ids = [];
    let after;
    do {
      const body = {
        filterGroups: [{ filters: [{ propertyName: 'hs_lastmodifieddate', operator: 'GTE', value: String(sinceMs) }] }],
        properties: DEAL_PROPERTIES,
        limit: 100,
        sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'ASCENDING' }],
      };
      if (after) body.after = after;
      const page = await call('POST', '/crm/v3/objects/deals/search', body);
      for (const d of (page && page.results) || []) ids.push(String(d.id));
      after = page && page.paging && page.paging.next ? page.paging.next.after : undefined;
      if (after) await sleep(250);
    } while (after && ids.length < maxDeals);
    return ids.slice(0, maxDeals).map((id) => ({ objectType: 'deal', objectId: id, trigger: 'reconciliation' }));
  }

  async function verifySandbox() {
    if (!sandboxCheck) {
      sandboxCheck = (async () => {
        const d = await call('GET', '/account-info/v3/details');
        const portalId = String(d && d.portalId !== undefined ? d.portalId : '');
        const accountType = String((d && d.accountType) || '').toUpperCase();
        if (!isPlaceholderSecret(sandboxPortalId)) {
          if (portalId !== String(sandboxPortalId)) throw new CrmGuardError('sandbox_portal_mismatch', 'SANDBOX_MODE=true but the token is not for HUBSPOT_SANDBOX_PORTAL_ID');
        } else if (!['SANDBOX', 'DEVELOPER_TEST'].includes(accountType)) {
          throw new CrmGuardError('sandbox_account_required', `SANDBOX_MODE=true but the account type is "${accountType || 'unknown'}"`);
        }
        return true;
      })();
    }
    return sandboxCheck;
  }

  /** Back-sync: flag a contact (found by email) as do-not-contact for outbound. */
  async function flagContactDnc({ email, dncProperty, source, nowIso }) {
    if (dryRun) return { mode: 'intercepted_dry_run', property: dncProperty };
    if (offline) throw new CrmGuardError('hubspot_offline', 'HubSpot token is a placeholder; live API calls are disabled');
    if (sandboxMode) await verifySandbox();
    const found = await call('POST', '/crm/v3/objects/contacts/search', {
      filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
      properties: ['email'],
      limit: 1,
    });
    const contact = found && found.results && found.results[0];
    if (!contact) return { mode: 'contact_not_found' };
    await call('PATCH', `/crm/v3/objects/contacts/${encodeURIComponent(contact.id)}`, {
      properties: { [dncProperty]: 'true', outbound_dnc_source: source, outbound_dnc_at: nowIso },
    });
    return { mode: 'written', contactId: String(contact.id) };
  }

  return { offline, resolveEvent, searchRecentDeals, flagContactDnc, verifySandbox };
}
