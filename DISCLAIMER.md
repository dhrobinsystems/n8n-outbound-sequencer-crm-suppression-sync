# ⚠️ Disclaimer & Liability Limitation

**Use at your own risk.** The code, workflows, and scripts provided in this repository (`n8n-outbound-sequencer-crm-suppression-sync`) are for educational and architectural demonstration purposes. I publish them as a reference implementation from dhRobin Systems, not as a managed product or service.

## No Liability

The author and dhRobin Systems assume no responsibility or liability for any direct, indirect, incidental, special, exemplary, or consequential damages resulting from the use, misuse, or deployment of these scripts. That includes, without limitation: cold emails sent to customers, active prospects, competitors, or people who opted out; domains or addresses blocked that should not have been; lost pipeline, revenue, or customer goodwill; sender-reputation or deliverability damage; regulatory complaints or penalties; API rate-limit or quota overruns; synchronization delays or gaps; CRM state discrepancies; and third-party service outages. This applies however the damage is caused and on any theory of liability, even if advised of the possibility of such damage.

## No Warranty

All software, n8n JSON blueprints, and JavaScript modules are provided "AS IS" without warranty of any kind, express or implied, including but not limited to merchantability, fitness for a particular purpose, or non-infringement. I do not warrant that any webhook will be delivered, that every CRM change will be suppressed within any time frame, or that HubSpot, Smartlead, Instantly, or n8n will keep the endpoints, payloads, event names, and limits this project expects.

## Suppression Is a Safety Net, Not a Guarantee

This workflow reduces the chance of contacting the wrong people. It does not replace list hygiene, campaign review, or your own sending policies. Webhooks can be delayed, retried, or dropped; blocklist APIs can be unavailable; free-mail contacts can only be blocked one address at a time; and contacts not yet recorded in HubSpot cannot be suppressed at all. Review campaign lists before launch.

## Production Testing Required

Always test thoroughly in an isolated staging environment (for example a HubSpot developer test account or sandbox, a separate Smartlead account, and a separate Instantly workspace) with `SANDBOX_MODE=true` and `DRY_RUN=true` enabled before connecting live HubSpot credentials. Treat every blocklist entry as long-lived: this project never removes entries automatically, and removing them by hand is your decision.

## Third-Party APIs & Compliance

Users are solely responsible for complying with the terms of service, rate limits, data privacy regulations (GDPR, UK GDPR, CCPA/CPRA, ePrivacy, CAN-SPAM, CASL, and any other applicable law), and security policies of HubSpot, Smartlead, Instantly, and any connected service. That includes:

- confirming a lawful basis for sending prospect, customer, and opt-out email addresses and domains to each sequencer;
- honouring every unsubscribe and do-not-contact request across every sending tool, within the deadlines the law sets;
- making sure the HubSpot back-sync property reflects real opt-outs, and never using it to override a contact's own subscription choices;
- keeping n8n execution data, server logs, and log destinations free of more personal data than you need;
- honouring data subject requests across HubSpot, both sequencers, and n8n.

## Security

Webhook signature checks, shared secrets, sandbox keys, and dry-run defaults reduce risk but do not eliminate it. You are responsible for protecting API keys and secrets, rotating them, restricting who can reach the webhook URLs and n8n, and keeping all dependencies patched.

## Not Professional Advice

Nothing in this repository is legal, compliance, privacy, or deliverability advice. Consult qualified professionals for your jurisdiction and use case.

---

Full text: DISCLAIMER.md · Licensed under the MIT License. License: MIT © 2026 dhRobin Systems · Provided as-is, see the disclaimer.
