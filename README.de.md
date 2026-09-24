<p align="center">
  <a href="https://ocpp.ai">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="OC++ logo">
    </picture>
  </a>
</p>
<p align="center">Der Open-Source KI-Coding-Agent.</p>
<p align="center">OC++ is forked from <a href="https://github.com/anomalyco/opencode">OpenCode</a> and is an independent project, not affiliated with or endorsed by it.</p>
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

# Paketmanager
npm i -g ocpp@latest        # oder bun/pnpm/yarn
scoop install ocpp             # Windows
choco install ocpp             # Windows
brew install devagrawal09/tap/ocpp # macOS und Linux (empfohlen, immer aktuell)
brew install ocpp              # macOS und Linux (offizielle Brew-Formula, seltener aktualisiert)
sudo pacman -S ocpp            # Arch Linux (Stable)
paru -S ocpp-bin               # Arch Linux (Latest from AUR)
mise use -g ocpp               # jedes Betriebssystem
nix run nixpkgs#ocpp           # oder github:devagrawal09/oc-plus-plus für den neuesten dev-Branch
```

> [!TIP]
> Entferne Versionen älter als 0.1.x vor der Installation.

### Desktop-App (BETA)

OC++ ist auch als Desktop-Anwendung verfügbar. Lade sie direkt von der [Releases-Seite](https://github.com/devagrawal09/oc-plus-plus/releases) oder [ocpp.ai/download](https://ocpp.ai/download) herunter.

| Plattform             | Download                       |
| --------------------- | ------------------------------ |
| macOS (Apple Silicon) | `ocpp-desktop-mac-arm64.dmg`   |
| macOS (Intel)         | `ocpp-desktop-mac-x64.dmg`     |
| Windows               | `ocpp-desktop-windows-x64.exe` |
| Linux                 | `.deb`, `.rpm` oder AppImage   |

```bash
# macOS (Homebrew)
brew install --cask ocpp-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/ocpp-desktop
```

#### Installationsverzeichnis

Das Installationsskript beachtet die folgende Prioritätsreihenfolge für den Installationspfad:

1. `$OCPP_INSTALL_DIR` - Benutzerdefiniertes Installationsverzeichnis
2. `$XDG_BIN_DIR` - XDG Base Directory Specification-konformer Pfad
3. `$HOME/bin` - Standard-Binärverzeichnis des Users (falls vorhanden oder erstellbar)
4. `$HOME/.ocpp/bin` - Standard-Fallback

```bash
# Beispiele
OCPP_INSTALL_DIR=/usr/local/bin curl -fsSL https://ocpp.ai/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://ocpp.ai/install | bash
```

### Agents

OC++ enthält zwei eingebaute Agents, zwischen denen du mit der `Tab`-Taste wechseln kannst.

- **build** - Standard-Agent mit vollem Zugriff für Entwicklungsarbeit
- **plan** - Nur-Lese-Agent für Analyse und Code-Exploration
  - Verweigert Datei-Edits standardmäßig
  - Fragt vor dem Ausführen von bash-Befehlen nach
  - Ideal zum Erkunden unbekannter Codebases oder zum Planen von Änderungen

Außerdem ist ein **general**-Subagent für komplexe Suchen und mehrstufige Aufgaben enthalten.
Dieser wird intern genutzt und kann in Nachrichten mit `@general` aufgerufen werden.

Mehr dazu unter [Agents](https://ocpp.ai/docs/agents).

### Dokumentation

Mehr Infos zur Konfiguration von OC++ findest du in unseren [**Docs**](https://ocpp.ai/docs).

### Beitragen

Wenn du zu OC++ beitragen möchtest, lies bitte unsere [Contributing Docs](./CONTRIBUTING.md), bevor du einen Pull Request einreichst.

### Auf OC++ aufbauen

Wenn du an einem Projekt arbeitest, das mit OC++ zusammenhängt und "ocpp" als Teil seines Namens verwendet (z.B. "ocpp-dashboard" oder "ocpp-mobile"), füge bitte einen Hinweis in deine README ein, dass es nicht vom OC++-Team gebaut wird und nicht in irgendeiner Weise mit uns verbunden ist.

---

**Tritt unserer Community bei** [Discord](https://discord.gg/ocpp) | [X.com](https://x.com/ocpp)
