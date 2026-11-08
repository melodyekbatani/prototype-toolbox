import React from 'react';
import { useClipboard } from '../core/clipboard';
import {
  CopyForAI,
  ToolboxItem,
  cx,
  useDraggablePanel,
  useToolboxExclusive,
} from '../core/toolbox';
import { pickAt } from '../core/hit-test';
import { componentName, describe, pathTo } from '../core/describe';
import { isToolUi, typingInField } from '../core/dom';

/**
 * Style tweaker. Open it and click anything on the page: it works out what
 * the element is (text, a button, a layout, an image, a box) and leads with
 * the controls that suit it, each stepping through a standard scale (the
 * default Tailwind scales) rather than raw pixels, plus colour pickers for
 * text and fill. The arrow keys drive it too: up and down choose a control,
 * left and right step its value, and Shift-up and Shift-down climb to the
 * parent or into the first child. Every edit copies out as CSS and as the
 * Tailwind classes to use.
 *
 * Adapted from the Rollouts prototype, whose scales were the Admin design
 * system's tokens; these are generic so it suits any page.
 */

type Token = {
  /** The value as shown, such as `20px` or `Medium`. */
  name: string;
  /** The Tailwind class to bake it in with. */
  className: string;
  styles: Record<string, string>;
};

type Control = {
  id: string;
  label: string;
  tokens: Token[];
  /** The token the element sits on, or the nearest when it's off the scale. */
  index: number;
  exact: boolean;
  /** The element's own value, shown while it's off the scale. */
  actual: string;
};

type ColorControl = {
  id: string;
  label: string;
  prop: 'color' | 'background-color' | 'border-color';
  /** Tailwind arbitrary-value prefix, such as `text` for `text-[#hex]`. */
  prefix: string;
  /** The current value as #rrggbb, for the picker. */
  hex: string;
  /** Whether it's see-through now (a fill that isn't set). */
  clear: boolean;
};

type Kind = 'Text' | 'Button' | 'Layout' | 'Image' | 'Box';

const SPACING = [
  0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16, 20, 24,
];

/** A spacing control, such as Padding X: `px-*` setting left and right. */
function spacing(prefix: string, props: string[]): Token[] {
  return SPACING.map((n) => ({
    name: `${n * 4}px`,
    className: `${prefix}-${n}`,
    styles: Object.fromEntries(props.map((p) => [p, `${n * 4}px`])),
  }));
}

// Tailwind v4's default radius scale.
const RADII: [string, number][] = [
  ['none', 0],
  ['xs', 2],
  ['sm', 4],
  ['md', 6],
  ['lg', 8],
  ['xl', 12],
  ['2xl', 16],
  ['3xl', 24],
  ['4xl', 32],
  ['full', 9999],
];

const RADIUS_TOKENS: Token[] = RADII.map(([name, px]) => ({
  name: name === 'full' ? 'Full' : `${px}px`,
  className: `rounded-${name}`,
  styles: { 'border-radius': `${px}px` },
}));

// Tailwind's default type scale: size and line height.
const TYPE: [string, number, number][] = [
  ['xs', 12, 16],
  ['sm', 14, 20],
  ['base', 16, 24],
  ['lg', 18, 28],
  ['xl', 20, 28],
  ['2xl', 24, 32],
  ['3xl', 30, 36],
  ['4xl', 36, 40],
  ['5xl', 48, 48],
  ['6xl', 60, 60],
  ['7xl', 72, 72],
];

const TYPE_TOKENS: Token[] = TYPE.map(([name, size, line]) => ({
  name: `${size}px`,
  className: `text-${name}`,
  styles: { 'font-size': `${size}px`, 'line-height': `${line}px` },
}));

const WEIGHT_TOKENS: Token[] = (
  [
    ['light', 300],
    ['normal', 400],
    ['medium', 500],
    ['semibold', 600],
    ['bold', 700],
    ['extrabold', 800],
  ] as const
).map(([name, weight]) => ({
  name: name[0].toUpperCase() + name.slice(1),
  className: `font-${name}`,
  styles: { 'font-weight': String(weight) },
}));

const TRACKING_TOKENS: Token[] = (
  [
    ['tighter', -0.05],
    ['tight', -0.025],
    ['normal', 0],
    ['wide', 0.025],
    ['wider', 0.05],
    ['widest', 0.1],
  ] as const
).map(([name, em]) => ({
  name: name[0].toUpperCase() + name.slice(1),
  className: `tracking-${name}`,
  styles: { 'letter-spacing': `${em}em` },
}));

