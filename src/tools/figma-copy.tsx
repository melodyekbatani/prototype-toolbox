import React from 'react';
import { ToolboxItem, useToolboxExclusive } from '../core/toolbox';
import { TOOL_UI, isToolUi, writeClipboard, downloadText, realTarget } from '../core/dom';

/**
 * Copy to Figma: pick a section of the page (or take the whole page) and copy
 * it as SVG. Pasted into Figma (⌘V), it becomes editable layers: frames as
 * named groups, text as text, images as fills. The full layer tree also rides
 * along base64-encoded in the SVG's <metadata>, for a Figma plugin that wants
 * to rebuild it with auto layout and tokens.
 *
 * Copied from the Rollouts prototype nearly as-is: it only reads what the
 * browser drew. The one Admin-specific part, mapping the design system's
 * React components (Button, Badge) to Polaris components, is left out.
 */

const SKIP = TOOL_UI;
const MAX_LAYERS = 3000;
// A whole page runs to far more layers than a section.
const MAX_PAGE_LAYERS = 12000;
const captureWarnings = new Set<string>();

// ---- The copied section (the plugin reads this shape; bump `v` if it changes)

type RGBA4 = [number, number, number, number];
type Sides = [number, number, number, number];
type Shadow = {
  inset: boolean;
  x: number;
  y: number;
  blur: number;
  spread: number;
  c: RGBA4;
};
type Font = {
  families: string[];
  size: number;
  weight: number;
  italic: boolean;
  lh: number | null;
  ls: number;
  align: 'left' | 'center' | 'right' | 'justify';
  c: RGBA4;
  deco?: 'underline' | 'strike';
};
type Layout = {
  dir: 'row' | 'column';
  gap: number;
  pad: Sides;
  main: 'start' | 'center' | 'end' | 'between';
  cross: 'start' | 'center' | 'end' | 'baseline' | 'stretch';
};
type Grad = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  stops: { c: RGBA4; p: number }[];
};
type Comp = {
  name: string;
  props: Record<string, string>;
  label: string;
  prefix: boolean;
  suffix: boolean;
};
type Layer = {
  t: 'frame' | 'text' | 'svg';
  n: string;
  x: number;
  y: number;
  w: number;
  h: number;
  abs?: boolean;
  o?: number;
  /** Degrees turned about its centre; x/y/w/h are its unturned box. */
  rot?: number;
  fill?: RGBA4;
  bg?: Grad[];
  stroke?: { c: RGBA4; w: Sides; style: 'solid' | 'dashed' | 'dotted' };
  r?: Sides;
  fx?: Shadow[];
  clip?: boolean;
  layout?: Layout;
  kids?: Layer[];
  comp?: Comp;
  s?: string;
  font?: Font;
  wrap?: boolean;
  svg?: string;
  img?: Img;
};
/** An <img>'s pixels as a data URL, at its untransformed size and rotation. */
type Img = {
  src: string;
  w: number;
  h: number;
  rot: number;
  fit: 'cover' | 'contain' | 'fill';
  align: string;
};

// ---- Frames

type Ctor = abstract new (...args: never[]) => unknown;
/** instanceof that also knows nodes from a same-origin iframe, built from that frame's own classes. */
function isA<C extends Ctor>(node: unknown, ctor: C): node is InstanceType<C> {
  if (node instanceof ctor) return true;
  const view = (node as Node | null)?.ownerDocument?.defaultView as
    | (Window & Record<string, unknown>)
    | null
    | undefined;
  const own = view && (view as unknown) !== window ? view[ctor.name] : undefined;
  return typeof own === 'function' && node instanceof (own as C);
}
/** A same-origin iframe's document; null for cross-origin or unloaded frames. */
function frameDocument(el: Element) {
  if (!isA(el, HTMLIFrameElement)) return null;
  try {
    return el.contentDocument?.body ? el.contentDocument : null;
  } catch {
    return null;
  }
}

// ---- Colours

const colorCache = new Map<string, RGBA4 | null>();
let colorContext: CanvasRenderingContext2D | null = null;

/** Any CSS colour as 0–255 channels, via a 1px canvas for oklch and friends. */
function toRgba(value: string): RGBA4 | null {
  if (
    !value ||
    value === 'none' ||
    value === 'transparent' ||
    value.startsWith('url(')
  )
    return null;
  const cached = colorCache.get(value);
  if (cached !== undefined) return cached;
  let out: RGBA4 | null = null;
  const match = value.match(
    /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/,
  );
  if (match) {
    const alpha =
      match[4] === undefined
        ? 1
        : match[4].endsWith('%')
          ? parseFloat(match[4]) / 100
          : parseFloat(match[4]);
    out = [+match[1], +match[2], +match[3], alpha];
  } else {
    colorContext ??= document
      .createElement('canvas')
      .getContext('2d', { willReadFrequently: true });
    if (colorContext) {
      colorContext.clearRect(0, 0, 1, 1);
      colorContext.fillStyle = '#000';
      colorContext.fillStyle = value;
      colorContext.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = colorContext.getImageData(0, 0, 1, 1).data;
      out = [r, g, b, Math.round((a / 255) * 1000) / 1000];
    }
  }
  if (out && out[3] === 0) out = null;
  colorCache.set(value, out);
  return out;
}

/** Splits on commas outside brackets, for shadow and font lists. */
function splitTop(value: string, separator = ',') {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of value) {
    if (char === '(') depth++;
    if (char === ')') depth--;
    if (char === separator && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

const COLOR =
  /(rgba?|oklch|oklab|lab|lch|hsla?|color)\([^)]*\)|#[0-9a-f]{3,8}\b|\b(transparent|white|black)\b/i;

/** filter: drop-shadow(…) as shadows, so a cut-out image keeps its own. */
function dropShadows(value: string): Shadow[] {
  if (!value || value === 'none') return [];
  return [...value.matchAll(/drop-shadow\(((?:[^()]|\([^)]*\))*)\)/g)].flatMap(
    (m) => shadows(m[1]),
  );
}

function shadows(value: string): Shadow[] {
  if (!value || value === 'none') return [];
  const out: Shadow[] = [];
  for (const part of splitTop(value)) {
    const color = part.match(COLOR)?.[0] ?? 'black';
    const rest = part.replace(color, ' ');
    const lengths = [...rest.matchAll(/-?[\d.]+px|\b0\b/g)].map((m) =>
      parseFloat(m[0]),
    );
    const c = toRgba(color);
    if (!c || lengths.length < 2) continue;
    const [x, y, blur = 0, spread = 0] = lengths;
    out.push({ inset: /\binset\b/.test(rest), x, y, blur, spread, c });
  }
  return out;
}

const SIDES: Record<string, number> = {
  'to top': 0,
  'to right': 90,
  'to bottom': 180,
  'to left': 270,
};

/** Linear-gradient backgrounds as 0–1 box vectors, topmost first. */
function gradients(value: string): Grad[] {
  if (!value || value === 'none') return [];
  const out: Grad[] = [];
  for (const layer of splitTop(value)) {
    const inner = layer.match(/^linear-gradient\((.*)\)$/)?.[1];
    if (!inner) continue;
    const parts = splitTop(inner);
    let angle = 180;
    if (/^to /.test(parts[0]) || /deg$/.test(parts[0])) {
      const first = parts.shift() as string;
      angle = first.endsWith('deg') ? parseFloat(first) : (SIDES[first] ?? 180);
    }
    const stops = parts.map((part, i) => {
      const color = part.match(COLOR)?.[0] ?? part;
      const at = part.replace(color, '').match(/(-?[\d.]+)%/);
      const c: RGBA4 = toRgba(color) ?? [0, 0, 0, 0];
      return {
        c,
        p: at ? parseFloat(at[1]) / 100 : i / (parts.length - 1 || 1),
      };
    });
    // A transparent stop fades its neighbour's colour, not black.
    stops.forEach((stop, i) => {
      if (stop.c[3] > 0) return;
      const near = stops[i + 1]?.c[3] ? stops[i + 1] : stops[i - 1];
      if (near) stop.c = [near.c[0], near.c[1], near.c[2], 0];
    });
    const rad = (angle * Math.PI) / 180;
    const dx = Math.sin(rad) / 2;
    const dy = -Math.cos(rad) / 2;
    out.push({
      x1: round(0.5 - dx),
      y1: round(0.5 - dy),
      x2: round(0.5 + dx),
      y2: round(0.5 + dy),
      stops,
    });
  }
  return out;
}

// ---- Backgrounds SVG can't carry as vectors
//
// url() images and radial gradients (dot grids, patterned tiles) are drawn
// into one image per element, tiled the way CSS tiles them, and copied as an
// image layer of their own. Linear gradients stay vectors unless they share a
// stack with one of these.

