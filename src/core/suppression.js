/**
 * Turns resolved HubSpot objects into blocklist entries (domains or emails), with
 * the guard rails that keep a firewall from blocking the wrong thing:
 *   - free-mail domains (gmail.com, outlook.com, ...) are never blocked as domains;
 *     the individual contact emails are blocked instead,
 *   - PROTECTED_DOMAINS and INTERNAL_DOMAINS are never blocked,
 *   - values are normalized and validated before they leave the workflow.
 */

export const FREEMAIL_PROVIDER_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'ymail.com',
  'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'gmx.de', 'web.de',
  'zoho.com', 'yandex.com', 'mail.com', 'qq.com', '163.com',
]);

const DOMAIN_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** "https://www.Example.com/path" -> "example.com"; returns null when not a valid domain. */
export function normalizeDomain(value) {
  if (value === undefined || value === null) return null;
  let d = String(value).trim().toLowerCase();
  if (!d) return null;
  d = d.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split(/[/?#]/)[0].split('@').pop().replace(/:\d+$/, '').replace(/\.$/, '');
  d = d.replace(/^www\d?\./, '');
  return DOMAIN_RE.test(d) ? d : null;
}

export function normalizeEmailValue(value) {
  const e = String(value ?? '').trim().toLowerCase();
  return EMAIL_RE.test(e) ? e : null;
}

export function domainOfEmail(email) {
  const e = normalizeEmailValue(email);
  return e ? e.split('@')[1] : null;
}

function isShielded(domain, rules) {
  return rules.protectedDomains.includes(domain) || rules.internalDomains.includes(domain) || rules.internalDomains.some((d) => domain.endsWith(`.${d}`));
}

/** Entry: { value, kind: 'domain'|'email', category, reason, source } */
export function entriesForCompanyAndContacts({ companies = [], contacts = [], category, reason, source, rules }) {
  const entries = [];
  const skipped = [];
  for (const company of companies) {
    const domains = [company.domain, ...(String(company.hs_additional_domains || '').split(';'))].map(normalizeDomain).filter(Boolean);
    for (const domain of domains) {
      if (isShielded(domain, rules)) skipped.push({ value: domain, reason: 'protected_or_internal' });
      else if (FREEMAIL_PROVIDER_DOMAINS.has(domain)) skipped.push({ value: domain, reason: 'freemail_domain' });
      else entries.push({ value: domain, kind: 'domain', category, reason, source });
    }
  }
  const blockedDomains = new Set(entries.map((e) => e.value));
  for (const contact of contacts) {
    const email = normalizeEmailValue(contact.email);
    if (!email) continue;
    const domain = email.split('@')[1];
    if (isShielded(domain, rules)) {
      skipped.push({ value: domain, reason: 'protected_or_internal' });
      continue;
    }
    if (FREEMAIL_PROVIDER_DOMAINS.has(domain)) {
      if (rules.blockContactEmailsForFreemail) entries.push({ value: email, kind: 'email', category, reason: `${reason} (free-mail contact)`, source });
    } else if (!blockedDomains.has(domain) && !companies.length) {
      blockedDomains.add(domain);
      entries.push({ value: domain, kind: 'domain', category, reason: `${reason} (contact domain)`, source });
    }
  }
  return { entries, skipped };
}

export function emailEntry({ email, category, reason, source, rules }) {
  const e = normalizeEmailValue(email);
  if (!e) return { entries: [], skipped: [{ value: String(email || '').slice(0, 3), reason: 'invalid_email' }] };
  if (isShielded(e.split('@')[1], rules)) return { entries: [], skipped: [{ value: e.split('@')[1], reason: 'protected_or_internal' }] };
  return { entries: [{ value: e, kind: 'email', category, reason, source }], skipped: [] };
}

/** Merges duplicates; a value keeps every category that asked for it. */
export function dedupeEntries(entries) {
  const byValue = new Map();
  for (const e of entries) {
    const existing = byValue.get(e.value);
    if (existing) {
      if (!existing.categories.includes(e.category)) existing.categories.push(e.category);
    } else {
      byValue.set(e.value, { value: e.value, kind: e.kind, category: e.category, categories: [e.category], reason: e.reason, source: e.source });
    }
  }
  return [...byValue.values()];
}

export function maskValue(value) {
  const v = String(value || '');
  if (!v.includes('@')) return v;
  const [local, domain] = v.split('@');
  return `${local.slice(0, 1)}***@${domain}`;
}
