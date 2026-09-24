# OC++ Updates

The updates Worker serves all selected artifacts for a channel.

```sh
curl 'https://update.ocpp.ai/api/latest'
curl 'https://update.ocpp.ai/api/latest/cli'
curl 'https://update.ocpp.ai/api/latest/cli/npm'
```

The `/admin*` route must be protected by a Cloudflare Access self-hosted application. Configure the application with:

- Public hostname: `update.ocpp.ai`
- Path: `admin*`
- Policy: allow the OC++ team identity group

The Worker has `workers_dev` and preview URLs disabled so the custom hostname is its only public entry point.

GitHub Actions publishes artifacts through `POST /api/publish` using a short-lived OIDC token with audience `https://update.ocpp.ai`. The Worker accepts only tokens signed by GitHub for repository ID `975734319`, owner ID `66570915`, and `.github/workflows/publish.yml` on configured publishing refs.

Apply migrations and deploy from this directory:

```sh
bun run db:migrate
bun run deploy
```