const OPACITY_TOKENS: Token[] = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map(
  (n) => ({
    name: `${n}%`,
    className: `opacity-${n}`,
    styles: { opacity: String(n / 100) },
  }),
);

/** The nearest token to the element's current value of the first prop. */
function control(
  id: string,
  label: string,
  tokens: Token[],
  computed: CSSStyleDeclaration,
): Control {
  const prop = Object.keys(tokens[0].styles)[0];
  const current = computed.getPropertyValue(prop);
  const fontSize = parseFloat(computed.fontSize) || 16;
  // Letter spacing computes to px (or `normal`); the scale is in em.
  const asPx = (value: string) =>
    value.endsWith('em')
      ? parseFloat(value) * fontSize
      : value === 'normal'
        ? 0
        : parseFloat(value);
  // Full corners compute to the largest length the browser holds, not 9999px.
  const pill = (px: string) => prop === 'border-radius' && parseFloat(px) >= 9999;
  const value = asPx(current);
  const exactIndex = tokens.findIndex((t) => {
    const want = t.styles[prop];
    if (pill(want) && pill(current)) return true;
    if (prop === 'font-weight' || prop === 'opacity')
      return parseFloat(want) === parseFloat(current);
    return Math.abs(asPx(want) - value) < 0.05;
  });
  const actual =
    prop === 'opacity'
      ? `${Math.round(value * 100)}%`
      : prop === 'font-weight'
        ? current
        : `${Math.round(value * 10) / 10}px`;
  if (exactIndex >= 0)
    return { id, label, tokens, index: exactIndex, exact: true, actual };
  let index = 0;
  if (!Number.isNaN(value)) {
    let best = Infinity;
    tokens.forEach((t, i) => {
      const distance = Math.abs(asPx(t.styles[prop]) - value);
      if (distance < best) {
        best = distance;
        index = i;
      }
    });
  }
  return { id, label, tokens, index, exact: false, actual };
}

/** Steps off-scale values onto the scale: the token's own value, in px. */
function tokenValue(token: Token, prop: string, el: HTMLElement) {
  const value = token.styles[prop];
  if (value.endsWith('em'))
    return parseFloat(value) * (parseFloat(getComputedStyle(el).fontSize) || 16);
  return parseFloat(value);
}

// ---- Colours

let colorContext: CanvasRenderingContext2D | null = null;

