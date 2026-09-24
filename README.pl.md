<p align="center">
  <a href="https://ocpp.ai">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="OC++ logo">
    </picture>
  </a>
</p>
<p align="center">Otwartoźródłowy agent kodujący AI.</p>
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

### Instalacja

```bash
# YOLO
curl -fsSL https://ocpp.ai/install | bash

# Menedżery pakietów
npm i -g ocpp@latest        # albo bun/pnpm/yarn
scoop install ocpp             # Windows
choco install ocpp             # Windows
brew install devagrawal09/tap/ocpp # macOS i Linux (polecane, zawsze aktualne)
brew install ocpp              # macOS i Linux (oficjalna formuła brew, rzadziej aktualizowana)
sudo pacman -S ocpp            # Arch Linux (Stable)
paru -S ocpp-bin               # Arch Linux (Latest from AUR)
mise use -g ocpp               # dowolny system
nix run nixpkgs#ocpp           # lub github:devagrawal09/oc-plus-plus dla najnowszej gałęzi dev
```

> [!TIP]
> Przed instalacją usuń wersje starsze niż 0.1.x.

### Aplikacja desktopowa (BETA)

OC++ jest także dostępny jako aplikacja desktopowa. Pobierz ją bezpośrednio ze strony [releases](https://github.com/devagrawal09/oc-plus-plus/releases) lub z [ocpp.ai/download](https://ocpp.ai/download).

| Platforma             | Pobieranie                     |
| --------------------- | ------------------------------ |
| macOS (Apple Silicon) | `ocpp-desktop-mac-arm64.dmg`   |
| macOS (Intel)         | `ocpp-desktop-mac-x64.dmg`     |
| Windows               | `ocpp-desktop-windows-x64.exe` |
| Linux                 | `.deb`, `.rpm` lub AppImage    |

```bash
# macOS (Homebrew)
brew install --cask ocpp-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/ocpp-desktop
```

#### Katalog instalacji

Skrypt instalacyjny stosuje następujący priorytet wyboru ścieżki instalacji:

1. `$OCPP_INSTALL_DIR` - Własny katalog instalacji
2. `$XDG_BIN_DIR` - Ścieżka zgodna ze specyfikacją XDG Base Directory
3. `$HOME/bin` - Standardowy katalog binarny użytkownika (jeśli istnieje lub można go utworzyć)
4. `$HOME/.ocpp/bin` - Domyślny fallback

```bash
# Przykłady
OCPP_INSTALL_DIR=/usr/local/bin curl -fsSL https://ocpp.ai/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://ocpp.ai/install | bash
```

### Agents

OC++ zawiera dwóch wbudowanych agentów, między którymi możesz przełączać się klawiszem `Tab`.

- **build** - Domyślny agent z pełnym dostępem do pracy developerskiej
- **plan** - Agent tylko do odczytu do analizy i eksploracji kodu
  - Domyślnie odmawia edycji plików
  - Pyta o zgodę przed uruchomieniem komend bash
  - Idealny do poznawania nieznanych baz kodu lub planowania zmian

Dodatkowo jest subagent **general** do złożonych wyszukiwań i wieloetapowych zadań.
Jest używany wewnętrznie i można go wywołać w wiadomościach przez `@general`.

Dowiedz się więcej o [agents](https://ocpp.ai/docs/agents).

### Dokumentacja

Więcej informacji o konfiguracji OC++ znajdziesz w [**dokumentacji**](https://ocpp.ai/docs).

### Współtworzenie

Jeśli chcesz współtworzyć OC++, przeczytaj [contributing docs](./CONTRIBUTING.md) przed wysłaniem pull requesta.

### Budowanie na OC++

Jeśli pracujesz nad projektem związanym z OC++ i używasz "ocpp" jako części nazwy (na przykład "ocpp-dashboard" lub "ocpp-mobile"), dodaj proszę notatkę do swojego README, aby wyjaśnić, że projekt nie jest tworzony przez zespół OC++ i nie jest z nami w żaden sposób powiązany.

---

**Dołącz do naszej społeczności** [Discord](https://discord.gg/ocpp) | [X.com](https://x.com/ocpp)
