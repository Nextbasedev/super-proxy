# Contributing to Super Proxy

Thanks for helping make Super Proxy better.

## Development setup

```bash
cp .env.example .env
npm ci
npm run build
npm test
./scripts/secret-scan.sh
```

Requirements: Node.js 20+.

## Project rules

1. **No secrets** in git — tokens, private keys, cookies, or live account material.  
2. **No private company markers** — internal hosts, employee emails, prod inventory.  
3. Prefer **small PRs** with tests.  
4. Keep architecture boring: Fastify routes + provider pools + SQLite.  
5. Do not reintroduce removed control-plane modules (`aside`, `oc-fleet`, etc.).  

## Code style

- TypeScript strict as configured in `tsconfig.json`  
- Avoid unnecessary abstractions; extend `src/plugins/types.ts` only when used  
- Match existing naming in `src/proxy/*` and `src/providers/*`  

## Tests

```bash
npm test
# focused
npx tsx --test src/openai.test.ts src/anthropic.test.ts
```

Add/adjust tests next to the code you change.

## Docs

User-facing changes should update:

- `README.md` (quickstart/features)  
- `docs/*` when behavior is non-obvious  
- `.env.example` when new env vars appear  

## Commit messages

Use concise, imperative subjects:

```text
fix(auth): reject empty bearer tokens
docs: clarify docker volume path
```

## Security issues

Do not open public issues for vulnerabilities. See [`SECURITY.md`](./SECURITY.md).
