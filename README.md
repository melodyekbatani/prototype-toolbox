# Prototype Toolbox

A browser toolbar extension for prototyping on real websites. Tweak styles, rearrange elements, edit copy, pin notes, and export designs or a brief for your AI coding assistant.

[Download the extension](https://github.com/melodyekbatani/prototype-toolbox/releases/latest/download/prototype-toolbox-extension.zip) · [Landing page](https://prototype-toolbox.quick.shopify.io/) · [Try the sample store](https://prototype-toolbox.quick.shopify.io/sample.html)

The landing page and sample store use Shopify sign-in. The GitHub download is public, and the installed extension works independently of the hosted site.

## Install in Chrome

1. Download the ZIP above and unzip it into a folder you will keep.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Choose **Load unpacked**, then select the folder containing `manifest.json`.
4. Pin **Prototype Toolbox** from Chrome's Extensions menu.
5. Open a website and click the toolbar icon. Click again to hide it. The shortcut is **Option+Shift+T** on Mac or **Alt+Shift+T** on Windows/Linux; Chrome's extension shortcut settings can change it.

This is a local unpacked extension, not a Chrome Web Store listing. To update, replace the unpacked files with the latest release and click **Reload** on the extension's card. Your organization may restrict extension installation.

## Tools

| Tool | What it does | Export |
| --- | --- | --- |
| Style tweaker | Change spacing, typography, colors, corners, and opacity; reset individual elements or all edits | CSS/Tailwind changes and an AI brief |
| Arranger | Drag, scale, rotate, flip, and select multiple elements; preserve original transforms when resetting | Transform values and an AI brief |
| Content editor | Click text and rewrite it; undo restores original markup and attached event listeners | Before/after text and an AI brief |
| Copy to Figma | Pick a section or the page and serialize supported visible elements into SVG | Copy SVG or download a `.svg` file for Figma |
| Annotate | Pin numbered notes to elements, edit/delete notes, follow elements while scrolling | Numbered notes and an AI brief |

**Copy for AI** works with Codex, Claude, an agent running in cmux, or another tool that accepts text or a JSON file. Add optional instructions, copy the brief, and paste it into your tool, or use **Download brief**. Each brief contains that tool's changes, the page URL/title, viewport, selectors, and implementation guidance. It does not automatically connect to, send messages to, or change files in an AI app. The assistant needs access to the relevant source project.

Selectors containing ` >>> ` cross open shadow roots: query the first segment, then query the next inside that element's `shadowRoot`.

## Compatibility and limits

- The extension uses Chrome's `activeTab` access after a toolbar click. It runs bundled code in an isolated content-script world, so normal websites with restrictive script CSPs do not need to load a remote script.
- Chrome settings, the new-tab page, extension stores, and other browser-protected pages cannot be edited. A failed launch displays an error instead of claiming success. Local file pages require Chrome's **Allow access to file URLs** option.
- Tools edit the top document and accessible open shadow roots. Embedded iframe content and closed shadow roots are not editable.
- Changes are temporary and disappear on reload. Export them before leaving. A site's own rendering can overwrite text or style edits; no persistent source change is implied.
- SVG export supports many DOM styles and text/image layers, but does not recreate arbitrary web rendering or native Figma components. Unreadable images, protected frames, canvas/video, or truncated large pages produce export warnings. Use **Download SVG** if pasting is unavailable. Browser output and valid SVG are tested; an actual Figma-app import is not part of the automated checks.
- Copy buttons report clipboard failure, and downloadable AI briefs/SVG provide a file-based fallback.
- Built for desktop pointer/keyboard use. Chrome is the tested target; other Chromium browsers may support loading the same package but are not independently certified here.

## Permissions and data

The manifest requests only `activeTab`, `scripting`, and `clipboardWrite`. There are no broad host permissions, analytics, background page scans, or remote executable code. Page content remains in the current tab unless you explicitly copy or download it. Image export may request image URLs already present on the page to embed them into the SVG.

The optional legacy bookmarklet still exists on the landing page. Strict CSPs or cross-site Shopify sign-in can block it; use the extension for those sites.

## Development

```sh
pnpm install
pnpm exec playwright install chromium
pnpm build              # production landing page, unpacked extension, ZIP
pnpm typecheck
pnpm test:extension     # real toolbar action, CSP, edits, undo, exports, failures
pnpm test               # legacy bookmarklet and responsive landing checks
pnpm test:websites      # public-site injection, actual style edit, and reset
pnpm dev                # watch + local site on http://localhost:4173
pnpm deploy             # production build + Quick deploy
```

`dist/` contains the landing page, sample store, bookmarklet bundle, and extension ZIP. `extension-dist/` is ready for **Load unpacked**. `TOOLBOX_BASE_URL` changes the legacy bookmarklet's script URL; `QUICK_SITE` changes the deployment name.

Tests use temporary browser profiles. Screenshots go to ignored `test-results/`. The public-site smoke test needs network access; markup or availability changes can require adapting its targets. The bookmarklet suite prefers Playwright's headless Chromium; `CHROME=/path/to/browser` overrides it. Use a free local port 9335 for that suite.

The extension suite checks real clipboard contents, downloaded JSON/SVG, exact style/transform reset, text undo with preserved listeners, annotations, open web components, tool switching/closing, denied clipboard access, protected-page errors, and coexistence with the landing-page demo. The sample store's product photography was generated through the Shopify image gateway; the tool examples are real screenshots of the running extension.
