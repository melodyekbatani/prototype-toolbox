# Prototype Toolbox

A bookmarklet that adds a small set of prototyping tools to any web page. Use them to nudge styles, move things around, rewrite copy and copy sections into Figma. Each tool can copy out what you changed, as CSS/Tailwind, JSON or SVG layers, or as a JSON bundle for Claude.

The tools started in the Rollouts prototype (`admin-next`, branch `melody/rollout-channel-coverage`). This project holds a standalone copy, with no imports from that repo.

- Production base URL: `https://prototype-toolbox.quick.shopify.io`
- Local base URL: `http://localhost:4173`

## What came over from the Rollouts prototype

| Tool / piece | Source in the Rollouts prototype | Status | Notes |
|---|---|---|---|
| Toolbox tray (launcher button, fan-out tray, one-tool-at-a-time, draggable panels) | `prototype/toolbox` | **Generic** | Same behaviour and animation. Tailwind classes were replaced with hand-written CSS. A shown/hidden store was added so the bookmarklet can toggle the toolbox. |
| Send to Claude (`SendToRobots`) | `prototype/toolbox` | **Generic** | With no endpoint set, it copies a JSON bundle to the clipboard (labelled "Copy for Claude"). It POSTs instead when given `TOOLBOX_ROBOTS_URL` at build time or `window.__prototypeToolboxConfig.robotsUrl` at runtime. |
| Content editor | `prototype/text-editor` | **Generic** | Copied essentially as-is. Its output now includes a selector for each edit. |
| Copy to Figma | `prototype/figma-copy` | **Generic** | The Polaris/admin design-system component mapping was removed. Layers are named from the page's own tags, classes and ARIA labels. |
| Hit testing (`pickAt`, transparent-pixel skipping) | `prototype/hit-test` | **Generic** | Verbatim. Now skips the toolbox's shadow host. |
| Style tweaker | `prototype/style-tweaker` | **Adapted** | Admin DS tokens were replaced with Tailwind's default scales: a 4px spacing scale, plus Tailwind's type, weight, tracking, radius and opacity scales. Native colour pickers for text, fill and border replace `--color-*` tokens. |
| Arranger | `prototype/arranger` | **Adapted** | The `useArranger` registration, scopes, tagged objects and `data-arrange-objects` were removed. Any element can be arranged, keyed by `pathname|selector`. |
| Dev UI button | `prototype/dev-ui` | Left out | Depends on admin feature flags, a zustand store, design-system Button/Icon and motion. |
| Prototype switcher | `prototype/prototype-switcher` | Left out | Depends on react-router, feature flags and the list of Rollouts prototypes. |
| Audience mix / versions bar | `rollouts/*` | Left out | Rollouts data, versions store, recharts. |
| Version history | `rollouts/*` | Left out | Depends on the router, audience versions and feature flags. |
| Welcome switcher (empty-versions tray slot) | `rollouts-empty-versions` | Left out | Sets a Rollouts-only flag. |

## Commands

```sh
pnpm install          # esbuild, preact, typescript (dev deps only)
pnpm build            # dist/ for production: bookmarklet loads from prototype-toolbox.quick.shopify.io
pnpm build:local      # dist/ with the bookmarklet pointed at http://localhost:4173
pnpm dev              # local build + watch + serve on http://localhost:4173
pnpm serve            # serve dist/ on :4173 (no build)
pnpm typecheck
pnpm test             # local build, then the headless-Chrome checks (see below)
pnpm deploy           # build + `quick deploy dist prototype-toolbox` (QUICK_SITE overrides the name)
```

`TOOLBOX_BASE_URL` sets the URL the bookmarklet loads `toolbox.js` from, and `TOOLBOX_ROBOTS_URL` sets an optional POST endpoint for "Send to Claude".

`dist/` contains:

- `index.html`: the landing page
- `sample.html` and `sample-assets/`: a mock storefront to try the tools on
- `toolbox.js`: the bundle
- `bookmarklet.txt`: the bookmarklet's `javascript:` URL

## Install

1. Show the bookmarks bar: ⌘⇧B on Mac or Ctrl⇧B on Windows, in Chrome, Edge, Arc or Firefox. In Safari, choose View › Show Favorites Bar.
2. Drag the **Prototype toolbox** button from the landing page onto the bar.
3. On any page, click the bookmark to open the toolbox, and click it again to put it away.

To set it up by hand, create a bookmark named "Prototype toolbox". Paste the code from the landing page's "Or add it by hand" box (it has a Copy button) as its URL.

