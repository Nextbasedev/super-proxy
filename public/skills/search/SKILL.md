---
name: nextbase-search
description: Use Super Proxy /v1/search for model-backed web search and paid Google SERP search via Serper.
---

# Search via Super Proxy

Full public guide: [/SEARCH.md](/SEARCH.md)

`POST /v1/search` exposes one search API for agents.

Current implementation:

- `mode: "models"` uses model-native web search/grounding through existing Super Proxy provider routes.
- `mode: "serp"` uses Serper (`google.serper.dev`) for paid Google SERP results. No cache is used.

## Request

```bash
curl "$BASE_URL/v1/search" \
  -H "Authorization: Bearer $NEXTBASE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "latest AI news today",
    "mode": "models",
    "provider": "gemini",
    "limit": 10
  }'
```

## Parameters

- `query` — required. The search query.
- `mode` — optional. Default: `models`. Use `serp` for paid Google SERP via Serper.
- `provider` — optional. One of `gemini`, `xai`, `codex`. Default: `gemini`.
- `model` — optional. Defaults by provider.
- `limit` — optional. Result cap, 1–20. Default: 10.
- `max_tokens` / `max_output_tokens` — optional provider output budget.

## Response

```json
{
  "query": "latest AI news today",
  "mode": "models",
  "provider": "gemini",
  "model": "gemini-2.5-flash-lite",
  "answer": "Concise answer from the model...",
  "results": [
    {
      "index": 1,
      "title": "Source title",
      "url": "https://example.com/article",
      "source": "grounding"
    }
  ],
  "usage": {
    "prompt_tokens": 10,
    "completion_tokens": 50,
    "total_tokens": 60
  }
}
```

## Notes

- `provider: "gemini"` uses Gemini Google Search grounding through `/v1/gemini/chat/completions`.
- `provider: "xai"` uses xAI Agent Tools web search through `/v1/xai/responses`.
- `provider: "codex"` uses OpenAI/Codex Responses web search through `/v1/responses`.
- `mode: "models"` is model-backed search. `mode: "serp"` returns fresh paid Google SERP results via Serper.


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
