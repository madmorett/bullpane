# Security policy

## Reporting a vulnerability

Please report security issues privately. Do **not** open a public GitHub issue.

- **Email:** hello@bullpane.com
- Or use GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
  on this repository.

Include the version (or commit), how you configured the dashboard, and the steps
to reproduce. A proof of concept helps a lot.

You will get an acknowledgement within 5 working days and an assessment within
10. Bullpane is maintained by one person, so please allow reasonable time for a
fix before disclosing publicly. Fixes ship as a patch release with credit in
[CHANGELOG.md](CHANGELOG.md), unless you prefer to stay anonymous.

There is no paid bug bounty.

## Supported versions

Security fixes land on the latest minor release. Older minors are not patched.

## Threat model, and what is *not* a vulnerability

Bullpane is a self-hosted operations dashboard. Two design decisions look like
bugs and are not:

- **The free edition has no authentication at all.** No login, no accounts, no
  sessions. Anyone who can reach the URL can retry, promote and delete jobs.
  This is deliberate and stated in the README, in the app's own header, and on
  the website. "The free edition is unauthenticated" is not a vulnerability —
  run it on a private network, or activate a Pro key for login, roles and the
  audit log.
- **The Pro features are in this repository and gated by a signed key.** Anyone
  can read the gating code and build an unlocked binary. That is the tradeoff of
  shipping the whole product under MIT; a bypass in a build you compiled
  yourself is not a security issue.

Things that **are** in scope:

- Authentication or session bypass in a licensed (Pro) installation.
- Privilege escalation between the `viewer`, `operator` and `admin` roles.
- Audit log rows that can be altered or deleted, or actions that bypass recording.
- Job data or Redis credentials leaking into logs, error messages or the audit log.
- SSRF, injection or RCE via a connection URL, job payload, alert webhook, or
  SAML/OIDC configuration.
- XSS via job data rendered in the dashboard.
- License verification flaws that let a lease be forged or replayed against an
  installation you do not control.
- Anything that lets the dashboard damage or degrade the Redis it is watching
  beyond the documented command set.

## Hardening a real deployment

- Set a long random `SESSION_SECRET`. If you leave it empty the server generates
  one at boot and logs a warning; sessions then die on restart.
- Put the dashboard behind your reverse proxy with TLS and set `PUBLIC_URL`.
- Never expose a free-edition instance to the internet.
- `BULLPANE_READ_ONLY=true` refuses every write, for pointing it at production
  before you trust it.
- Give the dashboard's Redis user read access plus the writes BullMQ needs; it
  never needs `CONFIG`, `FLUSHALL` or `KEYS`.
- Keep `BULLPANE_AUDIT_RETENTION_DAYS` aligned with your own retention policy.
