// Branded HTML pages for local OAuth callback servers.
//
// These are served by the loopback HTTP servers that finish an OAuth exchange
// (MCP, Codex/ChatGPT, xAI, Snowflake, DigitalOcean, ...). The functions return
// a fully self-contained HTML string with no external assets, so they work
// offline and drop into any transport (`res.end(...)`, Effect `response.end`,
// etc.).
//
// The visual language mirrors the OC++ app: the design tokens are a curated
// subset of the OC++ V2 semantic tokens in `packages/ui/src/styles/theme.css`, and
// the wordmark is the same geometry as `packages/ui/src/components/logo.tsx`.
// Keep this file in sync with those sources when the brand changes.

export interface CallbackPageOptions {
  /** Friendly integration name shown as a subtitle, e.g. "xAI", "Snowflake", "MCP". */
  provider?: string
  /** Attempt to close the window shortly after success. Defaults to true. */
  autoClose?: boolean
}

export function success(options?: CallbackPageOptions) {
  const provider = options?.provider
  return renderDocument({
    title: "Authorization successful",
    body: renderCard({
      status: "success",
      headline: "Authorization successful",
      message: provider ? `OC++ is now connected to ${escapeHtml(provider)}.` : "OC++ is now authorized.",
      footnote: "You can close this window.",
    }),
    script: options?.autoClose === false ? undefined : AUTO_CLOSE_SCRIPT,
  })
}

export function error(detail: string, options?: CallbackPageOptions) {
  const provider = options?.provider
  return renderDocument({
    title: "Authorization failed",
    body: renderCard({
      status: "error",
      headline: "Authorization failed",
      message: provider
        ? `OC++ couldn't finish connecting to ${escapeHtml(provider)}.`
        : "OC++ couldn't complete authorization.",
      detail,
      footnote: "Close this window and try again from OC++.",
    }),
  })
}

export interface BootstrapOptions {
  /** Same-origin path the in-browser script POSTs the parsed callback to. */
  tokenPath: string
  provider?: string
}

// For flows where the credential arrives in the URL fragment (implicit grant),
// the browser must relay it back to the loopback server. This renders a pending
// page whose script reads the fragment, POSTs it to `tokenPath`, then resolves
// to the success or error state in place.
export function bootstrap(options: BootstrapOptions) {
  return renderDocument({
    title: "Finishing sign-in",
    body: renderCard({
      status: "pending",
      headline: "Finishing sign-in",
      message: options.provider
        ? `Completing your ${escapeHtml(options.provider)} authorization.`
        : "Completing authorization.",
      footnote: "You can close this window once sign-in finishes.",
    }),
    script: bootstrapScript(options),
  })
}

export * as OauthCallbackPage from "./page.js"

type Status = "pending" | "success" | "error"

function renderCard(input: { status: Status; headline: string; message: string; detail?: string; footnote: string }) {
  const detail = input.detail?.trim()
  return `<main class="card" id="ocpp-card" data-status="${input.status}" role="status" aria-live="polite">
      <div class="brand">${WORDMARK}</div>
      <div class="status" aria-hidden="true">
        <span class="icon icon-pending">${ICON_SPINNER}</span>
        <span class="icon icon-success">${ICON_CHECK}</span>
        <span class="icon icon-error">${ICON_CROSS}</span>
      </div>
      <h1 class="headline" id="ocpp-headline">${escapeHtml(input.headline)}</h1>
      <p class="message" id="ocpp-message">${input.message}</p>
      <pre class="detail" id="ocpp-detail"${detail ? "" : " hidden"}>${detail ? escapeHtml(detail) : ""}</pre>
      <p class="footnote" id="ocpp-footnote">${escapeHtml(input.footnote)}</p>
    </main>`
}

function renderDocument(input: { title: string; body: string; script?: string }) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>${escapeHtml(input.title)} · OC++</title>
    <style>${STYLES}</style>
  </head>
  <body>
    ${input.body}${input.script ? `\n    <script>${input.script}</script>` : ""}
  </body>
