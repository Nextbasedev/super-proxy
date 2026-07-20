# Super Proxy Search API

Use `POST /v1/search` when you want a simple web-search endpoint through the Super Proxy proxy.

This endpoint is authenticated with the same `sp_*` proxy token used for all other gateway routes.

## Base URL

```text
http://localhost:8080
```

## Authentication

Any of these token styles work:

```http
Authorization: Bearer sp_xxx
```

```http
x-api-key: sp_xxx
```

```http
api-key: sp_xxx
```

```http
apikey: sp_xxx
```

Do not send upstream provider keys. Send only your Super Proxy gateway token.

## Quick start

```bash
curl "http://localhost:8080/v1/search" \
  -H "Authorization: Bearer $NEXTBASE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "latest AI news today"
  }'
```

Minimum request:

```json
{
  "query": "latest AI news today"
}
```

`query` is the only required parameter. Everything else is optional.

## Request body

```json
{
  "query": "latest AI news today",
  "mode": "models",
  "provider": "gemini",
  "model": "gemini-2.5-flash-lite",
  "limit": 10,
  "max_tokens": 768
}
```

### Parameters

| Field | Required | Default | Description |
| --- | --- | --- | --- |
| `query` | Yes | — | Search query. |
| `mode` | No | `models` | `models` for model-backed search, `serp` for paid Google SERP via Serper. |
| `provider` | No | `gemini` | Model-search provider: `gemini`, `xai`, or `codex`. |
| `model` | No | Provider default | Override the model used for model-backed search. |
| `limit` | No | `10` | Max indexed results to return. Clamped between `1` and `20`. |
| `max_tokens` | No | `768` | Output budget for Gemini search. |
| `gl` / `country` | No | — | Serper Google country code, e.g. `us`, `in`, `lu`. |
| `hl` / `language` | No | — | Serper Google language code, e.g. `en`, `hi`. |
| `tbs` / `dateRange` / `date_range` | No | — | Serper/Google date range filter, e.g. `qdr:d`, `qdr:w`, `qdr:m`, `qdr:y`. |
| `page` | No | — | Serper page number for pagination. |
| `max_output_tokens` | No | `768` | Output budget for xAI/Codex search. |

## Provider defaults

| Provider | Default model | Backend route |
| --- | --- | --- |
| `gemini` | `gemini-2.5-flash-lite` | `/v1/gemini/chat/completions` with Google Search grounding |
| `xai` | `grok-4.3` | `/v1/xai/responses` with Agent Tools `web_search` |
| `codex` | `gpt-5.4-mini` | `/v1/responses` with `web_search` |

## Response

```json
{
  "query": "latest AI news today",
  "mode": "models",
  "provider": "gemini",
  "model": "gemini-2.5-flash-lite",
  "answer": "Concise model-generated answer...",
  "results": [
    {
      "index": 1,
      "title": "Source title or domain",
      "url": "https://example.com/article",
      "source": "grounding"
    }
  ],
  "usage": {
    "prompt_tokens": 28,
    "completion_tokens": 558,
    "total_tokens": 657,
    "tool_use_prompt_tokens": 71
  },
  "grounding_metadata": {}
}
```

### Response fields

| Field | Description |
| --- | --- |
| `query` | The query you sent. |
| `mode` | Active mode, currently `models`. |
| `provider` | Provider used for search. |
| `model` | Model used for search. |
| `answer` | Model-generated answer using web search/grounding. |
| `results` | Indexed source list extracted from provider citations/grounding. |
| `results[].index` | Stable 1-based result number. |
| `results[].title` | Source title/domain when available. |
| `results[].url` | Source URL. Gemini may return Google grounding redirect URLs. |
| `results[].source` | Source type, e.g. `grounding` or `annotation`. |
| `usage` | Token/tool usage returned by the model provider. |
| `grounding_metadata` | Gemini raw grounding metadata when provider is `gemini`. |

## Examples

### Default Gemini search

```bash
curl "$BASE_URL/v1/search" \
  -H "x-api-key: $NEXTBASE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query":"what happened in AI today?","limit":5}'
```

### Paid Google SERP via Serper

```bash
curl "$BASE_URL/v1/search" \
  -H "x-api-key: $NEXTBASE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "query":"apple inc",
    "mode":"serp",
    "limit":10,
    "country":"us",
    "language":"en",
    "tbs":"qdr:d",
    "page":1
  }'
```

### xAI search

```bash
curl "$BASE_URL/v1/search" \
  -H "x-api-key: $NEXTBASE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "query":"latest SpaceX news",
    "provider":"xai",
    "model":"grok-4.3",
    "limit":5
  }'
```

### Codex/OpenAI Responses search

```bash
curl "$BASE_URL/v1/search" \
  -H "x-api-key: $NEXTBASE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "query":"latest OpenAI product updates",
    "provider":"codex",
    "model":"gpt-5.4-mini",
    "limit":5
  }'
```

## Modes

### `mode: "models"`

Returns model-backed search results, not raw Google SERP rankings.

That means:

- `gemini` uses Google Search grounding and citation metadata.
- `xai` uses xAI Agent Tools web search.
- `codex` uses OpenAI/Codex web search.
- Result order comes from provider citations/grounding, not guaranteed Google organic SERP order.

### `mode: "serp"`

Returns fresh paid Google SERP results through Serper. No cache is used.

```json
{
  "query": "latest AI news today",
  "mode": "serp",
  "limit": 10,
  "country": "us",
  "language": "en",
  "tbs": "qdr:d",
  "page": 1
}
```

SERP results include classic `index`, `title`, `url`, `display_url`, and `snippet` fields. The backend is Serper today; the response shape is provider-agnostic so it can later move to ClawSearch if needed.

## Errors

Missing query:

```json
{
  "error": {
    "type": "invalid_request_error",
    "message": "query is required"
  }
}
```

Unsupported provider:

```json
{
  "error": {
    "type": "invalid_request_error",
    "message": "provider must be one of: gemini, xai, codex"
  }
}
```

Unsupported mode:

```json
{
  "error": {
    "type": "invalid_request_error",
    "message": "mode must be one of: models, serp"
  }
}
```

## Recommended default

Use this unless you have a specific reason to choose another provider:

```json
{
  "query": "your search query",
  "provider": "gemini",
  "limit": 10
}
```

Gemini is the best default today because it has native Google Search grounding and returns structured grounding metadata.


## Serper parameter aliases

For `mode: "serp"`, Super Proxy accepts both friendly and native Serper names:

- `country` or `gl`
- `language` or `hl`
- `tbs`, `dateRange`, or `date_range`
- `page`

Examples for `tbs`:

- `qdr:d` — past day
- `qdr:w` — past week
- `qdr:m` — past month
- `qdr:y` — past year