## How it works

- **One IIFE, about 100 KB minified (about 35 KB gzipped).** It is built with esbuild and uses Preact through `preact/compat`. Preact takes about 24 KB of the bundle, where React 19 would add about 190 KB, and it is a lighter guest on someone else's page. The bundle has no Tailwind runtime: `src/styles.css` is minified into the bundle as a string.
- **Shadow DOM isolation.** Everything renders inside one open shadow root on a `<prototype-toolbox data-prototype-toolbox>` element.
  - The host element is appended to `<html>` and styled `all: initial; position: fixed; z-index: 2147483647`.
  - Styles go in through `adoptedStyleSheets`, which page CSPs don't restrict. A `<style>` element is the fallback.
  - The page's CSS can't reach the tools, and the tools' CSS can't reach the page. The test checks this against the sample page's `button, div, span { font-family: Georgia }` rule.
  - Because of shadow DOM retargeting, page listeners see toolbox events as coming from the host element. `isToolUi()` and `composedPath()` keep each tool from treating the toolbox's own UI as page content.
- **One global.** `window.__prototypeToolbox` is `{ version, host, toggle(), open(), close(), isOpen() }`. Closing closes any open tool, folds the tray and hides the app. It stays mounted, so the lists of edits survive a close/open.
- **Bookmarklet logic** (`scripts/bookmarklet.js`, minified into `dist/bookmarklet.txt`):
  1. If `window.__prototypeToolbox` exists, call `toggle()`. Nothing is injected.
  2. Otherwise, if the toolbox is already loading (the `__prototypeToolboxLoading` flag is set, or a `script[data-prototype-toolbox-script]` exists), do nothing. This makes a quick double-click safe.
  3. Otherwise, add one `<script data-prototype-toolbox-script>` from the base URL, with an hourly `?h=` cache-buster. The script opens the toolbox when it boots.
  4. If the script fails, show a short alert saying the page's CSP probably blocks it, then remove the tag and the flag. Failure means any of: `onerror`, loading without defining the global, a 15 s timeout, or a Trusted Types `TypeError`.

  `boot()` also reuses an existing host element or global, so even a second copy of the script can't add a second toolbox.
- A page can add the script itself with `data-start="closed"` or `"tray-closed"`. The landing page uses `"tray-closed"` on phones.

## Known limitations

- **Strict Content Security Policy.** Sites that only allow their own scripts block the bookmarklet, and you get the alert instead. Examples include GitHub, Google Docs and Gmail, banking sites and many admin sites.
- **Nothing is saved.** Every change lives in the open tab and is gone on reload. Copy your changes out first.
- **Iframes.** The tools reach the top page only.
- **Shadow DOM-heavy pages.** Pages built from web components keep their insides closed off, so the pickers usually stop at the component's outer box.
- **Re-rendering SPAs.** Single-page apps can re-render text and styles you've edited. The Arranger reapplies its moves, but text and style edits can be lost.
- **Hosted behind SSO.** If the base URL needs a login cookie, other sites can't load `toolbox.js`, because the cookie isn't sent cross-site. The bookmarklet needs a publicly readable host.
- **Cross-origin images** without CORS can't be read. Copy to Figma shows them as grey boxes, and the pickers treat them as solid.
- **Desktop browsers.** The tools are built for a mouse and keyboard.

## Tests

`pnpm test` runs `test/run.mjs`, a dependency-free DevTools-protocol script.

**Setup**

- It serves `dist/` on :4173, plus two strict-CSP pages on :4174.
- It starts headless Chrome on port 9335 with a fresh profile, killing any leftover instance first.
- It prefers Playwright's unmanaged `chrome-headless-shell` when one is installed. On this machine, the admin policy on managed Google Chrome switches remote debugging off a few seconds after launch. `CHROME=/path/to/chrome` overrides the choice.

**What it checks**

- Bookmarklet clicks:
  - It runs the bookmarklet's code with `Runtime.evaluate`, which is what clicking it does.
  - Three clicks give open, closed, then open, with one host and one script tag throughout.
  - A double click before the script has loaded still gives one of each.
- Real mouse and keyboard input drive each tool.
- The CSP and Trusted Types pages give the alert and leave the page clean.
- On the landing page:
  - the live toolbox is present;
  - the bookmarklet href and the manual install code match;
  - the page doesn't scroll sideways at desktop width or at 390px.

**Screenshots** go to `screenshots/`.