/** Any CSS colour as #rrggbb and its alpha, via a 1px canvas. */
function toHex(value: string): { hex: string; alpha: number } {
  colorContext ??= document
    .createElement('canvas')
    .getContext('2d', { willReadFrequently: true });
  if (!colorContext) return { hex: '#000000', alpha: 1 };
  colorContext.clearRect(0, 0, 1, 1);
  colorContext.fillStyle = '#000';
  colorContext.fillStyle = value;
  colorContext.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = colorContext.getImageData(0, 0, 1, 1).data;
  const hex = `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
  return { hex, alpha: a / 255 };
}

function colorControl(
  id: string,
  label: string,
  prop: ColorControl['prop'],
  prefix: string,
  cs: CSSStyleDeclaration,
): ColorControl {
  const value = cs.getPropertyValue(prop);
  const { hex, alpha } = toHex(value);
  return { id, label, prop, prefix, hex, clear: alpha === 0 };
}

function hasOwnText(el: HTMLElement) {
  return [...el.childNodes].some(
    (n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim(),
  );
}

/** Works out what the element is. */
function kindOf(el: HTMLElement): Kind {
  const cs = getComputedStyle(el);
  const tag = el.tagName.toLowerCase();
  const layout = cs.display.includes('flex') || cs.display.includes('grid');
  if (['img', 'svg', 'picture', 'video', 'canvas'].includes(tag)) return 'Image';
  if (tag === 'button' || tag === 'a' || el.getAttribute('role') === 'button')
    return 'Button';
  if (hasOwnText(el) && !layout) return 'Text';
  return layout ? 'Layout' : 'Box';
}

type Section = { title: string; controls: Control[]; colors: ColorControl[] };

/**
 * The controls that apply to the element, in sections, with the ones that
 * suit what it is first: text for text and buttons, appearance for images,
 * spacing for the rest.
 */
function detect(el: HTMLElement): { kind: Kind; sections: Section[] } {
  const cs = getComputedStyle(el);
  const kind = kindOf(el);
  // One control while all four sides match, or one per axis when they don't.
  const sides = (prop: 'padding' | 'margin', short: string, label: string) => {
    const [t, r, b, l] = ['top', 'right', 'bottom', 'left'].map((side) =>
      cs.getPropertyValue(`${prop}-${side}`),
    );
    return t === r && r === b && b === l
      ? [
          control(
            short,
            label,
            spacing(
              short,
              ['top', 'right', 'bottom', 'left'].map((side) => `${prop}-${side}`),
            ),
            cs,
          ),
        ]
      : [
          control(
            `${short}x`,
            `${label} X`,
            spacing(`${short}x`, [`${prop}-left`, `${prop}-right`]),
            cs,
          ),
          control(
            `${short}y`,
            `${label} Y`,
            spacing(`${short}y`, [`${prop}-top`, `${prop}-bottom`]),
            cs,
          ),
        ];
  };
  // Only what has an effect: gap only in a flex or grid, type only where
  // there's text, corners only on something visible.
  const image = kind === 'Image';
  const layout = cs.display.includes('flex') || cs.display.includes('grid');
  const text = !image && Boolean(el.textContent?.trim());
  const bordered = parseFloat(cs.borderTopWidth) > 0;
  const painted =
    image ||
    cs.backgroundColor !== 'rgba(0, 0, 0, 0)' ||
    cs.backgroundImage !== 'none' ||
    cs.boxShadow !== 'none' ||
    bordered;
  const spacingSection: Section = {
    title: 'Spacing',
    controls: [
      ...sides('padding', 'p', 'Padding'),
      ...sides('margin', 'm', 'Margin'),
      ...(layout
        ? [control('gap', 'Gap', spacing('gap', ['row-gap', 'column-gap']), cs)]
        : []),
    ],
    colors: [],
  };
  const typeSection: Section = {
    title: 'Text',
    controls: text
      ? [
          control('text', 'Size', TYPE_TOKENS, cs),
          control('weight', 'Weight', WEIGHT_TOKENS, cs),
          control('tracking', 'Tracking', TRACKING_TOKENS, cs),
        ]
      : [],
    colors: text ? [colorControl('color', 'Colour', 'color', 'text', cs)] : [],
  };
  const shapeSection: Section = {
    title: 'Appearance',
    controls: [
      ...(painted ? [control('radius', 'Corners', RADIUS_TOKENS, cs)] : []),
      control('opacity', 'Opacity', OPACITY_TOKENS, cs),
    ],
    colors: image
      ? []
      : [
          colorControl('bg', 'Fill', 'background-color', 'bg', cs),
          ...(bordered
            ? [colorControl('border', 'Border', 'border-color', 'border', cs)]
            : []),
        ],
  };
  const sections = {
    Text: [typeSection, spacingSection, shapeSection],
    Button: [typeSection, spacingSection, shapeSection],
    Image: [shapeSection, spacingSection, typeSection],
    Layout: [spacingSection, shapeSection, typeSection],
    Box: [spacingSection, shapeSection, typeSection],
  }[kind].filter(
    (section) => section.controls.length > 0 || section.colors.length > 0,
  );
  return { kind, sections };
}

type Edit = { from: string; to: string; inline: string; priority: string };
type Entry = {
  el: HTMLElement;
  name: string;
  edits: Record<string, Edit>;
  /** The class each control was set to, by control. */
  classes: Record<string, string>;
};

type Direction = 'up' | 'down' | 'left' | 'right';

export function StyleTweaker() {
  const [open, setOpen] = React.useState(false);
  const [selected, setSelected] = React.useState<HTMLElement | null>(null);
  const [hovered, setHovered] = React.useState<HTMLElement | null>(null);
  const [entries, setEntries] = React.useState<Entry[]>([]);
  const [active, setActive] = React.useState(0);
  const clipboard = useClipboard();
  const [, setFrame] = React.useState(0);
  useToolboxExclusive(open, () => setOpen(false));

  // While open, hovering outlines an element and a click selects it without
  // reaching the page; the toolbox's own UI stays clickable.
  React.useLayoutEffect(() => {
    if (!open) return;
    // What the pointer is on as it looks: past empty wrappers and the clear
    // parts of cut-out images stacked over it.
    const target = (e: MouseEvent) => {
      if (isToolUi(e.target)) return null;
      // An SVG is styled by the element holding it.
      let el: Element | null = pickAt(e.clientX, e.clientY);
      while (el && !(el instanceof HTMLElement)) el = el.parentElement;
      return el === document.body ? null : (el as HTMLElement | null);
    };
    const move = (e: MouseEvent) => setHovered(target(e));
    const block = (e: MouseEvent) => {
      if (!target(e)) return;
      e.preventDefault();
      e.stopPropagation();
    };
    const pick = (e: MouseEvent) => {
      const el = target(e);
      if (!el) return;
      block(e);
      setSelected(el);
      setActive(0);
    };
    document.addEventListener('mousemove', move, true);
    document.addEventListener('pointerdown', block, true);
    document.addEventListener('mousedown', block, true);
    document.addEventListener('click', pick, true);
    return () => {
      document.removeEventListener('mousemove', move, true);
      document.removeEventListener('pointerdown', block, true);
      document.removeEventListener('mousedown', block, true);
      document.removeEventListener('click', pick, true);
      setHovered(null);
    };
  }, [open]);

  // Keep the outlines on their elements while the page scrolls or reflows.
  React.useLayoutEffect(() => {
    if (!open || (!selected && !hovered)) return;
    let raf = 0;
    const tick = () => {
      setFrame((n) => n + 1);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [open, selected, hovered]);

  const detected = selected?.isConnected ? detect(selected) : null;
  const controls = detected?.sections.flatMap((section) => section.controls) ?? [];
  const current = controls[Math.min(active, controls.length - 1)];

  /** Sets styles on the selection, remembering what each was before. */
  const write = (
    styles: Record<string, string>,
    controlId: string,
    className: string,
  ) => {
    if (!selected) return;
    const cs = getComputedStyle(selected);
    setEntries((list) => {
      const existing = list.find((e) => e.el === selected);
      const base: Entry = existing ?? {
        el: selected,
        name: componentName(selected) ?? '',
        edits: {},
        classes: {},
      };
      const edits = { ...base.edits };
      for (const [prop, value] of Object.entries(styles)) {
        const from = edits[prop]?.from ?? cs.getPropertyValue(prop);
        const inline = edits[prop]?.inline ?? selected.style.getPropertyValue(prop);
        const priority = edits[prop]?.priority ?? selected.style.getPropertyPriority(prop);
        selected.style.setProperty(prop, value, 'important');
        edits[prop] = { from, to: value, inline, priority };
      }
      const next = {
        ...base,
        edits,
        classes: { ...base.classes, [controlId]: className },
      };
      return [...list.filter((e) => e.el !== selected), next];
    });
  };

  const apply = (target: Control, index: number) => {
    const token = target.tokens[index];
    write(token.styles, target.id, token.className);
  };

  const step = (target: Control, delta: number) => {
    let index = target.index + delta;
    // Off the scale, a step lands on the next token past the actual value.
    if (!target.exact && selected) {
      const prop = Object.keys(target.tokens[0].styles)[0];
      const cs = getComputedStyle(selected);
      const raw = cs.getPropertyValue(prop);
      const value = raw === 'normal' ? 0 : parseFloat(raw);
      const values = target.tokens.map((t) => tokenValue(t, prop, selected));
      if (!Number.isNaN(value) && !values.some(Number.isNaN)) {
        const past = values.map((v) => (delta > 0 ? v > value : v < value));
        index = delta > 0 ? past.indexOf(true) : past.lastIndexOf(true);
        if (index < 0) index = delta > 0 ? values.length - 1 : 0;
      }
    }
    apply(target, Math.max(0, Math.min(target.tokens.length - 1, index)));
  };

  const go = (direction: Direction, shift = false) => {
    if (!selected) return;
    if (shift && direction === 'up') {
      if (selected.parentElement && selected.parentElement !== document.body) {
        setSelected(selected.parentElement);
        setActive(0);
      }
      return;
    }
    if (shift && direction === 'down') {
      const child = selected.firstElementChild;
      if (child instanceof HTMLElement) {
        setSelected(child);
        setActive(0);
      }
      return;
    }
    if (!current) return;
    if (direction === 'up')
      setActive((a) => (a - 1 + controls.length) % controls.length);
    if (direction === 'down') setActive((a) => (a + 1) % controls.length);
    if (direction === 'left') step(current, -1);
    if (direction === 'right') step(current, 1);
  };
  const goRef = React.useRef(go);
  goRef.current = go;

  // The arrow keys drive the controls while the tweaker's open, except in a
  // field (the page's or the toolbox's own).
  React.useLayoutEffect(() => {
    if (!open) return;
    const directions: Record<string, Direction> = {
      ArrowUp: 'up',
      ArrowDown: 'down',
      ArrowLeft: 'left',
      ArrowRight: 'right',
    };
    const key = (e: KeyboardEvent) => {
      if (typingInField(e)) return;
      if (e.key === 'Escape') {
        setSelected(null);
        return;
      }
      const direction = directions[e.key];
      if (!direction) return;
      e.preventDefault();
      e.stopPropagation();
      goRef.current(direction, e.shiftKey);
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [open]);

  const resetEntry = (target: Entry) => {
    for (const [prop, edit] of Object.entries(target.edits)) {
      if (edit.inline) target.el.style.setProperty(prop, edit.inline, edit.priority);
      else target.el.style.removeProperty(prop);
    }
    setEntries((list) => list.filter((e) => e !== target));
  };

  const text = [
    `Style edits from the prototype toolbox — ${location.href}`,
    ...entries.map((e, i) =>
      [
        `${i + 1}. ${e.name ? `<${e.name}> ` : ''}${describe(e.el)}`,
        `   selector: ${pathTo(e.el)}`,
        `   tailwind: ${Object.values(e.classes).join(' ')}`,
        ...Object.entries(e.edits).map(
          ([prop, edit]) => `   ${prop}: ${edit.from} → ${edit.to}`,
        ),
      ].join('\n'),
    ),
  ].join('\n');

  const copy = async () => {
    await clipboard.copy(text);
  };

  const outline = (el: HTMLElement | null, tone: 'hover' | 'selected') => {
    if (!el || !el.isConnected) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const pad = ['top', 'right', 'bottom', 'left'].map(
      (s) => parseFloat(cs.getPropertyValue(`padding-${s}`)) || 0,
    );
    return (
      <div
        className={`tb-outline is-${tone}`}
        style={{ left: r.left, top: r.top, width: r.width, height: r.height }}
      >
        {/* Padding shown as a tint inside the box. */}
        <div
          className="tb-outline-pad"
          style={{
            borderWidth: `${pad[0]}px ${pad[1]}px ${pad[2]}px ${pad[3]}px`,
          }}
        />
        <span className="tb-outline-tag">
          {kindOf(el)} · {Math.round(r.width)}×{Math.round(r.height)}
        </span>
      </div>
    );
  };

  const drag = useDraggablePanel();
  const entry = selected ? entries.find((e) => e.el === selected) : undefined;
  return (
    <>
      {open && hovered !== selected && outline(hovered, 'hover')}
      {open && outline(selected, 'selected')}
      <ToolboxItem
        label={open ? 'Close style tweaker' : 'Style tweaker'}
        active={open}
        order={2}
        badge={entries.length}
        onClick={() => setOpen(!open)}
      >
        <SlidersIcon />
      </ToolboxItem>
      {open && (
        <aside
          data-panel="style-tweaker"
          style={drag.style}
          onPointerDown={drag.handle.onPointerDown}
          className={`tb-panel tb-panel-style ${drag.handle.className}`}
        >
          {selected && detected ? (
            <>
              <div className="tb-panel-head">
                <div className="tb-title tb-truncate" title={describe(selected)}>
                  {componentName(selected) ?? describe(selected)}
                </div>
                <div className="tb-muted tb-nums">
                  {detected.kind} ·{' '}
                  {Math.round(selected.getBoundingClientRect().width)}×
                  {Math.round(selected.getBoundingClientRect().height)}
                </div>
                <Layers
                  el={selected}
                  onSelect={(el) => {
                    setSelected(el);
                    setActive(0);
                  }}
                  onPreview={setHovered}
                />
              </div>
              <div className="tb-controls" data-no-drag="">
                {detected.sections.map((section) => (
                  <div key={section.title} className="tb-section">
                    <span className="tb-section-title">{section.title}</span>
                    {section.controls.map((c) => {
                      const i = controls.indexOf(c);
                      return (
                        <TokenRow
                          key={c.id}
                          control={c}
                          active={c === current}
                          edited={Boolean(entry?.classes[c.id])}
                          onFocus={() => setActive(i)}
                          onStep={(delta) => {
                            setActive(i);
                            step(c, delta);
                          }}
                          onPick={(index) => {
                            setActive(i);
                            apply(c, index);
                          }}
                        />
                      );
                    })}
                    {section.colors.map((c) => (
                      <ColorRow
                        key={c.id}
                        control={c}
                        edited={Boolean(entry?.classes[c.id])}
                        onPick={(hex) =>
                          write({ [c.prop]: hex }, c.id, `${c.prefix}-[${hex}]`)
                        }
                      />
                    ))}
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="tb-empty">
              <span className="tb-title">Click anything on the page</span>
              <span className="tb-muted">
                Its spacing, type, colour and shape, on standard scales.
              </span>
            </div>
          )}
          {entries.length > 0 && (
            <ul className="tb-list tb-divide tb-entries">
              {entries.map((e) => (
                <li
                  key={describe(e.el) + Object.keys(e.classes).join()}
                  className="tb-row tb-center-y"
                >
                  <button
                    type="button"
                    className="tb-entry-name"
                    onClick={() => setSelected(e.el)}
                  >
                    <strong>{e.name || e.el.tagName.toLowerCase()}</strong>{' '}
                    <code>{Object.values(e.classes).join(' ')}</code>
                  </button>
                  <button
                    type="button"
                    aria-label="Reset this element"
                    className="tb-icon-button"
                    onClick={() => resetEntry(e)}
                  >
                    <CloseIcon size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="tb-panel-foot">
            <CopyForAI
              tool="Style tweaker"
              getData={() => ({
                summary: text,
                edits: entries.map((e) => ({
                  component: e.name,
                  element: describe(e.el),
                  selector: pathTo(e.el),
                  classes: Object.values(e.classes),
                  edits: e.edits,
                })),
              })}
            />
            <div className="tb-links">
              <button type="button" disabled={entries.length === 0} onClick={copy}>
                {clipboard.label('Copy edits')}
              </button>
              <button
                type="button"
                disabled={entries.length === 0}
                onClick={() => entries.forEach(resetEntry)}
              >
                Reset all
              </button>
            </div>
          </div>
        </aside>
      )}
    </>
  );
}

function parentOf(el: HTMLElement) {
  const parent = el.parentElement;
  return parent && parent !== document.body ? parent : null;
}

/**
 * Steps up to the selection's parent or down to its first child, with its
 * nearest ancestors listed to jump to; each outlines on the page while
 * hovered.
 */
function Layers({
  el,
  onSelect,
  onPreview,
}: {
  el: HTMLElement;
  onSelect: (el: HTMLElement) => void;
  onPreview: (el: HTMLElement | null) => void;
}) {
  const ancestors: HTMLElement[] = [];
  for (let at = parentOf(el); at && ancestors.length < 3; at = parentOf(at))
    ancestors.push(at);
  const child =
    el.firstElementChild instanceof HTMLElement ? el.firstElementChild : null;
  const layer = (target: HTMLElement | null, label: string, title: string) => (
    <button
      type="button"
      disabled={!target}
      title={title}
      onClick={() => target && onSelect(target)}
      onMouseEnter={() => onPreview(target)}
      onMouseLeave={() => onPreview(null)}
      className="tb-layer"
    >
      {label}
    </button>
  );
  const name = (node: HTMLElement) => componentName(node) ?? describe(node);
  return (
    <div className="tb-layers">
      <div className="tb-flex tb-gap-6">
        {layer(ancestors[0] ?? null, '↑ Parent', 'Select the parent (⇧↑)')}
        {layer(child, '↓ Child', 'Select the first child (⇧↓)')}
      </div>
      {ancestors.length > 0 && (
        <div className="tb-crumbs">
          {[...ancestors].reverse().map((ancestor, i) => (
            <React.Fragment key={i}>
              <button
                type="button"
                onClick={() => onSelect(ancestor)}
                onMouseEnter={() => onPreview(ancestor)}
                onMouseLeave={() => onPreview(null)}
              >
                {name(ancestor).split(' ')[0]}
              </button>
              <span aria-hidden>›</span>
            </React.Fragment>
          ))}
          <span className="tb-crumb-current">{name(el).split(' ')[0]}</span>
        </div>
      )}
    </div>
  );
}

/**
 * One control: its label and Tailwind class on the left, and on the right a
 * stepper showing the value, with a step down and up either side.
 */
function TokenRow({
  control,
  active,
  edited,
  onFocus,
  onStep,
  onPick,
}: {
  control: Control;
  active: boolean;
  edited: boolean;
  onFocus: () => void;
  onStep: (delta: number) => void;
  /** Jumps straight to a token, picked from the value's dropdown. */
  onPick: (index: number) => void;
}) {
  const token = control.tokens[control.index];
  const atStart = control.exact && control.index === 0;
  const atEnd = control.exact && control.index === control.tokens.length - 1;
  return (
    <div
      onClick={onFocus}
      data-control={control.id}
      className={cx('tb-token-row', active && 'is-active')}
    >
      <span className="tb-token-label">
        <span className="tb-token-name">
          {control.label}
          {edited && <span className="tb-dot" aria-hidden />}
        </span>
        <span className="tb-token-class">
          {control.exact ? token.className : 'Off the scale'}
        </span>
      </span>
      <span className={cx('tb-stepper', active && 'is-active')}>
        <StepButton
          label={`Less ${control.label}`}
          disabled={atStart}
          onClick={() => onStep(-1)}
        >
          <ChevronIcon turn={180} />
        </StepButton>
        {/* The value opens the whole scale to pick from: a native select laid
            invisibly over it, so it keeps the pill's look. */}
        <label className="tb-stepper-value">
          <select
            aria-label={control.label}
            value={control.exact ? String(control.index) : ''}
            onChange={(event: Event) =>
              onPick(Number((event.target as HTMLSelectElement).value))
            }
          >
            {!control.exact && (
              <option value="" disabled>
                {control.actual}
              </option>
            )}
            {control.tokens.map((t, index) => (
              <option key={t.className} value={String(index)}>
                {t.name} · {t.className}
              </option>
            ))}
          </select>
          <span
            className={cx(
              'tb-value',
              !control.exact ? 'is-off' : edited ? 'is-edited' : '',
            )}
          >
            {control.exact ? token.name : control.actual}
          </span>
          <span className="tb-faint">
            <ChevronIcon turn={90} size={10} />
          </span>
        </label>
        <StepButton
          label={`More ${control.label}`}
          disabled={atEnd}
          onClick={() => onStep(1)}
        >
          <ChevronIcon turn={0} />
        </StepButton>
      </span>
    </div>
  );
}

/** A colour: its label and hex on the left, a swatch that opens the picker. */
function ColorRow({
  control,
  edited,
  onPick,
}: {
  control: ColorControl;
  edited: boolean;
  onPick: (hex: string) => void;
}) {
  return (
    <div className="tb-token-row" data-control={control.id}>
      <span className="tb-token-label">
        <span className="tb-token-name">
          {control.label}
          {edited && <span className="tb-dot" aria-hidden />}
        </span>
        <span className="tb-token-class">
          {control.clear ? 'none' : control.hex}
        </span>
      </span>
      <label className="tb-stepper tb-swatch-pill">
        <span
          className={cx('tb-swatch', control.clear && 'is-clear')}
          style={{ background: control.clear ? undefined : control.hex }}
        />
        <span className={cx('tb-value', edited && 'is-edited')}>
          {control.clear ? 'None' : control.hex.toUpperCase()}
        </span>
        <input
          type="color"
          aria-label={control.label}
          value={control.hex}
          onInput={(event: Event) =>
            onPick((event.target as HTMLInputElement).value)
          }
        />
      </label>
    </div>
  );
}

function StepButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onMouseDown={(e: MouseEvent) => e.preventDefault()}
      onClick={(e: MouseEvent) => {
        e.stopPropagation();
        onClick();
      }}
      className="tb-step"
    >
      {children}
    </button>
  );
}

function ChevronIcon({ turn, size = 12 }: { turn: number; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      style={{ rotate: `${turn}deg` }}
    >
      <path d="m4.5 2.5 3.5 3.5-3.5 3.5" />
    </svg>
  );
}

const iconProps = {
  width: 18,
  height: 18,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
} as const;

function SlidersIcon() {
  return (
    <svg {...iconProps}>
      <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" />
      {/* On hover the knobs slide along their tracks. */}
      <circle cx="16" cy="6" r="2" className="tb-knob tb-knob-1" />
      <circle cx="10" cy="12" r="2" className="tb-knob tb-knob-2" />
      <circle cx="18" cy="18" r="2" className="tb-knob tb-knob-3" />
    </svg>
  );
}

function CloseIcon({ size = 18 }: { size?: number }) {
  return (
    <svg {...iconProps} width={size} height={size}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}
