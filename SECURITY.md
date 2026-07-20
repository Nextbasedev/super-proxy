# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| `0.x` (main) | Best-effort security fixes |

## Reporting a vulnerability

Please report security issues **privately**.

Include:

- Super Proxy version / commit  
- Reproduction steps  
- Impact assessment  
- Any logs **with secrets redacted**

Do **not** attach live API keys, session cookies, or production database dumps.

## Hardening checklist (operators)

- [ ] Run behind TLS-terminating reverse proxy  
- [ ] Use strong admin credentials / SSO when available  
- [ ] Issue least-privilege API tokens  
- [ ] Set provider keys via environment or a real secret manager  
- [ ] Restrict dashboard exposure (VPN / tailnet / IP allowlist)  
- [ ] Back up and encrypt SQLite volumes  
- [ ] Rotate tokens after staff changes  
- [ ] Keep Node and dependencies updated  

## Secret scanning

Before release builds:

```bash
./scripts/secret-scan.sh
```

The scan fails on common token shapes and internal markers that must not ship.
