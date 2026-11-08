import { isToolUi } from './dom';

/**
 * Finding what's under the pointer the way it looks, for the prototyping
 * tools: past bare wrappers that only position things, and past the clear
 * parts of cut-out images stacked over one another.
 */

/**
 * Whether an element shows anything of its own: media, its own text, or a
 * fill, border or shadow. A bare wrapper only positions what's inside it.
 */
export function draws(el: Element) {
  if (el.matches('img, svg, canvas, video, picture, input, textarea, select'))
    return true;
  // Inside an SVG, every shape draws.
  if (el instanceof SVGElement) return true;
  const ownText = [...el.childNodes].some(
    (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
  );
  if (ownText) return true;
  const style = getComputedStyle(el);
  return (
    style.backgroundColor !== 'rgba(0, 0, 0, 0)' ||
    style.backgroundImage !== 'none' ||
    style.boxShadow !== 'none' ||
    parseFloat(style.borderTopWidth) > 0 ||
    parseFloat(style.borderLeftWidth) > 0
  );
}

// Each image's pixels, read once and shrunk, to look up its alpha.
const SAMPLE_SIZE = 256;
const alphaCache = new Map<
  string,
  { data: Uint8ClampedArray; w: number; h: number } | null
>();

function alphaOf(img: HTMLImageElement) {
  const src = img.currentSrc || img.src;
  if (alphaCache.has(src)) return alphaCache.get(src) ?? null;
  let sample: { data: Uint8ClampedArray; w: number; h: number } | null = null;
  try {
    const scale = Math.min(
      1,
      SAMPLE_SIZE / Math.max(img.naturalWidth, img.naturalHeight),
    );
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.drawImage(img, 0, 0, w, h);
      sample = { data: ctx.getImageData(0, 0, w, h).data, w, h };
    }
  } catch {
    // Another origin's image can't be read; it counts as solid.
  }
  alphaCache.set(src, sample);
  return sample;
}

// How near, in screen pixels, a click must land to an image's drawn pixels
// to count as on it, so small or thin cut-outs don't need a pixel-exact hit.
const PICK_SLOP = 6;

/** An element's own rotation, scale and transform, without any translation. */
function linearOf(el: Element) {
  const style = getComputedStyle(el);
  let m = new DOMMatrix();
  if (style.rotate && style.rotate !== 'none') {
    // Only turns in the page's plane, the last value when an axis is given.
    const angle = parseFloat(style.rotate.split(' ').pop() ?? '') || 0;
    m = m.rotate(
      style.rotate.includes('rad') ? (angle * 180) / Math.PI : angle,
    );
  }
  if (style.scale && style.scale !== 'none') {
    const [sx = 1, sy = sx] = style.scale.split(' ').map(parseFloat);
    m = m.scale(sx, sy);
  }
  if (style.transform && style.transform !== 'none') {
    try {
      m = m.multiply(new DOMMatrix(style.transform));
    } catch {
      // A transform DOMMatrix can't parse counts as none.
    }
  }
  return m;
}

/**
 * How an element is turned, flipped and stretched on screen, with its own
 * transforms and its ancestors' together, as a 2D matrix with no move.
 */
function screenLinearOf(el: Element) {
  let m = new DOMMatrix();
  for (let node: Element | null = el; node; node = node.parentElement)
    m = linearOf(node).multiply(m);
  return new DOMMatrix([m.a, m.b, m.c, m.d, 0, 0]);
}

/**
 * Whether an image is clear at a point on screen, so a click there belongs to
 * what's behind it. Measured on its box as drawn, with `object-fit` taken in,
 * and turned back through its own and its ancestors' rotation and flips, so a
 * tipped cut-out is read where it shows. A point within PICK_SLOP of its
 * drawn pixels counts as on it.
 */
function clearAt(img: HTMLImageElement, x: number, y: number) {
  if (!img.complete || !img.naturalWidth) return false;
  const sample = alphaOf(img);
  if (!sample) return false;
  const rect = img.getBoundingClientRect();
  const boxW = img.offsetWidth || rect.width;
  const boxH = img.offsetHeight || rect.height;
  // The box's middle lands on its bounding rect's middle under any transform,
  // so the point is taken from there back into the box's own coordinates.
  const m = screenLinearOf(img);
  // Zoom scales what's drawn without showing in the transforms.
  const zoom = rect.width / (Math.abs(m.a) * boxW + Math.abs(m.c) * boxH) || 1;
  const toBox = m.scale(zoom).inverse();
  const local = toBox.transformPoint(
    new DOMPoint(
      x - (rect.left + rect.width / 2),
      y - (rect.top + rect.height / 2),
    ),
  );
  const localX = local.x + boxW / 2;
  const localY = local.y + boxH / 2;
  // The picture's own rectangle in its box, centred as object-position does
  // by default.
  const fit = getComputedStyle(img).objectFit;
  const ratio =
    fit === 'contain' || fit === 'scale-down'
      ? Math.min(boxW / img.naturalWidth, boxH / img.naturalHeight)
      : fit === 'cover'
        ? Math.max(boxW / img.naturalWidth, boxH / img.naturalHeight)
        : null;
  const drawnW = ratio ? img.naturalWidth * ratio : boxW;
  const drawnH = ratio ? img.naturalHeight * ratio : boxH;
  // The slop in sample pixels, from the image's size on screen.
  const onScreen = Math.hypot(m.a, m.b) * zoom * drawnW || drawnW;
  const reach = Math.ceil((PICK_SLOP / onScreen) * sample.w);
  const px = Math.floor(((localX - (boxW - drawnW) / 2) / drawnW) * sample.w);
  const py = Math.floor(((localY - (boxH - drawnH) / 2) / drawnH) * sample.h);
  for (let dy = -reach; dy <= reach; dy++) {
    for (let dx = -reach; dx <= reach; dx++) {
      if (dx * dx + dy * dy > reach * reach) continue;
      const sx = px + dx;
      const sy = py + dy;
      if (sx < 0 || sy < 0 || sx >= sample.w || sy >= sample.h) continue;
      if (sample.data[(sy * sample.w + sx) * 4 + 3] >= 24) return false;
    }
  }
  return true;
}

/**
 * The first thing under a point that shows something there, skipping the
 * toolbox's own UI, bare wrappers and clear image pixels.
 */
export function pickAt(x: number, y: number) {
  const seen = new Set<Element>();
  const expand = (elements: Element[]): Element[] => elements.flatMap(el => {
    if (seen.has(el) || isToolUi(el)) return [];
    seen.add(el);
    return [...(el.shadowRoot ? expand(el.shadowRoot.elementsFromPoint(x, y)) : []), el];
  });
  return (
    expand(document.elementsFromPoint(x, y))
      .find(
        (el) =>
          !isToolUi(el) &&
          el !== document.body &&
          el !== document.documentElement &&
          draws(el) &&
          !(el instanceof HTMLImageElement && clearAt(el, x, y)),
      ) ?? null
  );
}