</html>`
}

const AUTO_CLOSE_SCRIPT = `setTimeout(function(){try{window.close()}catch(e){}},2500)`

function bootstrapScript(options: BootstrapOptions) {
  return `var PROVIDER=${scriptString(options.provider ?? "")};
var TOKEN_URL=new URL(${scriptString(options.tokenPath)},window.location.origin).href;
(function(){
  var card=document.getElementById("ocpp-card"),headline=document.getElementById("ocpp-headline"),message=document.getElementById("ocpp-message"),detail=document.getElementById("ocpp-detail"),footnote=document.getElementById("ocpp-footnote");
  function fail(text){card.dataset.status="error";headline.textContent="Authorization failed";message.textContent=PROVIDER?("OC++ couldn't finish connecting to "+PROVIDER+"."):"OC++ couldn't complete authorization.";if(text){detail.textContent=text;detail.hidden=false}footnote.textContent="Close this window and try again from OC++."}
  function ok(){card.dataset.status="success";headline.textContent="Authorization successful";message.textContent=PROVIDER?("OC++ is now connected to "+PROVIDER+"."):"OC++ is now authorized.";detail.hidden=true;footnote.textContent="You can close this window.";setTimeout(function(){try{window.close()}catch(e){}},2500)}
  try{
    var hash=new URLSearchParams((window.location.hash||"").slice(1));
    var search=new URLSearchParams(window.location.search||"");
    var err=hash.get("error")||search.get("error");
    var errDescription=hash.get("error_description")||search.get("error_description");
    var body=err?{error:err,error_description:errDescription||""}:{access_token:hash.get("access_token")||"",expires_in:hash.get("expires_in")||"0",state:hash.get("state")||""};
    fetch(TOKEN_URL,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}).then(function(res){
      if(!res.ok)return res.text().catch(function(){return""}).then(function(t){throw new Error(t||("callback failed ("+res.status+")"))});
      if(err){fail(errDescription||err);return}
      ok();
    }).catch(function(e){fail(String(e&&e.message?e.message:e))});
  }catch(e){fail(String(e&&e.message?e.message:e))}
})()`
}

function scriptString(value: string) {
  return JSON.stringify(value).replaceAll("<", "\\u003c")
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

// Curated subset of OC++ V2 tokens (packages/ui/src/styles/theme.css). Default is
// light; dark applies via prefers-color-scheme. The [data-theme] selectors let a
// host force a scheme without changing the default.
const LIGHT_VARS = `
    --ocpp-bg: #f8f8f8;
    --ocpp-card: #fcfcfc;
    --ocpp-text-strong: #171717;
    --ocpp-text-base: #6f6f6f;
    --ocpp-text-weak: #8f8f8f;
    --ocpp-border-weak: #e5e5e5;
    --ocpp-icon-strong: #171717;
    --ocpp-icon-base: #8f8f8f;
    --ocpp-icon-weak: #dbdbdb;
    --ocpp-success: #2dba26;
    --ocpp-error: #ed4831;
    --ocpp-detail-bg: #fff8f6;
    --ocpp-detail-border: #fdc3b7;
    --ocpp-shadow: 0 16px 48px -6px rgba(0,0,0,.10), 0 6px 12px -2px rgba(0,0,0,.05), 0 1px 2px rgba(0,0,0,.06);`

const DARK_VARS = `
    --ocpp-bg: #101010;
    --ocpp-card: #161616;
    --ocpp-text-strong: rgba(255,255,255,.936);
    --ocpp-text-base: rgba(255,255,255,.618);
    --ocpp-text-weak: rgba(255,255,255,.422);
    --ocpp-border-weak: #282828;
    --ocpp-icon-strong: #ededed;
    --ocpp-icon-base: #7e7e7e;
    --ocpp-icon-weak: #343434;
    --ocpp-success: #12c905;
    --ocpp-error: #fc533a;
    --ocpp-detail-bg: #28110c;
    --ocpp-detail-border: #6a1206;
    --ocpp-shadow: 0 16px 48px -6px rgba(0,0,0,.55), 0 6px 12px -2px rgba(0,0,0,.35), 0 1px 2px rgba(0,0,0,.4);`

const STYLES = `
  :root { color-scheme: light dark;${LIGHT_VARS}
    --ocpp-font-sans: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    --ocpp-font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {${DARK_VARS} } }
  :root[data-theme="dark"] {${DARK_VARS} }
  :root[data-theme="light"] {${LIGHT_VARS} }

  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body {
    min-height: 100vh;
    display: grid;
    place-items: center;
    padding: 24px;
    background: var(--ocpp-bg);
    color: var(--ocpp-text-base);
    font-family: var(--ocpp-font-sans);
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
  }
  .card {
    width: min(100%, 28rem);
    padding: 2.25rem 2rem 1.75rem;
    background: var(--ocpp-card);
    border: 1px solid var(--ocpp-border-weak);
    border-radius: 14px;
    box-shadow: var(--ocpp-shadow);
    text-align: center;
  }
  .brand { display: flex; justify-content: center; margin-bottom: 1.75rem; }
  .brand svg { height: 19px; width: auto; }
  .status { display: flex; justify-content: center; margin-bottom: 1.125rem; }
  .icon { display: none; line-height: 0; }
  .icon svg { display: block; }
  .card[data-status="pending"] .icon-pending,
  .card[data-status="success"] .icon-success,
  .card[data-status="error"] .icon-error { display: block; }
  .icon-success { color: var(--ocpp-success); }
  .icon-error { color: var(--ocpp-error); }
  .icon-pending { color: var(--ocpp-text-weak); }
  .headline { margin: 0; font-size: 1.1875rem; font-weight: 500; line-height: 1.3; letter-spacing: -0.012em; color: var(--ocpp-text-strong); }
  .message { margin: 0.5rem 0 0; font-size: 0.9375rem; color: var(--ocpp-text-base); }
  .detail {
    margin: 1.25rem 0 0;
    padding: 0.75rem 0.875rem;
    text-align: left;
    font-family: var(--ocpp-font-mono);
    font-size: 0.8125rem;
    line-height: 1.55;
    color: var(--ocpp-text-strong);
    background: var(--ocpp-detail-bg);
    border: 1px solid var(--ocpp-detail-border);
    border-radius: 8px;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 9.5rem;
    overflow: auto;
  }
  .detail[hidden] { display: none; }
  .footnote { margin: 1.5rem 0 0; font-size: 0.8125rem; color: var(--ocpp-text-weak); }
  .spinner { animation: ocpp-spin 0.8s linear infinite; transform-origin: center; }
  @keyframes ocpp-spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
