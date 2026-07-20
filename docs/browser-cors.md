# Browser CORS use

Super Proxy supports credentialed cross-origin requests for both normal JSON responses and Server-Sent Events (SSE). A browser request with an `Origin` header receives:

- `Access-Control-Allow-Origin: <request Origin>` (never `*` when credentials are enabled)
- `Access-Control-Allow-Credentials: true`
- `Vary: Origin`

Preflight responses reflect the browser's `Access-Control-Request-Headers`. This supports gateway authentication headers (`Authorization`, `x-api-key`, `api-key`, or `apikey`) and provider/client headers such as `anthropic-version`, `anthropic-beta`, and `x-conversation-id`.

## Security policy

There is currently no HTTP origin allowlist configuration in Super Proxy. To avoid a breaking policy change, the server preserves the existing `origin: true` behavior and reflects any request Origin. This permits browser access from any origin when the caller possesses a valid gateway token; CORS is not an authentication boundary. Tokens must not be embedded in public browser bundles. A configurable allowlist should be introduced separately before exposing Super Proxy to untrusted origins.

The optional `GEMINI_LIVE_ALLOWED_ORIGINS` setting applies only to the Gemini Live WebSocket relay; WebSocket Origin validation is separate from HTTP CORS.

## Browser streaming example

`fetch()` exposes the response body as a web `ReadableStream`:

```js
const response = await fetch('https://gateway.example/v1/messages', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${gatewayToken}`,
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
    'x-conversation-id': crypto.randomUUID(),
  },
  body: JSON.stringify({
    model: 'claude-sonnet-4-6',
    stream: true,
    messages: [{ role: 'user', content: 'Hello' }],
  }),
});

if (!response.ok) throw new Error(await response.text());
const reader = response.body.getReader();
const decoder = new TextDecoder();
for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
  console.log(decoder.decode(value, { stream: true }));
}
```

## Header evidence with curl

Use placeholders or shell environment variables; do not paste real tokens into documentation or command history.

Preflight (no token required):

```sh
curl -i -X OPTIONS 'https://gateway.example/v1/messages' \
  -H 'Origin: https://app.example' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: Authorization, Content-Type, x-api-key, api-key, apikey, anthropic-version, anthropic-beta, x-conversation-id'
```

Expected response headers include the requesting origin, credentials, `Vary: Origin`, and every requested header in `Access-Control-Allow-Headers`.

Non-stream JSON:

```sh
curl -i 'https://gateway.example/v1/messages' \
  -H 'Origin: https://app.example' \
  -H "Authorization: Bearer $sp_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"model":"claude-sonnet-4-6","stream":false,"messages":[{"role":"user","content":"Hello"}]}'
```

SSE stream (`-N` disables curl response buffering):

```sh
curl -iN 'https://gateway.example/v1/messages' \
  -H 'Origin: https://app.example' \
  -H "Authorization: Bearer $sp_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'anthropic-version: 2023-06-01' \
  --data '{"model":"claude-sonnet-4-6","stream":true,"messages":[{"role":"user","content":"Hello"}]}'
```

Both actual responses should contain the same three CORS response headers listed above; the SSE response should also use `Content-Type: text/event-stream`.
