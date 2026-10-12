# net-utils
- `getJson(url)` fetches and parses JSON with retries.
- `retryWithJitter(fn)` wraps any async fn with jittered exponential backoff; `getJson` uses it internally.
