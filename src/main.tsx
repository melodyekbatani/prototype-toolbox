import { render } from 'preact';
import css from './styles.css';
import { HOST_ATTR, HOST_TAG } from './core/dom';
import {
  Toolbox,
  closeAllTools,
  isShown,
  setShown,
  setTrayOpen,
  useShown,
} from './core/toolbox';
import { StyleTweaker } from './tools/style-tweaker';
import { Arranger } from './tools/arranger';
import { TextEditor } from './tools/text-editor';
import { CopyToFigma } from './tools/figma-copy';

/**
 * The bookmarklet's payload. Loaded once per page: it makes one host element
 * with a closed-off shadow root, draws the toolbox into it, and leaves a
 * small API on `window.__prototypeToolbox` that the bookmarklet calls on
 * every later click instead of loading the script again.
 */

declare const __VERSION__: string;

type Api = {
  version: string;
  host: HTMLElement;
  /** Shows the toolbox with its tray open, or puts it away. */
  toggle(): boolean;
  open(): void;
  close(): void;
  isOpen(): boolean;
};

declare global {
  interface Window {
    __prototypeToolbox?: Api;
    __prototypeToolboxLoading?: boolean;
  }
}

function App() {
  const shown = useShown();
  // Kept mounted while hidden, so edits made so far stay listed.
  return (
    <div className="tb-app" data-shown={String(shown)}>
      <Toolbox />
      <StyleTweaker />
      <Arranger />
      <TextEditor />
      <CopyToFigma />
    </div>
  );
}

function boot(): Api {
  // A copy already running (the script loaded twice) keeps the page.
  const existing = window.__prototypeToolbox;
  if (existing) return existing;

  // Any host left behind (say, by a copy whose global was cleared) is reused.
  let host = document.querySelector<HTMLElement>(HOST_TAG);
  if (!host) {
    host = document.createElement(HOST_TAG);
    host.setAttribute(HOST_ATTR, '');
    // On <html>, not <body>, so apps that replace the body don't take it.
    document.documentElement.append(host);
  }
  // Inline so the page's CSS can't move or hide it; its children are fixed
  // to the viewport.
  host.style.cssText =
    'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;display:block;';
  const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' });

  // Constructed stylesheets aren't held to the page's style-src policy the way
  // a <style> tag is; the tag is the fallback for older browsers.
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    shadow.adoptedStyleSheets = [sheet];
  } catch {
    const style = document.createElement('style');
    style.textContent = css;
    shadow.append(style);
  }
  let mount = shadow.querySelector<HTMLElement>('.tb-mount');
  if (!mount) {
    mount = document.createElement('div');
    mount.className = 'tb-mount';
    shadow.append(mount);
  }
  render(<App />, mount);

  const api: Api = {
    version: __VERSION__,
    host,
    open() {
      setShown(true);
      setTrayOpen(true);
    },
    close() {
      closeAllTools();
      setTrayOpen(false);
      setShown(false);
    },
    isOpen: () => isShown(),
    toggle() {
      if (isShown()) api.close();
      else api.open();
      return isShown();
    },
  };
  window.__prototypeToolbox = api;
  window.__prototypeToolboxLoading = false;
  return api;
}

// Read while the script runs: a page can load it with `data-start="closed"`
// (or `data-start="tray-closed"` to show just the button).
const script = document.currentScript as HTMLScriptElement | null;
const start = script?.dataset.start;
const already = Boolean(window.__prototypeToolbox);
const api = boot();
if (!already) {
  if (start === 'closed') api.close();
  else if (start === 'tray-closed') setShown(true);
  else api.open();
}

