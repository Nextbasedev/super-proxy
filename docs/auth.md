# Authentication

Super Proxy has separate credentials for application traffic, browser
sessions, and administrator bootstrap. Do not reuse values across these roles.

## Gateway API tokens

Machine clients should use a gateway API token:

```http
Authorization: Bearer sp_...
```

Anthropic-style clients may send the same token as:

```http
x-api-key: sp_...
```

Tokens carry user, policy, and usage identity. Create separate tokens for
separate clients so they can be limited and revoked independently.

## Dashboard sessions

When Firebase authentication is configured, the dashboard verifies the
identity token and creates an HTTP-only session cookie. `SESSION_SECRET` signs
that cookie and must be a unique, high-entropy value in every deployment.

Generate one with:

```bash
openssl rand -hex 32
```

Changing `SESSION_SECRET` invalidates existing dashboard sessions.

## Dev admin bootstrap key

Self-host operators can bootstrap without Firebase by setting a separate
`DEV_ADMIN_KEY`. It authorizes admin routes through the `x-admin-key` header.

1. Generate a value with `openssl rand -hex 32` and place it in `.env`.
2. Open the dashboard and expand **Use dev admin key instead**.
3. Paste the key and press **Enter**.
4. Create a user and gateway token from the **Identity** view.

The dev key does not create a normal dashboard session. Treat it as a root
administrator password, keep the dashboard on a trusted network, and rotate or
remove the key when another administrator authentication path is established.

For scripted maintenance, the equivalent header is:

```http
x-admin-key: your-generated-dev-admin-key
```

Never send this header to provider APIs or distribute it to application
clients.

## Provider credentials

Provider credentials are upstream secrets, not gateway API tokens. Configure
them through the dashboard/admin API or a `SecretStore` integration. Do not
commit them to `.env.example`, source files, examples, or issue reports.