const RASTER = /url\(|radial-gradient\(/;
const bgImages = new Map<string, HTMLImageElement | null>();
const urlsIn = (value: string) =>
  [...value.matchAll(/url\((?:"([^"]*)"|'([^']*)'|([^)]*))\)/g)].map(
    (m) => m[1] ?? m[2] ?? m[3],
  );

/** Every url() background in the section, decoded, so copying can draw them synchronously. */
async function loadBackgrounds(el: Element) {
  const urls = new Set<string>();
  const nodes: Element[] = [el, ...el.querySelectorAll('*')];
  for (const node of nodes) {
    if (node.matches(SKIP)) continue;
    const doc = frameDocument(node);
    if (doc) nodes.push(...doc.documentElement.querySelectorAll('*'));
    for (const pseudo of [null, '::before', '::after'])
      for (const url of urlsIn(getComputedStyle(node, pseudo).backgroundImage))
        urls.add(url);
  }
  await Promise.all(
    [...urls]
      .filter((url) => !bgImages.has(url))
      .map(async (url) => {
        const img = new Image();
        img.src = url;
        try {
          await Promise.race([img.decode(), new Promise((_, reject) => setTimeout(() => reject(new Error('Image timed out')), 5000))]);
          bgImages.set(url, img);
        } catch {
          bgImages.set(url, null);
          captureWarnings.add('Some background images could not be read.');
        }
      }),
  );
}

/** One axis of a background size or position: px, %, or null for auto. */
function length(value: string | undefined, of: number) {
  if (!value || value === 'auto') return null;
  return value.endsWith('%') ? (parseFloat(value) / 100) * of : px(value);
}

function tileSize(size: string, w: number, h: number, nw: number, nh: number) {
  if (size === 'cover' || size === 'contain') {
    const scale = (size === 'cover' ? Math.max : Math.min)(w / nw, h / nh);
    return [nw * scale, nh * scale];
  }
  const [a, b] = size.split(' ');
  let tw = length(a, w);
  let th = length(b ?? 'auto', h);
  if (tw === null && th === null) return [nw, nh];
  tw ??= ((th as number) * nw) / nh;
  th ??= (tw * nh) / nw;
  return [tw, th];
}

/** A radial gradient drawn into a tile, as CSS sizes and places it. */
function radialTile(layer: string, tw: number, th: number, scale: number) {
  const inner = layer.match(/^radial-gradient\((.*)\)$/)?.[1];
  if (!inner) return null;
  const parts = splitTop(inner);
  let config = '';
  if (!COLOR.test(parts[0]) || /^(circle|ellipse|closest|farthest|at )/.test(parts[0]))
    config = parts.shift() as string;
  const at = config.match(/at (\S+)(?: (\S+))?/);
  const cx = length(at?.[1] ?? '50%', tw) ?? tw / 2;
  const cy = length(at?.[2] ?? at?.[1] ?? '50%', th) ?? th / 2;
  const sides = [cx, tw - cx, cy, th - cy].map(Math.abs);
  const sizeWord = config.match(/(closest|farthest)-(side|corner)/)?.[0] ?? 'farthest-corner';
  const pickX = sizeWord.startsWith('closest') ? Math.min(sides[0], sides[1]) : Math.max(sides[0], sides[1]);
  const pickY = sizeWord.startsWith('closest') ? Math.min(sides[2], sides[3]) : Math.max(sides[2], sides[3]);
  const explicit = [...config.replace(/at .*/, '').matchAll(/-?[\d.]+(px|%)/g)].map((m) =>
    length(m[0], tw) ?? 0,
  );
  const circle = /circle/.test(config) || explicit.length === 1;
  let rx: number;
  let ry: number;
  if (explicit.length) [rx, ry] = [explicit[0], explicit[1] ?? explicit[0]];
  else if (circle) {
    const side = sizeWord.endsWith('side')
      ? (sizeWord.startsWith('closest') ? Math.min : Math.max)(...sides)
      : Math.hypot(pickX, pickY);
    rx = ry = side;
  } else {
    const k = sizeWord.endsWith('corner') ? Math.SQRT2 : 1;
    [rx, ry] = [pickX * k, pickY * k];
  }
  if (!rx || !ry) return null;
  const stops = parts.map((part, i) => {
    const color = part.match(COLOR)?.[0] ?? part;
    const at = part.replace(color, '').trim().split(/\s+/)[0];
    const c: RGBA4 = toRgba(color) ?? [0, 0, 0, 0];
    const p = at
      ? at.endsWith('%')
        ? parseFloat(at) / 100
        : px(at) / rx
      : i / (parts.length - 1 || 1);
    return { c, p };
  });
  stops.forEach((stop, i) => {
    stop.p = Math.min(1, Math.max(stop.p, stops[i - 1]?.p ?? 0, 0));
    if (stop.c[3] > 0) return;
    const near = stops[i + 1]?.c[3] ? stops[i + 1] : stops[i - 1];
    if (near) stop.c = [near.c[0], near.c[1], near.c[2], 0];
  });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(tw * scale));
  canvas.height = Math.max(1, Math.round(th * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.scale(scale, scale);
  // An ellipse is a circle squashed on y.
  ctx.translate(cx, cy);
  ctx.scale(1, ry / rx);
  const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
  for (const s of stops)
    grad.addColorStop(s.p, `rgba(${s.c[0]},${s.c[1]},${s.c[2]},${s.c[3]})`);
  ctx.fillStyle = grad;
  ctx.fillRect(-cx, (-cy * rx) / ry, tw, (th * rx) / ry);
  return canvas;
}

/** A linear gradient drawn into a tile (only when it sits in a stack with raster layers). */
function linearTile(layer: string, tw: number, th: number, scale: number) {
  const [grad] = gradients(layer);
  if (!grad) return null;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(tw * scale));
  canvas.height = Math.max(1, Math.round(th * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.scale(scale, scale);
  const g = ctx.createLinearGradient(grad.x1 * tw, grad.y1 * th, grad.x2 * tw, grad.y2 * th);
  for (const s of grad.stops)
    g.addColorStop(Math.min(1, Math.max(0, s.p)), `rgba(${s.c[0]},${s.c[1]},${s.c[2]},${s.c[3]})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, tw, th);
  return canvas;
}

/**
 * The element's background-image stack as one PNG, tiled and placed as CSS
 * draws it; null when it has nothing SVG can't already carry.
 */
/** Pixels drawn per CSS pixel: 2 on the page, less inside a shrunk iframe. */
let density = 2;

function rasterBackground(cs: CSSStyleDeclaration, w: number, h: number) {
  const value = cs.backgroundImage;
  if (!value || value === 'none' || !RASTER.test(value) || w < 1 || h < 1) return null;
  const scale = density;
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(w * scale);
  canvas.height = Math.ceil(h * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.scale(scale, scale);
  const layers = splitTop(value);
  const sizes = splitTop(cs.backgroundSize);
  const positions = splitTop(cs.backgroundPosition);
  const repeats = splitTop(cs.backgroundRepeat);
  const pick = (list: string[], i: number, fallback: string) =>
    list[i % (list.length || 1)] ?? fallback;
  let drew = false;
  // CSS lists the top layer first; paint from the bottom up.
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i];
    const size = pick(sizes, i, 'auto');
    let tile: CanvasImageSource | null = null;
    let tw: number;
    let th: number;
    if (layer.startsWith('url(')) {
      const img = bgImages.get(urlsIn(layer)[0]);
      if (!img?.naturalWidth) continue;
      [tw, th] = tileSize(size, w, h, img.naturalWidth, img.naturalHeight);
      tile = img;
    } else {
      [tw, th] = tileSize(size, w, h, w, h);
      tile = layer.startsWith('radial-gradient(')
        ? radialTile(layer, tw, th, scale)
        : layer.startsWith('linear-gradient(')
          ? linearTile(layer, tw, th, scale)
          : null;
    }
    if (!tile || tw < 0.5 || th < 0.5) continue;
    const [posX = '0%', posY = posX] = pick(positions, i, '0% 0%').split(' ');
    const x0 = posX.endsWith('%') ? ((w - tw) * parseFloat(posX)) / 100 : px(posX);
    const y0 = posY.endsWith('%') ? ((h - th) * parseFloat(posY)) / 100 : px(posY);
    const repeat = pick(repeats, i, 'repeat');
    const [repX, repY] =
      repeat === 'repeat-x'
        ? ['repeat', 'no-repeat']
        : repeat === 'repeat-y'
          ? ['no-repeat', 'repeat']
          : [repeat.split(' ')[0], repeat.split(' ')[1] ?? repeat.split(' ')[0]];
    const xs: number[] = [];
    const ys: number[] = [];
    if (repX === 'no-repeat') xs.push(x0);
    else for (let x = (x0 % tw) - (x0 % tw > 0 ? tw : 0); x < w; x += tw) xs.push(x);
    if (repY === 'no-repeat') ys.push(y0);
    else for (let y = (y0 % th) - (y0 % th > 0 ? th : 0); y < h; y += th) ys.push(y);
    if (xs.length * ys.length > 40000) continue;
    try {
      for (const x of xs) for (const y of ys) ctx.drawImage(tile, x, y, tw, th);
      drew = true;
    } catch {
      // An image that won't draw (broken, or cross-origin SVG) is left out.
    }
  }
  if (!drew) return null;
  try {
    return canvas.toDataURL('image/png');
  } catch {
    return null; // A cross-origin image tainted the canvas.
  }
}

// ---- Names and components

type Fiber = {
  type: unknown;
  memoizedProps: Record<string, unknown>;
  return: Fiber | null;
};

function fiberOf(el: Element): Fiber | null {
  const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
  return key ? ((el as unknown as Record<string, Fiber>)[key] ?? null) : null;
}

function typeName(type: unknown): string | null {
  if (typeof type === 'function')
    return (
      (type as { displayName?: string; name?: string }).displayName ||
      type.name ||
      null
    );
  if (type && typeof type === 'object') {
    const t = type as {
      displayName?: string;
      render?: { name?: string };
      type?: unknown;
    };
    return (
      t.displayName || t.render?.name || (t.type ? typeName(t.type) : null)
    );
  }
  return null;
}

/** The components this element is the outermost DOM node of, innermost first. */
function ownComponents(el: Element) {
  const out: { name: string; props: Record<string, unknown> }[] = [];
  let fiber = fiberOf(el)?.return ?? null;
  while (fiber && typeof fiber.type !== 'string') {
    const name = typeName(fiber.type);
    if (name) out.push({ name, props: fiber.memoizedProps ?? {} });
    fiber = fiber.return;
  }
  return out;
}

function layerName(el: Element) {
  const bem = [...el.classList].find(
    (c) =>
      c.includes('__') ||
      c.includes('--') ||
      c.startsWith('rf-') ||
      c.startsWith('rf'),
  );
  if (bem)
    return (
      bem.replace(/^rf-?/, '').replace(/__/g, ' / ').replace(/--/g, ' · ') ||
      bem
    );
  const component = ownComponents(el).find(
    (c) => !/^(motion|m|Motion)/.test(c.name),
  );
  if (component) return component.name;
  const label = el.getAttribute('aria-label') ?? el.getAttribute('data-name');
  if (label) return label;
  // Images by their alt text or file name ("camera"), not all "img".
  if (isA(el, HTMLImageElement)) {
    const file = (el.currentSrc || el.src).split(/[?#]/)[0].split('/').pop();
    const stem = el.src.startsWith('data:') ? '' : decodeURIComponent(file ?? '').replace(/\.\w+$/, '');
    if (el.alt || stem) return el.alt || stem;
  }
  return el.tagName.toLowerCase();
}

// ---- Serializing

type Ctx = { count: number; max: number };

const px = (value: string) => parseFloat(value) || 0;
const round = (value: number) => Math.round(value * 100) / 100;

function box(el: Element, origin: DOMRect) {
  const r = el.getBoundingClientRect();
  return {
    x: round(r.left - origin.left),
    y: round(r.top - origin.top),
    w: round(r.width),
    h: round(r.height),
    rect: r,
  };
}

function fontOf(cs: CSSStyleDeclaration, color?: string): Font {
  const size = px(cs.fontSize);
  const deco = cs.textDecorationLine;
  return {
    families: splitTop(cs.fontFamily).map((f) => f.replace(/^['"]|['"]$/g, '')),
    size,
    weight: Math.round(px(cs.fontWeight) / 100) * 100 || 400,
    italic: cs.fontStyle === 'italic',
    lh: cs.lineHeight === 'normal' ? null : round(px(cs.lineHeight)),
    ls: cs.letterSpacing === 'normal' ? 0 : round(px(cs.letterSpacing)),
    align:
      cs.textAlign === 'center'
        ? 'center'
        : cs.textAlign === 'right' || cs.textAlign === 'end'
          ? 'right'
          : cs.textAlign === 'justify'
            ? 'justify'
            : 'left',
    c: toRgba(color ?? cs.color) ?? [0, 0, 0, 1],
    ...(deco.includes('underline') && { deco: 'underline' as const }),
    ...(deco.includes('line-through') && { deco: 'strike' as const }),
  };
}

function transform(text: string, cs: CSSStyleDeclaration) {
  if (cs.textTransform === 'uppercase') return text.toUpperCase();
  if (cs.textTransform === 'lowercase') return text.toLowerCase();
  if (cs.textTransform === 'capitalize')
    return text.replace(/\b\w/g, (c) => c.toUpperCase());
  return text;
}

/** A run of text as one layer, sized to its lines. */
function textLayer(
  node: Text,
  parent: HTMLElement,
  origin: DOMRect,
  ctx: Ctx,
): Layer | null {
  const cs = getComputedStyle(parent);
  const pre = /^pre/.test(cs.whiteSpace);
  const raw = node.textContent ?? '';
  const text = pre ? raw : raw.replace(/\s+/g, ' ');
  if (!text.trim()) return null;
  const range = document.createRange();
  range.selectNodeContents(node);
  const rect = range.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const lines =
    new Set(
      [...range.getClientRects()]
        .filter((r) => r.width > 0)
        .map((r) => Math.round(r.top)),
    ).size || 1;
  const font = fontOf(cs);
  const lh = font.lh ?? font.size * 1.2;
  const h = lh * lines;
  ctx.count++;
  return {
    t: 'text',
    n: text.trim().slice(0, 40),
    x: round(rect.left - origin.left),
    y: round(rect.top + rect.height / 2 - h / 2 - origin.top),
    w: round(rect.width),
    h: round(h),
    s: transform(pre ? text : text.trim(), cs),
    font,
    ...(lines > 1 && { wrap: true }),
  };
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Figma can't import pattern fills, so each shape filled with a pattern
 * becomes the pattern's tiles, drawn out across the shape and clipped to it.
 * Tiles that are full-height vertical rules (hatching) join into one rule per
 * column.
 */
function expandPatterns(
  el: SVGSVGElement,
  source: Element[],
  target: Element[],
  clone: SVGSVGElement,
) {
  let defs = clone.querySelector('defs');
  let n = 0;
  target.forEach((out, i) => {
    const id = out.getAttribute('fill')?.match(/^url\(#(.+)\)$/)?.[1];
    const node = source[i];
    if (!id || !(isA(node, SVGGeometryElement))) return;
    const pattern = [...el.querySelectorAll('pattern')].find(
      (p) => p.id === id,
    );
    const copy = [...clone.querySelectorAll('pattern')].find(
      (p) => p.id === id,
    );
    if (!pattern || !copy) return;
    const w = pattern.width.baseVal.value;
    const h = pattern.height.baseVal.value;
    if (
      !w ||
      !h ||
      pattern.patternUnits.baseVal !== SVGUnitTypes.SVG_UNIT_TYPE_USERSPACEONUSE
    ) {
      out.setAttribute('fill', 'none');
      return;
    }
    const svgMatrix = pattern.patternTransform.baseVal.consolidate()?.matrix;
    const matrix = svgMatrix
      ? DOMMatrix.fromMatrix(svgMatrix)
      : new DOMMatrix();
    // The shape's box in the pattern's own space, to cover with tiles.
    const box = node.getBBox();
    const inverse = matrix.inverse();
    const corners = [
      [box.x, box.y],
      [box.x + box.width, box.y],
      [box.x, box.y + box.height],
      [box.x + box.width, box.y + box.height],
    ].map(([x, y]) => inverse.transformPoint(new DOMPoint(x, y)));
    const xs = corners.map((p) => p.x);
    const ys = corners.map((p) => p.y);
    const [minX, maxX, minY, maxY] = [
      Math.min(...xs),
      Math.max(...xs),
      Math.min(...ys),
      Math.max(...ys),
    ];
    const tiles = [...copy.children];
    const rules = tiles.every(
      (t) =>
        isA(t, SVGLineElement) &&
        t.getAttribute('x1') === t.getAttribute('x2') &&
        parseFloat(t.getAttribute('y1') ?? '0') <= 0 &&
        parseFloat(t.getAttribute('y2') ?? '0') >= h,
    );
    const inner = document.createElementNS(SVG_NS, 'g');
    inner.setAttribute('transform', matrix.toString());
    for (let col = Math.floor(minX / w); col <= Math.ceil(maxX / w); col++) {
      if (rules) {
        for (const tile of tiles) {
          const line = tile.cloneNode(true) as Element;
          const x = parseFloat(line.getAttribute('x1') ?? '0') + col * w;
          line.setAttribute('x1', String(round(x)));
          line.setAttribute('x2', String(round(x)));
          line.setAttribute('y1', String(round(minY)));
          line.setAttribute('y2', String(round(maxY)));
          inner.append(line);
        }
        continue;
      }
      for (let row = Math.floor(minY / h); row <= Math.ceil(maxY / h); row++) {
        const cell = document.createElementNS(SVG_NS, 'g');
        cell.setAttribute('transform', `translate(${col * w} ${row * h})`);
        for (const tile of tiles) cell.append(tile.cloneNode(true));
        inner.append(cell);
      }
    }
    defs ??= clone.insertBefore(
      document.createElementNS(SVG_NS, 'defs'),
      clone.firstChild,
    );
    const clipId = `${id}-clip-${n++}`;
    const clip = document.createElementNS(SVG_NS, 'clipPath');
    clip.setAttribute('id', clipId);
    const shape = out.cloneNode() as Element;
    for (const attr of [
      'fill',
      'fill-opacity',
      'stroke',
      'opacity',
      'transform',
    ])
      shape.removeAttribute(attr);
    clip.append(shape);
    defs.append(clip);
    const group = document.createElementNS(SVG_NS, 'g');
    const transform = out.getAttribute('transform');
    if (transform) group.setAttribute('transform', transform);
    const opacity = out.getAttribute('opacity');
    if (opacity) group.setAttribute('opacity', opacity);
    group.setAttribute('clip-path', `url(#${clipId})`);
    group.append(inner);
    out.replaceWith(group);
  });
}

// What an SVG keeps for its shapes to point at, rather than draws.
const SVG_DEFS =
  'defs, pattern, clipPath, mask, linearGradient, radialGradient, filter, marker, symbol';
// An item picked inside a chart is cropped this far out, for its stroke.
const ITEM_BLEED = 2;

/**
 * An inline SVG, or with `only` one item inside it (a band, a slice, a
 * cell): the chart with everything else taken out, cropped to the item.
 */
function svgLayer(
  el: SVGSVGElement,
  origin: DOMRect,
  ctx: Ctx,
  only?: SVGGraphicsElement,
): Layer | null {
  const whole = box(el, origin);
  if (!whole.w || !whole.h) return null;
  const clone = el.cloneNode(true) as SVGSVGElement;
  const source = [el, ...el.querySelectorAll('*')];
  const target = [clone, ...clone.querySelectorAll('*')];
  source.forEach((node, i) => {
    const out = target[i];
    if (out) paintSvgNode(node, out);
  });
  // Gradients and patterns it points at from elsewhere on the page, such as
  // the audience treemap's cell fills, come along into its own defs.
  const wanted = [
    ...new XMLSerializer()
      .serializeToString(clone)
      .matchAll(/url\(#([^)]+)\)/g),
  ].map((m) => m[1]);
  const seen = new Set<string>();
  while (wanted.length) {
    const id = wanted.pop() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    if ([...clone.querySelectorAll('[id]')].some((n) => n.id === id)) continue;
    const found = el.ownerDocument.getElementById(id);
    if (!found || !(isA(found, SVGElement))) continue;
    const copy = found.cloneNode(true) as SVGElement;
    const from = [found, ...found.querySelectorAll('*')];
    const to = [copy, ...copy.querySelectorAll('*')];
    from.forEach((node, i) => to[i] && paintSvgNode(node, to[i]));
    const defs =
      clone.querySelector(':scope > defs') ??
      clone.insertBefore(
        document.createElementNS(SVG_NS, 'defs'),
        clone.firstChild,
      );
    defs.append(copy);
    wanted.push(
      ...[
        ...new XMLSerializer()
          .serializeToString(copy)
          .matchAll(/url\(#([^)]+)\)/g),
      ].map((m) => m[1]),
    );
  }
  // Picking one item drops what's neither it, inside it, around it, nor
  // something it points at.
  const dropped: Element[] = [];
  if (only) {
    source.forEach((node, i) => {
      const out = target[i];
      if (
        !out ||
        node === only ||
        only.contains(node) ||
        node.contains(only) ||
        node.closest(SVG_DEFS)
      )
        return;
      out.setAttribute('fill', 'none');
      dropped.push(out);
    });
  }
  expandPatterns(el, source, target, clone);
  dropped.forEach((node) => node.remove());
  let { x, y, w, h } = whole;
  if (only) {
    const view = el.viewBox.baseVal;
    const vw = view?.width || whole.w;
    const vh = view?.height || whole.h;
    const sx = vw / whole.w;
    const sy = vh / whole.h;
    const item = only.getBoundingClientRect();
    if (!item.width && !item.height) return null;
    const left = item.left - whole.rect.left - ITEM_BLEED;
    const top = item.top - whole.rect.top - ITEM_BLEED;
    x = round(whole.x + left);
    y = round(whole.y + top);
    w = round(item.width + ITEM_BLEED * 2);
    h = round(item.height + ITEM_BLEED * 2);
    clone.setAttribute(
      'viewBox',
      [(view?.x ?? 0) + left * sx, (view?.y ?? 0) + top * sy, w * sx, h * sy]
        .map(round)
        .join(' '),
    );
  }
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', String(w));
  clone.setAttribute('height', String(h));
  if (!clone.getAttribute('viewBox'))
    clone.setAttribute('viewBox', `0 0 ${w} ${h}`);
  ctx.count++;
  const name = only
    ? only.getAttribute('aria-label') ||
      only.getAttribute('name') ||
      only.classList[0] ||
      only.tagName
    : el.getAttribute('aria-label') || 'icon';
  return {
    t: 'svg',
    n: name,
    x,
    y,
    w,
    h,
    svg: new XMLSerializer().serializeToString(clone),
  };
}

/**
 * One SVG node's computed paint written onto its copy as attributes, since
 * classes, styles and CSS variables don't travel to Figma.
 */
function paintSvgNode(node: Element, out: Element) {
  const cs = getComputedStyle(node);
  for (const prop of ['fill', 'stroke'] as const) {
    const value = cs[prop];
    const c = toRgba(value);
    const layerOpacity = parseFloat(
      cs[prop === 'fill' ? 'fillOpacity' : 'strokeOpacity'],
    );
    const opacity = Number.isNaN(layerOpacity) ? 1 : layerOpacity;
    if (value === 'none' || (!c && !value.startsWith('url(')))
      out.setAttribute(prop, 'none');
    else {
      // Paint set in CSS or a style attribute lands as an attribute, since
      // the style goes.
      out.setAttribute(
        prop,
        c ? `rgb(${c[0]}, ${c[1]}, ${c[2]})` : value.replace(/["']/g, ''),
      );
      const alpha = (c?.[3] ?? 1) * opacity;
      if (alpha < 1) out.setAttribute(`${prop}-opacity`, String(round(alpha)));
    }
  }
  // Gradient stops styled with variables keep their resolved colour.
  if (isA(node, SVGStopElement)) {
    const c = toRgba(cs.stopColor);
    const stopOpacity = parseFloat(cs.stopOpacity);
    out.setAttribute(
      'stop-color',
      c ? `rgb(${c[0]}, ${c[1]}, ${c[2]})` : 'rgb(0, 0, 0)',
    );
    out.setAttribute(
      'stop-opacity',
      String(
        round((c?.[3] ?? 0) * (Number.isNaN(stopOpacity) ? 1 : stopOpacity)),
      ),
    );
  }
  if (cs.stroke !== 'none') {
    out.setAttribute('stroke-width', String(px(cs.strokeWidth)));
    if (cs.strokeDasharray !== 'none')
      out.setAttribute(
        'stroke-dasharray',
        cs.strokeDasharray.replace(/px/g, ''),
      );
    out.setAttribute('stroke-linecap', cs.strokeLinecap);
    out.setAttribute('stroke-linejoin', cs.strokeLinejoin);
  }
  if (cs.opacity !== '1') out.setAttribute('opacity', cs.opacity);
  if (cs.display === 'none') out.setAttribute('display', 'none');
  out.removeAttribute('class');
  out.removeAttribute('style');
}

function visible(el: Element, cs: CSSStyleDeclaration) {
  // A clip-path inset all the way across (a wipe waiting for hover) hides it.
  const clipped = /^inset\(.*100%/.test(cs.clipPath);
  return (
    cs.display !== 'none' &&
    cs.visibility !== 'hidden' &&
    cs.opacity !== '0' &&
    !clipped &&
    !el.matches(SKIP)
  );
}

// ---- Images

const imageCache = new Map<string, string | null>();

/** Degrees an element is turned on screen, its own rotation plus its ancestors'. */
function rotation(el: Element) {
  let deg = 0;
  for (
    let node: Element | null = el;
    node && node !== node.ownerDocument.body;
    node = node.parentElement
  ) {
    const cs = getComputedStyle(node);
    if (cs.rotate && cs.rotate !== 'none') {
      const angle = cs.rotate.split(' ').pop() ?? '';
      deg += angle.endsWith('rad')
        ? (parseFloat(angle) * 180) / Math.PI
        : angle.endsWith('turn')
          ? parseFloat(angle) * 360
          : parseFloat(angle) || 0;
    }
    if (cs.transform && cs.transform !== 'none') {
      const m = new DOMMatrix(cs.transform);
      deg += (Math.atan2(m.b, m.a) * 180) / Math.PI;
    }
  }
  return round(deg);
}

/**
 * The image's pixels, drawn from the already-loaded element so the copy stays
 * synchronous. Scaled to twice its size on the page, so a full-size photo
 * doesn't swell the clipboard. Null when it hasn't loaded or can't be read.
 */
function imageData(el: HTMLImageElement, w: number, h: number) {
  if (!el.complete || !el.naturalWidth) return null;
  const scale = Math.min(
    1,
    (Math.max(w, h) * density) / Math.max(el.naturalWidth, el.naturalHeight),
  );
  const width = Math.max(1, Math.round(el.naturalWidth * scale));
  const height = Math.max(1, Math.round(el.naturalHeight * scale));
  const key = `${el.currentSrc || el.src}@${width}x${height}`;
  const cached = imageCache.get(key);
  if (cached !== undefined) return cached;
  let out: string | null = null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d')?.drawImage(el, 0, 0, width, height);
    // Photos as JPEG; anything that may be see-through keeps its alpha.
    out = /\.jpe?g(\?|$)/i.test(el.currentSrc || el.src)
      ? canvas.toDataURL('image/jpeg', 0.85)
      : canvas.toDataURL('image/png');
  } catch {
    // Cross-origin without CORS taints the canvas; it stays a grey box.
  }
  imageCache.set(key, out);
  return out;
}

/** object-position as an SVG preserveAspectRatio alignment. */
function imageAlign(position: string) {
  const [x = '50%', y = '50%'] = position.split(' ');
  const axis = (value: string, names: [string, string, string]) => {
    const p = parseFloat(value);
    return p <= 25 ? names[0] : p >= 75 ? names[2] : names[1];
  };
  return `${axis(x, ['xMin', 'xMid', 'xMax'])}${axis(y, ['YMin', 'YMid', 'YMax'])}`;
}

function imageLayer(el: HTMLImageElement, cs: CSSStyleDeclaration): Img | null {
  // Untransformed size: the bounding box of a turned image is bigger than it.
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const src = imageData(el, w, h);
  if (!src) return null;
  const fit =
    cs.objectFit === 'cover'
      ? 'cover'
      : cs.objectFit === 'fill'
        ? 'fill'
        : 'contain';
  return {
    src,
    w,
    h,
    rot: rotation(el),
    fit,
    align: imageAlign(cs.objectPosition),
  };
}

/**
 * Children in paint order, looking through display: contents, and into a
 * web component's shadow root, its slots filled with what's put in them, as
 * Admin's Quick Edit controls draw their figures there.
 */
function children(el: Element): Node[] {
  const out: Node[] = [];
  const assigned =
    isA(el, HTMLSlotElement) ? el.assignedNodes({ flatten: true }) : [];
  const own =
    el.shadowRoot?.childNodes ??
    (assigned.length > 0 ? assigned : el.childNodes);
  for (const child of own) {
    if (
      isA(child, Element) &&
      getComputedStyle(child).display === 'contents'
    )
      out.push(...children(child));
    else out.push(child);
  }
  return out;
}

function flexLayout(
  cs: CSSStyleDeclaration,
  kids: HTMLElement[],
): Layout | undefined {
  if (
    !/flex$/.test(cs.display) ||
    cs.flexWrap !== 'nowrap' ||
    cs.flexDirection.endsWith('reverse')
  )
    return;
  const main = (
    {
      normal: 'start',
      'flex-start': 'start',
      start: 'start',
      left: 'start',
      center: 'center',
      'flex-end': 'end',
      end: 'end',
      right: 'end',
      'space-between': 'between',
    } as const
  )[cs.justifyContent as 'normal'];
  if (!main) return;
  const flowKids = kids.filter(
    (kid) => !/absolute|fixed/.test(getComputedStyle(kid).position),
  );
  if (
    flowKids.some((kid) =>
      ['Top', 'Right', 'Bottom', 'Left'].some(
        (side) =>
          px(getComputedStyle(kid)[`margin${side}` as 'marginTop']) !== 0,
      ),
    )
  )
    return;
  const cross =
    (
      {
        normal: 'stretch',
        stretch: 'stretch',
        center: 'center',
        'flex-start': 'start',
        start: 'start',
        'self-start': 'start',
        'flex-end': 'end',
        end: 'end',
        'self-end': 'end',
        baseline: 'baseline',
        'first baseline': 'baseline',
      } as const
    )[cs.alignItems as 'normal'] ?? 'start';
  const dir = cs.flexDirection === 'column' ? 'column' : 'row';
  const gap = px(dir === 'row' ? cs.columnGap : cs.rowGap);
  const side = (s: 'Top' | 'Right' | 'Bottom' | 'Left') =>
    round(px(cs[`padding${s}`]) + px(cs[`border${s}Width`]));
  return {
    dir,
    gap: round(gap),
    pad: [side('Top'), side('Right'), side('Bottom'), side('Left')],
    main,
    cross,
  };
}

/**
 * A box's own paint onto its layer: fill, gradients, border, corners and
 * shadows. Backgrounds SVG can't carry come back as an image layer to put
 * under its children.
 */
function paintBox(layer: Layer, cs: CSSStyleDeclaration): Layer | null {
  const { w, h } = layer;
  const fill = toRgba(cs.backgroundColor);
  if (fill) layer.fill = fill;
  const raster = rasterBackground(cs, w, h);
  const bg = raster ? [] : gradients(cs.backgroundImage);
  if (bg.length) layer.bg = bg;
  const borders: Sides = [
    px(cs.borderTopWidth),
    px(cs.borderRightWidth),
    px(cs.borderBottomWidth),
    px(cs.borderLeftWidth),
  ];
  const borderColor =
    toRgba(cs.borderTopColor) ??
    toRgba(cs.borderLeftColor) ??
    toRgba(cs.borderBottomColor);
  if (
    borderColor &&
    borders.some((b) => b > 0) &&
    cs.borderTopStyle !== 'none'
  ) {
    const style =
      [cs.borderTopStyle, cs.borderBottomStyle, cs.borderLeftStyle].find(
        (s) => s !== 'none',
      ) ?? 'solid';
    layer.stroke = {
      c: borderColor,
      w: borders,
      style:
        style === 'dashed' ? 'dashed' : style === 'dotted' ? 'dotted' : 'solid',
    };
  }
  const radius = (value: string) => {
    const first = value.split(' ')[0];
    return round(
      first.endsWith('%')
        ? (parseFloat(first) / 100) * Math.min(w, h)
        : px(first),
    );
  };
  const radii: Sides = [
    radius(cs.borderTopLeftRadius),
    radius(cs.borderTopRightRadius),
    radius(cs.borderBottomRightRadius),
    radius(cs.borderBottomLeftRadius),
  ];
  if (radii.some((r) => r > 0)) layer.r = radii;
  const fx = shadows(cs.boxShadow);
  if (fx.length) layer.fx = fx;
  if (!raster) return null;
  return {
    t: 'frame',
    n: 'Background',
    x: 0,
    y: 0,
    w,
    h,
    abs: true,
    ...(layer.r && { r: layer.r }),
    img: { src: raster, w, h, rot: 0, fit: 'fill', align: 'xMidYMid' },
  };
}

/**
 * A positioned ::before or ::after (a handle, a badge dot, an overlay) as a
 * box of its own. Unpositioned ones sit in the text flow and can't be placed
 * without layout, so they're left out.
 */
function pseudoLayer(el: HTMLElement, which: '::before' | '::after'): Layer[] {
  const ps = getComputedStyle(el, which);
  if (
    ps.content === 'none' ||
    ps.content === 'normal' ||
    ps.display === 'none' ||
    ps.visibility === 'hidden' ||
    ps.opacity === '0' ||
    ps.position !== 'absolute'
  )
    return [];
  const w = px(ps.width);
  const h = px(ps.height);
  if (!w || !h) return [];
  const parent = getComputedStyle(el);
  const layer: Layer = {
    t: 'frame',
    n: which.slice(2),
    x: round(px(parent.borderLeftWidth) + px(ps.left) + px(ps.marginLeft)),
    y: round(px(parent.borderTopWidth) + px(ps.top) + px(ps.marginTop)),
    w: round(w),
    h: round(h),
    abs: true,
  };
  const opacity = px(ps.opacity);
  if (ps.opacity !== '' && opacity < 1) layer.o = opacity;
  const background = paintBox(layer, ps);
  if (background) layer.kids = [background];
  return layer.fill || layer.bg || layer.stroke || layer.fx || layer.kids ? [layer] : [];
}

/**
 * An element turned with transform or rotate is measured unturned (its
 * children with it) and copied with its angle, so Figma gets a rotated frame
 * rather than a bigger upright one. The page is put back straight after.
 */
function unturn(el: Element) {
  const none = { deg: 0, restore: () => {} };
  if (!(isA(el, HTMLElement))) return none;
  const cs = getComputedStyle(el);
  let deg = 0;
  const undo: (() => void)[] = [];
  const hold = (prop: string, value: string) => {
    const prev = el.style.getPropertyValue(prop);
    const priority = el.style.getPropertyPriority(prop);
    el.style.setProperty(prop, value, 'important');
    undo.push(() =>
      prev ? el.style.setProperty(prop, prev, priority) : el.style.removeProperty(prop),
    );
  };
  if (cs.rotate && cs.rotate !== 'none') {
    const angle = cs.rotate.split(' ').pop() ?? '';
    const own = angle.endsWith('rad')
      ? (parseFloat(angle) * 180) / Math.PI
      : angle.endsWith('turn')
        ? parseFloat(angle) * 360
        : parseFloat(angle) || 0;
    if (own) {
      deg += own;
      hold('rotate', 'none');
    }
  }
  if (cs.transform && cs.transform !== 'none') {
    const m = new DOMMatrix(cs.transform);
    const own = (Math.atan2(m.b, m.a) * 180) / Math.PI;
    if (Math.abs(own) > 0.01 && m.is2D) {
      deg += own;
      // Same translate and scale, minus the turn.
      hold('transform', m.rotate(-own).toString());
    }
  }
  if (!undo.length) return none;
  return { deg: round(deg), restore: () => undo.reverse().forEach((f) => f()) };
}

function elementLayer(el: Element, origin: DOMRect, ctx: Ctx): Layer | null {
  const before = el.getBoundingClientRect();
  const turn = unturn(el);
  try {
    const layer = buildLayer(el, origin, ctx);
    if (layer && turn.deg) {
      // Turned about its own centre, which the browser may have put elsewhere.
      const after = el.getBoundingClientRect();
      layer.x = round(layer.x + (before.left + before.width / 2) - (after.left + after.width / 2));
      layer.y = round(layer.y + (before.top + before.height / 2) - (after.top + after.height / 2));
      layer.rot = round((layer.rot ?? 0) + turn.deg);
    }
    return layer;
  } finally {
    turn.restore();
  }
}

function buildLayer(el: Element, origin: DOMRect, ctx: Ctx): Layer | null {
  if (ctx.count >= ctx.max) { captureWarnings.add('The layer limit was reached; export smaller sections for a complete copy.'); return null; }
  const cs = getComputedStyle(el);
  if (!visible(el, cs)) return null;
  if (isA(el, SVGSVGElement)) return svgLayer(el, origin, ctx);
  if (isA(el, SVGGraphicsElement) && el.ownerSVGElement)
    return svgLayer(el.ownerSVGElement, origin, ctx, el);
  if (!(isA(el, HTMLElement))) return null;
  const { x, y, w, h, rect } = box(el, origin);
  ctx.count++;

  const layer: Layer = { t: 'frame', n: layerName(el), x, y, w, h };
  if (/absolute|fixed/.test(cs.position)) layer.abs = true;
  const opacity = px(cs.opacity);
  if (cs.opacity !== '' && opacity < 1) layer.o = opacity;
  const background = paintBox(layer, cs);
  const radii = layer.r ?? [0, 0, 0, 0];
  // Clip only what really spills, or rounds its children's corners: text a
  // touch wider in Figma's font rendering shouldn't get cut off.
  const spills =
    el.scrollWidth > el.clientWidth + 1 ||
    el.scrollHeight > el.clientHeight + 1;
  const rounds = radii.some((r) => r > 0) && el.children.length > 0;
  if (cs.overflow !== 'visible' && cs.overflow !== '' && (spills || rounds))
    layer.clip = true;

  const kids: Layer[] = background ? [background] : [];
  kids.push(...pseudoLayer(el, '::before'));
  const elementKids: HTMLElement[] = [];
  // Siblings stack by z-index (positioned ones), then source order, as the
  // browser paints them: an object behind a card stays behind it.
  const stacked: { kid: Layer; z: number; i: number }[] = [];
  children(el).forEach((child, i) => {
    let kid: Layer | null = null;
    let z = 0;
    if (isA(child, Text)) kid = textLayer(child, el, rect, ctx);
    else if (isA(child, Element)) {
      kid = elementLayer(child, rect, ctx);
      if (kid && isA(child, HTMLElement)) elementKids.push(child);
      const kcs = getComputedStyle(child);
      if (kcs.position !== 'static' && kcs.zIndex !== 'auto') z = parseInt(kcs.zIndex, 10) || 0;
    }
    if (kid) stacked.push({ kid, z, i });
  });
  stacked.sort((a, b) => a.z - b.z || a.i - b.i);
  kids.push(...stacked.map((s) => s.kid));
  kids.push(...pseudoLayer(el, '::after'));
  // Form fields draw their text outside the DOM.
  if (isA(el, HTMLInputElement) || isA(el, HTMLTextAreaElement)) {
    const value = el.value || el.placeholder;
    if (value && !/checkbox|radio|range|color|file/.test(el.type)) {
      const color = el.value
        ? cs.color
        : getComputedStyle(el, '::placeholder').color;
      const font = fontOf(cs, color);
      const lh = font.lh ?? font.size * 1.2;
      kids.push({
        t: 'text',
        n: el.value ? 'Value' : 'Placeholder',
        x: round(px(cs.paddingLeft) + px(cs.borderLeftWidth)),
        y: round((h - lh) / 2),
        w: round(w - px(cs.paddingLeft) - px(cs.paddingRight)),
        h: round(lh),
        s: el.type === 'password' ? '•'.repeat(value.length) : value,
        font,
      });
    }
  }
  // A same-origin iframe brings its page along, scaled to the frame's box.
  const doc = frameDocument(el);
  if (el.tagName === 'IFRAME' && !doc) captureWarnings.add('A protected embedded frame was omitted.');
  if (el.matches('canvas,video')) captureWarnings.add('Canvas and video content is not included in editable SVG exports.');
  const inner = doc && pageRoot(doc);
  if (inner) {
    const s = el.clientWidth ? w / el.clientWidth : 1;
    const outer = density;
    density = Math.min(outer, outer * s);
    let page: Layer | null = null;
    try {
      page = elementLayer(inner, new DOMRect(), ctx);
    } finally {
      density = outer;
    }
    if (page) {
      kids.push(scaleLayer(page, s));
      layer.clip = true;
    }
  }
  if (isA(el, HTMLImageElement)) {
    const img = imageLayer(el, cs);
    if (!img) captureWarnings.add('Some images could not be read and appear as placeholders.');
    if (img) layer.img = img;
    // A cut-out's filter: drop-shadow follows its outline.
    const drops = dropShadows(cs.filter);
    if (img && drops.length) layer.fx = [...(layer.fx ?? []), ...drops];
    else if (!layer.fill) layer.fill = [0, 0, 0, 0.06];
  }

  const bare =
    !layer.img &&
    !layer.fill &&
    !layer.bg &&
    !layer.stroke &&
    !layer.fx &&
    !layer.comp &&
    !layer.clip &&
    layer.o === undefined;
  // A plain wrapper round a single run of text is just that text.
  if (bare && kids.length === 1 && kids[0].t === 'text' && !layer.abs) {
    const [text] = kids;
    return { ...text, n: layer.n, x: round(text.x + x), y: round(text.y + y) };
  }
  if (kids.length) layer.kids = kids;
  // Auto layout only when every child is an element the flex placed.
  const textKids = kids.filter((k) => k.t === 'text').length;
  const layout =
    textKids === 0 || elementKids.length === 0
      ? flexLayout(cs, elementKids)
      : undefined;
  if (layout && kids.length) layer.layout = layout;
  return layer;
}

/** The layer at s times its size: an iframe's page shrunk into its thumbnail. */
function scaleLayer(layer: Layer, s: number): Layer {
  if (s === 1) return layer;
  const k = (v: number) => round(v * s);
  const out: Layer = { ...layer, x: k(layer.x), y: k(layer.y), w: k(layer.w), h: k(layer.h) };
  if (layer.r) out.r = layer.r.map(k) as Sides;
  if (layer.stroke) out.stroke = { ...layer.stroke, w: layer.stroke.w.map(k) as Sides };
  if (layer.fx)
    out.fx = layer.fx.map((f) => ({ ...f, x: k(f.x), y: k(f.y), blur: k(f.blur), spread: k(f.spread) }));
  if (layer.font)
    out.font = {
      ...layer.font,
      size: k(layer.font.size),
      lh: layer.font.lh === null ? null : k(layer.font.lh),
      ls: k(layer.font.ls),
    };
  if (layer.layout)
    out.layout = { ...layer.layout, gap: k(layer.layout.gap), pad: layer.layout.pad.map(k) as Sides };
  if (layer.img) out.img = { ...layer.img, w: k(layer.img.w), h: k(layer.img.h) };
  if (layer.svg)
    out.svg = layer.svg.replace(
      /^<svg\b([^>]*)>/,
      (tag) => tag.replace(/\swidth="[^"]*"/, ` width="${out.w}"`).replace(/\sheight="[^"]*"/, ` height="${out.h}"`),
    );
  if (layer.kids) out.kids = layer.kids.map((kid) => scaleLayer(kid, s));
  return out;
}

function serialize(el: Element, max = MAX_LAYERS, label?: string) {
  const ctx: Ctx = { count: 0, max };
  const origin = el.getBoundingClientRect();
  const root = elementLayer(el, origin, ctx);
  if (!root) return null;
  root.x = 0;
  root.y = 0;
  delete root.abs;
  const name = label || el.getAttribute('aria-label') || root.n;
  root.n = name;
  return {
    payload: {
      kind: 'prototype-section',
      // 2: layers can carry rot (x/y/w/h are then the unturned box).
      v: 2,
      source: location.href,
      name,
      root,
    },
    count: ctx.count,
    name,
  };
}

// The app's own root under <body>: the whole page, its nav and top bar
// included, without the portals for these tools. A page with several
// top-level blocks (a header over a grid) is the body itself.
function pageRoot(doc: Document = document) {
  const roots = [...doc.body.children].filter(
    (el) => !el.matches(SKIP) && el.getBoundingClientRect().height > 0,
  );
  return roots.length > 1 ? doc.body : (roots[0] ?? null);
}

// ---- SVG, for pasting straight onto the Figma canvas
//
// Figma turns pasted SVG code into layers: frames become named groups, text
// stays editable. Variables and components can't travel this way, so the full
// section rides along base64-encoded in <metadata> for the plugin to read.

const esc = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
const rgb = (c: RGBA4) =>
  `rgb(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])})`;
const paintAttr = (name: 'fill' | 'stroke', c: RGBA4) =>
  `${name}="${rgb(c)}"${c[3] < 1 ? ` ${name}-opacity="${round(c[3])}"` : ''}`;

const WEIGHT_NAMES: Record<number, string> = {
  100: 'Thin',
  200: 'ExtraLight',
  300: 'Light',
  400: 'Regular',
  500: 'Medium',
  600: 'SemiBold',
  700: 'Bold',
  800: 'ExtraBold',
  900: 'Black',
};

// Figma's SVG import rounds numeric weights to Regular or Bold, but reads a
// PostScript name ("ShopifyInter-SemiBold") exactly.
function svgFamily(font: Font) {
  const family = (font.families[0] ?? 'Inter').replace(/\s+/g, '');
  const weight = WEIGHT_NAMES[font.weight] ?? 'Regular';
  const style = font.italic
    ? weight === 'Regular'
      ? 'Italic'
      : `${weight}Italic`
    : weight;
  return `${family}-${style}`;
}

function svgText(layer: Layer) {
  const font = layer.font;
  if (!font || !layer.s) return '';
  const lh = font.lh ?? font.size * 1.2;
  // Inter's ascent and descent, so the baseline sits where the browser drew it.
  const baseline = (lh - font.size * 1.21) / 2 + font.size * 0.969;
  const anchor =
    font.align === 'center'
      ? 'middle'
      : font.align === 'right'
        ? 'end'
        : 'start';
  const x = anchor === 'middle' ? layer.w / 2 : anchor === 'end' ? layer.w : 0;
  const attrs = [
    `x="${round(x)}"`,
    `y="${round(baseline)}"`,
    `font-family="${esc(svgFamily(font))}"`,
    `font-size="${font.size}"`,
    font.ls ? `letter-spacing="${font.ls}"` : '',
    anchor !== 'start' ? `text-anchor="${anchor}"` : '',
    font.deco
      ? `text-decoration="${font.deco === 'strike' ? 'line-through' : 'underline'}"`
      : '',
    paintAttr('fill', font.c),
  ];
  return `<text ${attrs.filter(Boolean).join(' ')}>${esc(layer.s)}</text>`;
}

const HARD_ALPHA =
  '<feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha"/>';
const tint = (c: RGBA4) =>
  `<feColorMatrix type="matrix" values="0 0 0 0 ${round(c[0] / 255)} 0 0 0 0 ${round(c[1] / 255)} 0 0 0 0 ${round(c[2] / 255)} 0 0 0 ${round(c[3])} 0"/>`;

/** Box shadows as a filter in the shape Figma exports, so it reads them back as effects. */
function svgShadows(all: Shadow[], w: number, h: number, defs: string[]) {
  const id = `fx${defs.length}`;
  // Written the way Figma writes its own effects, which is all its SVG import
  // reads reliably: tested, a drop shadow cut out with feComposite comes in as
  // an inner shadow, an inner one without a blur step or with feMorphology
  // comes in as a drop, and spread is never read. So spread is folded away:
  // a shadow pulled in by negative spread (a tight glow under a pill) is faded
  // by how much of its blur the spread would have eaten, or it swells into a
  // halo; an inner one only thickens, so it just softens.
  const fx = all.map((s) =>
    s.spread < 0
      ? {
          ...s,
          spread: 0,
          c: [s.c[0], s.c[1], s.c[2], round(s.c[3] * (s.inset ? 0.75 : Math.max(0.35, 1 + (2 * s.spread) / Math.max(s.blur, 1))))] as RGBA4,
        }
      : { ...s, spread: 0 },
  );
  const pad =
    Math.max(...fx.map((s) => s.blur + Math.max(Math.abs(s.x), Math.abs(s.y)))) + 2;
  // CSS paints the first shadow on top; Figma stacks effects bottom-up.
  const drops = fx.filter((s) => !s.inset).reverse();
  const inner = fx.filter((s) => s.inset).reverse();
  const step = (s: Shadow) =>
    HARD_ALPHA +
    `<feOffset dx="${s.x}" dy="${s.y}"/>` +
    `<feGaussianBlur stdDeviation="${round(s.blur / 2)}"/>`;
  let last = 'BackgroundImageFix';
  let body = '<feFlood flood-opacity="0" result="BackgroundImageFix"/>';
  drops.forEach((s, i) => {
    const result = `effect${i + 1}_dropShadow`;
    body += step(s) + tint(s.c) + `<feBlend mode="normal" in2="${last}" result="${result}"/>`;
    last = result;
  });
  body += `<feBlend mode="normal" in="SourceGraphic" in2="${last}" result="shape"/>`;
  last = 'shape';
  inner.forEach((s, i) => {
    const result = `effect${drops.length + i + 1}_innerShadow`;
    body +=
      step(s) +
      '<feComposite in2="hardAlpha" operator="arithmetic" k2="-1" k3="1"/>' +
      tint(s.c) +
      `<feBlend mode="normal" in2="${last}" result="${result}"/>`;
    last = result;
  });
  defs.push(
    `<filter id="${id}" x="${round(-pad)}" y="${round(-pad)}" width="${round(w + pad * 2)}" height="${round(h + pad * 2)}" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">${body}</filter>`,
  );
  return id;
}

function svgBox(layer: Layer, defs: string[]) {
  const { w, h, fill, bg, fx, stroke, r } = layer;
  const radius = r ? Math.min(Math.max(...r), w / 2, h / 2) : 0;
  const rx = radius ? ` rx="${round(radius)}"` : '';
  let out = '';
  // Gradient backgrounds, bottom layer first, over the background colour.
  const paints: string[] = fill
    ? [`<rect width="${round(w)}" height="${round(h)}"${rx} ${paintAttr('fill', fill)}/>`]
    : [];
  for (const grad of [...(bg ?? [])].reverse()) {
    const id = `bg${defs.length}`;
    const stops = grad.stops
      .map(
        (s) =>
          `<stop offset="${round(s.p)}" stop-color="${rgb(s.c)}" stop-opacity="${round(s.c[3])}"/>`,
      )
      .join('');
    defs.push(
      `<linearGradient id="${id}" x1="${grad.x1}" y1="${grad.y1}" x2="${grad.x2}" y2="${grad.y2}">${stops}</linearGradient>`,
    );
    paints.push(`<rect width="${round(w)}" height="${round(h)}"${rx} fill="url(#${id})"/>`);
  }
  // The shadows ride on the top paint alone: Figma drops a shadow's spread
  // when it lands on a group of several, so a tight glow swells into a halo.
  const top = paints.pop();
  out += paints.join('');
  if (top && fx?.length) out += `<g filter="url(#${svgShadows(fx, w, h, defs)})">${top}</g>`;
  else if (top) out += top;
  const even = stroke && stroke.w.every((width) => width === stroke.w[0]);
  if (even) {
    const inset = stroke.w[0] / 2;
    const dash =
      even && stroke.style !== 'solid'
        ? ` stroke-dasharray="${stroke.style === 'dotted' ? `0 ${stroke.w[0] * 2}` : `${stroke.w[0] * 2} ${stroke.w[0] * 2}`}"${stroke.style === 'dotted' ? ' stroke-linecap="round"' : ''}`
        : '';
    out += `<rect x="${round(inset)}" y="${round(inset)}" width="${round(Math.max(0, w - inset * 2))}" height="${round(Math.max(0, h - inset * 2))}"${rx} fill="none" ${paintAttr('stroke', stroke.c)} stroke-width="${stroke.w[0]}"${dash}/>`;
  }
  // Single-side borders (dividers) draw as lines.
  if (stroke && !even) {
    const [t, rt, b, l] = stroke.w;
    const line = (
      x1: number,
      y1: number,
      x2: number,
      y2: number,
      width: number,
    ) =>
      `<line x1="${round(x1)}" y1="${round(y1)}" x2="${round(x2)}" y2="${round(y2)}" ${paintAttr('stroke', stroke.c)} stroke-width="${width}"/>`;
    if (t) out += line(0, t / 2, w, t / 2, t);
    if (rt) out += line(w - rt / 2, 0, w - rt / 2, h, rt);
    if (b) out += line(0, h - b / 2, w, h - b / 2, b);
    if (l) out += line(l / 2, 0, l / 2, h, l);
  }
  return out;
}

function svgLayerMarkup(layer: Layer, clips: string[]): string {
  // Screen-reader-only copies (1px clipped boxes) aren't visible on the page.
  if (layer.clip && layer.w <= 1 && layer.h <= 1) return '';
  const turn = layer.rot ? ` rotate(${layer.rot} ${round(layer.w / 2)} ${round(layer.h / 2)})` : '';
  const open = `<g id="${esc(layer.comp?.name ?? layer.n)}" transform="translate(${round(layer.x)} ${round(layer.y)})${turn}"${layer.o !== undefined && layer.o < 1 ? ` opacity="${round(layer.o)}"` : ''}>`;
  if (layer.t === 'text') return `${open}${svgText(layer)}</g>`;
  if (layer.t === 'svg')
    return `${open}${(layer.svg ?? '').replace(/^<svg\b/, '<svg x="0" y="0"')}</g>`;
  let kids = (layer.kids ?? [])
    .map((kid) => svgLayerMarkup(kid, clips))
    .join('');
  if (layer.clip && kids) {
    const id = `clip${clips.length}`;
    const radius = layer.r
      ? Math.min(Math.max(...layer.r), layer.w / 2, layer.h / 2)
      : 0;
    clips.push(
      `<clipPath id="${id}"><rect width="${round(layer.w)}" height="${round(layer.h)}"${radius ? ` rx="${round(radius)}"` : ''}/></clipPath>`,
    );
    kids = `<g clip-path="url(#${id})">${kids}</g>`;
  }
  return `${open}${svgBox(layer, clips)}${svgImage(layer, clips)}${kids}</g>`;
}

/** The image centred in its box, turned as on the page, its corners rounded. */
function svgImage(layer: Layer, clips: string[]) {
  const { img } = layer;
  if (!img) return '';
  const x = round((layer.w - img.w) / 2);
  const y = round((layer.h - img.h) / 2);
  const ratio =
    img.fit === 'fill'
      ? 'none'
      : `${img.align} ${img.fit === 'cover' ? 'slice' : 'meet'}`;
  let clip = '';
  const radius = layer.r
    ? Math.min(Math.max(...layer.r), img.w / 2, img.h / 2)
    : 0;
  if (radius || img.fit === 'cover') {
    const id = `clip${clips.length}`;
    clips.push(
      `<clipPath id="${id}"><rect x="${x}" y="${y}" width="${round(img.w)}" height="${round(img.h)}"${radius ? ` rx="${round(radius)}"` : ''}/></clipPath>`,
    );
    clip = ` clip-path="url(#${id})"`;
  }
  const turn = img.rot
    ? ` transform="rotate(${img.rot} ${round(layer.w / 2)} ${round(layer.h / 2)})"`
    : '';
  // Its drop shadows hug the image's alpha; a box's own shadows are drawn by svgBox.
  const shadow =
    layer.fx?.length && !layer.fill && !layer.bg
      ? ` filter="url(#${svgShadows(layer.fx, layer.w, layer.h, clips)})"`
      : '';
  return `<g${turn}${shadow}><image x="${x}" y="${y}" width="${round(img.w)}" height="${round(img.h)}" preserveAspectRatio="${ratio}" href="${img.src}"${clip}/></g>`;
}

function toBase64(text: string) {
  let binary = '';
  for (const byte of new TextEncoder().encode(text))
    binary += String.fromCharCode(byte);
  return btoa(binary);
}

function toSvg(payload: { name: string; root: Layer }) {
  const clips: string[] = [];
  const body = svgLayerMarkup(payload.root, clips);
  const { w, h } = payload.root;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(w)}" height="${Math.ceil(h)}" viewBox="0 0 ${Math.ceil(w)} ${Math.ceil(h)}" fill="none">` +
    `<metadata id="prototype-section">${toBase64(JSON.stringify(payload))}</metadata>` +
    (clips.length ? `<defs>${clips.join('')}</defs>` : '') +
    body +
    '</svg>'
  );
}


// ---- The tool

export function CopyToFigma() {
  const [picking, setPicking] = React.useState(false);
  // The toolbox button opens a choice: copy a section, or the whole page.
  const [choosing, setChoosing] = React.useState(false);
  useToolboxExclusive(choosing || picking, () => {
    setChoosing(false);
    setPicking(false);
  });
  const [hovered, setHovered] = React.useState<Element | null>(null);
  const [copied, setCopied] = React.useState<{
    name: string;
    count: number;
  } | null>(null);
  const [message, setMessage] = React.useState('');
  const [exported, setExported] = React.useState<string | null>(null);
  const busy = React.useRef(false);
  const hoveredRef = React.useRef<Element | null>(null);
  hoveredRef.current = hovered;
  const copy = React.useCallback(
    async (el: Element, max?: number, label?: string) => {
      if (busy.current) return;
      busy.current = true;
      setCopied(null);
      setExported(null);
      setMessage('Preparing SVG…');
      captureWarnings.clear();
      try {
        await loadBackgrounds(el);
        const result = serialize(el, max, label);
        if (!result) throw new Error('No visible content to export. Pick a visible section.');
        const svg = toSvg(result.payload);
        setExported(svg);
        const ok = await writeClipboard(svg);
        if (ok) setCopied({ name: result.name, count: result.count });
        setMessage([ok ? '' : 'Clipboard unavailable. Download SVG and import it into Figma.', ...captureWarnings].filter(Boolean).join(' '));
      } catch (error) {
        setMessage(`Export failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally { busy.current = false; }
    },
    [],
  );

  // Pick mode: hover outlines an element, ↑ widens to its parent, a click
  // copies it without reaching the page, Escape stops picking.
  React.useLayoutEffect(() => {
    if (!picking) return;
    const inTool = (t: EventTarget | null) => isToolUi(t);
    const stop = () => {
      setPicking(false);
      setHovered(null);
    };
    const move = (e: MouseEvent) => {
      if (inTool(e.target)) return setHovered(null);
      // A chart picks whole, or with ⌥ held, the band, slice or cell under
      // the pointer.
      const actual = realTarget(e);
      const target =
        isA(actual, Element)
          ? e.altKey
            ? actual
            : (actual.closest('svg') ?? actual)
          : null;
      setHovered(target);
    };
    const block = (e: MouseEvent) => {
      if (inTool(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
    };
    const pick = (e: MouseEvent) => {
      if (inTool(e.target)) return;
      block(e);
      const el = hoveredRef.current;
      stop();
      if (!el) return;
      copy(el);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') stop();
      // P copies the whole page from pick mode.
      if (e.key === 'p' || e.key === 'P') {
        const root = pageRoot();
        e.preventDefault();
        stop();
        if (root) copy(root, MAX_PAGE_LAYERS, `Page · ${location.pathname}`);
        return;
      }
      const current = hoveredRef.current;
      if (
        e.key === 'ArrowUp' &&
        current?.parentElement &&
        current.parentElement !== document.body
      ) {
        e.preventDefault();
        setHovered(current.parentElement);
      }
      // Into a chart, past its defs to the first thing it draws.
      const child = current
        ? [...current.children].find(
            (c) => !c.matches(`${SVG_DEFS}, title, desc, style`),
          )
        : undefined;
      if (e.key === 'ArrowDown' && child) {
        e.preventDefault();
        setHovered(child);
      }
    };
    document.addEventListener('mousemove', move, true);
    document.addEventListener('pointerdown', block, true);
    document.addEventListener('mousedown', block, true);
    document.addEventListener('click', pick, true);
    document.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('mousemove', move, true);
      document.removeEventListener('pointerdown', block, true);
      document.removeEventListener('mousedown', block, true);
      document.removeEventListener('click', pick, true);
      document.removeEventListener('keydown', key, true);
    };
  }, [picking, copy]);

  const rect = hovered?.isConnected ? hovered.getBoundingClientRect() : null;
  return (
    <>
      {picking && rect && (
        <div
          className="tb-figma-outline"
          style={{
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
          }}
        >
          <span className="tb-outline-tag">
            {hovered && layerName(hovered)} {Math.round(rect.width)}×
            {Math.round(rect.height)} · ↑ parent · ⌥ inside charts
          </span>
        </div>
      )}
      {/* Its button sits in the toolbox and offers Section or Page; while
          picking a section, P still takes the whole page. */}
      {(picking || copied || message || exported) && (
        <span className="tb-toast" role="status">
          {picking
            ? 'Click a section to copy it, P for the whole page (Esc cancels)'
            : <>{copied && `Copied ${copied.name} · ${copied.count} layers. Paste in Figma or import the SVG. `}{message}
              {exported && <button type="button" onClick={() => downloadText(exported, 'prototype-toolbox.svg', 'image/svg+xml')}>Download SVG</button>}
              <button type="button" aria-label="Dismiss export status" onClick={() => { setCopied(null); setMessage(''); setExported(null); }}>×</button>
            </>}
        </span>
      )}
      <ToolboxItem
        label={picking ? 'Cancel copy to Figma (Esc)' : 'Copy to Figma'}
        active={picking || choosing}
        order={5}
        onClick={() => {
          setCopied(null);
          if (picking) setPicking(false);
          else setChoosing(!choosing);
        }}
        flyout={
          choosing && (
            <>
              <button
                type="button"
                className="tb-pill tb-glass"
                onClick={() => {
                  setChoosing(false);
                  setPicking(true);
                }}
              >
                Section
              </button>
              <button
                type="button"
                className="tb-pill tb-glass"
                onClick={() => {
                  setChoosing(false);
                  setHovered(null);
                  const root = pageRoot();
                  if (root)
                    copy(root, MAX_PAGE_LAYERS, `Page · ${location.pathname}`);
                }}
              >
                Page
              </button>
            </>
          )
        }
      >
        <FigmaIcon />
      </ToolboxItem>
    </>
  );
}

// On hover the pieces part a little and the circle swells.
const FIGMA_PIECE = 'tb-figma-piece';

function FigmaIcon({ height = 18 }: { height?: number }) {
  // The logo's five pieces as fine outlines, a hair apart.
  return (
    <svg
      width={(height * 12) / 18}
      height={height}
      viewBox="0 0 12 18"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.25}
      aria-hidden
      style={{ overflow: 'visible' }}
    >
      <path
        d="M2.75 1h3v5h-3a2.5 2.5 0 0 1 0-5Z"
        className={`${FIGMA_PIECE} tb-fp-1`}
      />
      <path
        d="M6.25 1h3a2.5 2.5 0 0 1 0 5h-3V1Z"
        className={`${FIGMA_PIECE} tb-fp-2`}
      />
      <path
        d="M2.75 6.5h3v5h-3a2.5 2.5 0 0 1 0-5Z"
        className={`${FIGMA_PIECE} tb-fp-3`}
      />
      <circle
        cx="8.75"
        cy="9"
        r="2.5"
        className={`${FIGMA_PIECE} tb-fp-4`}
      />
      <path
        d="M5.75 12v2.75a2.75 2.75 0 1 1-2.75-2.75h2.75Z"
        className={`${FIGMA_PIECE} tb-fp-5`}
      />
    </svg>
  );
}
