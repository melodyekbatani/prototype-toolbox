/**
 * Where the toolbox lives on the host page, and how the tools tell their own
 * UI apart from the page's.
 *
 * Everything the toolbox draws sits inside one shadow root on one host
 * element. Events from inside a shadow root reach the page's listeners
 * retargeted to the host, so "is this the toolbox?" is "is this the host, or
 * anything inside its shadow root?".
 */

export const HOST_TAG = 'prototype-toolbox';
export const HOST_ATTR = 'data-prototype-toolbox';

/** The host element, plus the tools' old markers kept for pages that use them. */
export const TOOL_UI = `[${HOST_ATTR}],[data-style-tweaker],[data-figma-copy],[data-arrange-ui],[data-text-editor]`;

/** Whether a node is the toolbox's own UI rather than part of the page. */
export function isToolUi(node: unknown): boolean {
  if (!(node instanceof Node)) return false;
  // Anything rendered inside a shadow root that belongs to the toolbox.
  const root = node.getRootNode();
  if (root instanceof ShadowRoot && root.host.matches(`[${HOST_ATTR}]`))
    return true;
  const el = node instanceof Element ? node : node.parentElement;
  return Boolean(el?.closest(TOOL_UI));
}

/** The element an event really started on, through shadow roots. */
export function realTarget(event: Event): EventTarget | null {
  return event.composedPath()[0] ?? event.target;
}

/** Whether keyboard input is going into a field (the page's or the toolbox's). */
export function typingInField(event: Event) {
  const target = realTarget(event);
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      Boolean(target.closest('input, textarea, select, [contenteditable]')))
  );
}

/** Copies text, falling back to a hidden textarea where the API is refused. */
export async function writeClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const active = document.activeElement as HTMLElement | null;
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute(HOST_ATTR, '');
    area.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    try {
      document.documentElement.append(area);
      area.select();
      return document.execCommand('copy');
    } catch {
      return false;
    } finally {
      area.remove();
      active?.focus({ preventScroll: true });
    }
  }
}

export function downloadText(text: string, filename: string, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
