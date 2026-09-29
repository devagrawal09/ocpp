# CLI development guide

- Bare `ocpp` starts or reuses the background server and opens the web app (`packages/app`) in the browser. Other commands, such as `run`, `serve`, and `acp`, are the terminal-facing entrypoints.
- Talk to the server through `@ocpp/client` instead of adding dependencies on legacy sync state.
- Preserve established command behavior and output unless the task intentionally changes it.
