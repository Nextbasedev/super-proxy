# Security Policy

## Supported versions

Super Proxy is pre-1.0. Security fixes are applied to the current `main` branch
and included in the next tagged release. Older commits and unmaintained forks
are not supported.

| Release line | Supported |
| --- | --- |
| Current `main` / latest tagged release | Yes |
| Older snapshots | No |

## Reporting a vulnerability

Please report vulnerabilities privately through a
[GitHub Security Advisory](https://github.com/Nextbasedev/super-proxy/security/advisories/new).
Do not open a public issue for a suspected vulnerability.

Include, when possible:

- the affected Super Proxy release or commit;
- reproduction steps or a minimal proof of concept;
- the expected impact and attack prerequisites; and
- relevant logs with secrets and personal data removed.

Do not attach live API keys, session cookies, provider credentials, or
production database dumps. Maintainers will acknowledge a report as soon as
practical, coordinate remediation with the reporter, and disclose a fix after
users have had a reasonable opportunity to update.

## Operator hardening checklist

- [ ] Run behind a TLS-terminating reverse proxy.
- [ ] Generate independent, high-entropy `SESSION_SECRET` and `DEV_ADMIN_KEY` values.
- [ ] Restrict dashboard exposure to a trusted network or authenticated access layer.
- [ ] Issue least-privilege API tokens and revoke unused tokens.
- [ ] Store provider credentials outside tracked files.
- [ ] Back up and encrypt the SQLite volume.
- [ ] Keep the container base image, Node.js, and dependencies updated.

## Secret scanning

Before release builds, run:

```bash
./scripts/secret-scan.sh
```

The scan checks common credential shapes and repository-specific private
markers. It supplements, but does not replace, dependency and code review.
