# Authentication

## API tokens

Machine clients should use gateway API tokens:

```http
Authorization: Bearer sp_...
```

or (Anthropic-style clients):

```http
x-api-key: sp_...
```

Tokens are validated in `src/auth/*` and carry policy/usage identity.

## Dashboard auth

Browser operators authenticate through dashboard auth routes (`src/auth/dashboard-auth.ts`).  
Cookie/session details are implementation concerns — operators should:

- serve dashboard only on trusted networks or behind SSO/TLS  
- rotate admin access if a browser session is compromised  

## Admin routes

Admin HTTP APIs require admin authentication (header/key/session depending on config).  
Never expose admin ports directly to the public internet without an access layer.

## Secret material

Use `SecretStore` (`src/plugins/types.ts`, `src/secrets/`) for non-token secrets.  
Default implementation reads process environment.
