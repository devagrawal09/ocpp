# OC++

OC++ is an open source AI coding agent for the terminal, the desktop, and the browser. It ships as the `ocpp` command, reads its own `ocpp.json` configuration, and is developed and released as its own product.

OC++ is forked from [OpenCode](https://github.com/anomalyco/opencode). It is an independent project: it is not an OpenCode branch, edition, or distribution, and it is not affiliated with or endorsed by the OpenCode project. Upstream Git history and the MIT license are preserved, and OpenCode retains copyright in the code inherited from it.

> [!NOTE]
> OC++ has not published release artifacts yet. The installation commands below describe the intended channels; until they are live, build from source with `bun install` and `bun run dev`.

### Code Mode

OC++ models Code Mode as an append-only durable notebook that a Session writes to by running code:

- **Automatic publication:** Every direct top-level `const` and `function` declaration is saved to the Session notebook and readable by name in later executions. There is no `export` syntax, and `return` is only a small preview.
- **Immutable names with atomic admission:** A notebook name is written once and never reused. Names are verified and reserved before an execution ID exists, so conflicts are refused immediately and disjoint executions run concurrently without a global revision gate.
- **All-or-nothing saving:** A successful program commits every declaration in one transaction; any failure, cancellation, revert, or restart saves nothing and releases its reservations.
- **Durable values, including closures:** Values are `null`, booleans, finite numbers, strings, immutable arrays, string-keyed records, and functions saved with their compiled body and exact captures. `Date`, `Map`, `Set`, and `URL` are replaced by `time` and `url` helpers that return plain data; regular expressions are unavailable.
- **One asynchronous flow:** `execute` takes source code only, returns an execution ID after admission, and delivers one bounded completion notification with status, saved names, diagnostics, and logs. Mode, model-supplied timeouts, durable result blobs, and `execution_result` paging are gone.
- **Durable lifecycle and recovery:** Executions, tool-call journals, notebook values, fork boundaries, and committed reverts are persisted by Core. Uncertain in-flight work becomes `indeterminate` instead of being replayed.
- **Scoped tool handles:** `tool.define` creates same-execution opaque handles with frozen captures and compiler-derived tool capabilities. Handles are never durable.

This design is intentionally incompatible with the earlier Promise-oriented Code Mode runtime. See the single [Code Mode guide](packages/codemode/interpreter-support.md) for architecture diagrams, examples, lifecycle semantics, limits, and the full language contract.

---

<p align="center">
  <a href="https://ocpp.ai">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="OC++ logo">
    </picture>
  </a>
</p>
<p align="center">The open source AI coding agent.</p>
<p align="center">
  <a href="https://www.npmjs.com/package/ocpp"><img alt="npm" src="https://img.shields.io/npm/v/ocpp?style=flat-square" /></a>
  <a href="https://github.com/devagrawal09/oc-plus-plus/actions/workflows/publish.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/devagrawal09/oc-plus-plus/publish.yml?style=flat-square&branch=dev" /></a>
</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh.md">简体中文</a> |
  <a href="README.zht.md">繁體中文</a> |
  <a href="README.ko.md">한국어</a> |
  <a href="README.de.md">Deutsch</a> |
  <a href="README.es.md">Español</a> |
  <a href="README.fr.md">Français</a> |
  <a href="README.it.md">Italiano</a> |
  <a href="README.da.md">Dansk</a> |
  <a href="README.ja.md">日本語</a> |
  <a href="README.pl.md">Polski</a> |
  <a href="README.ru.md">Русский</a> |
  <a href="README.bs.md">Bosanski</a> |
  <a href="README.ar.md">العربية</a> |
  <a href="README.no.md">Norsk</a> |
  <a href="README.br.md">Português (Brasil)</a> |
  <a href="README.th.md">ไทย</a> |
  <a href="README.tr.md">Türkçe</a> |
  <a href="README.uk.md">Українська</a> |
  <a href="README.bn.md">বাংলা</a> |
  <a href="README.gr.md">Ελληνικά</a> |
  <a href="README.vi.md">Tiếng Việt</a>
</p>

[![OC++ Terminal UI](packages/web/src/assets/lander/screenshot.png)](https://ocpp.ai)

---

### Installation

```bash
# YOLO
curl -fsSL https://ocpp.ai/install | bash

# Package managers
npm i -g ocpp@latest        # or bun/pnpm/yarn
scoop install ocpp             # Windows
choco install ocpp             # Windows
brew install devagrawal09/tap/ocpp # macOS and Linux (recommended, always up to date)
brew install ocpp              # macOS and Linux (official brew formula, updated less)
sudo pacman -S ocpp            # Arch Linux (Stable)
paru -S ocpp-bin               # Arch Linux (Latest from AUR)
mise use -g ocpp               # Any OS
nix run nixpkgs#ocpp           # or github:devagrawal09/oc-plus-plus for latest dev branch
```

> [!TIP]
> Remove versions older than 0.1.x before installing.

### Desktop App (BETA)

OC++ is also available as a desktop application. Download directly from the [releases page](https://github.com/devagrawal09/oc-plus-plus/releases) or [ocpp.ai/download](https://ocpp.ai/download).

| Platform              | Download                       |
| --------------------- | ------------------------------ |
| macOS (Apple Silicon) | `ocpp-desktop-mac-arm64.dmg`   |
| macOS (Intel)         | `ocpp-desktop-mac-x64.dmg`     |
| Windows               | `ocpp-desktop-windows-x64.exe` |
| Linux                 | `.deb`, `.rpm`, or `.AppImage` |

```bash
# macOS (Homebrew)
brew install --cask ocpp-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/ocpp-desktop
```

#### Installation Directory

The install script respects the following priority order for the installation path:

1. `$OCPP_INSTALL_DIR` - Custom installation directory
2. `$XDG_BIN_DIR` - XDG Base Directory Specification compliant path
3. `$HOME/bin` - Standard user binary directory (if it exists or can be created)
4. `$HOME/.ocpp/bin` - Default fallback

```bash
# Examples
OCPP_INSTALL_DIR=/usr/local/bin curl -fsSL https://ocpp.ai/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://ocpp.ai/install | bash
```

### Agents

OC++ includes two built-in agents you can switch between with the `Tab` key.

- **build** - Default, full-access agent for development work
- **plan** - Read-only agent for analysis and code exploration
  - Denies file edits by default
  - Asks permission before running bash commands
  - Ideal for exploring unfamiliar codebases or planning changes

Also included is a **general** subagent for complex searches and multistep tasks.
This is used internally and can be invoked using `@general` in messages.

Learn more about [agents](https://ocpp.ai/docs/agents).

### Documentation

For more info on how to configure OC++, [**head over to our docs**](https://ocpp.ai/docs).

### Contributing

If you're interested in contributing to OC++, please read our [contributing docs](./CONTRIBUTING.md) before submitting a pull request.

### Building on OC++

If you are working on a project that's related to OC++ and is using "ocpp" as part of its name, for example "ocpp-dashboard" or "ocpp-mobile", please add a note to your README to clarify that it is not built by the OC++ team and is not affiliated with us in any way.

---

**Join our community** [Discord](https://discord.gg/ocpp) | [X.com](https://x.com/ocpp)