`

// OC++ wordmark — same path geometry as packages/ui/src/components/logo.tsx (Logo).
const WORDMARK = `<svg class="wordmark" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 138 42" fill="none" aria-label="OC++" role="img">
        <path d="M24 36H6V12H24V36Z" fill="var(--ocpp-icon-weak)" />
        <path d="M24 6H6V36H24V6ZM30 42H0V0H30V42Z" fill="var(--ocpp-icon-base)" />
        <path d="M66 36H42V12H66V36Z" fill="var(--ocpp-icon-weak)" />
        <path d="M66 6H42V36H66V42H36V0H66V6Z" fill="var(--ocpp-icon-base)" />
        <path d="M90 6V18H102V24H90V36H84V24H72V18H84V6H90Z" fill="var(--ocpp-icon-strong)" />
        <path d="M126 6V18H138V24H126V36H120V24H108V18H120V6H126Z" fill="var(--ocpp-icon-strong)" />
      </svg>`

const ICON_CHECK = `<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9" /><path d="m8.5 12.5 2.4 2.4 4.6-5.4" /></svg>`

const ICON_CROSS = `<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9" /><path d="m9 9 6 6m0-6-6 6" /></svg>`

const ICON_SPINNER = `<svg class="spinner" viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9" opacity="0.2" /><path d="M21 12a9 9 0 0 0-9-9" /></svg>`
