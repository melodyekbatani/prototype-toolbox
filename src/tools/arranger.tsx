import React from 'react';
import { useClipboard } from '../core/clipboard';
import {
  CopyForAI,
  ToolboxItem,
  useDraggablePanel,
  useToolboxExclusive,
} from '../core/toolbox';
import { pickAt } from '../core/hit-test';
import { describe, pathTo, resolvePath } from '../core/describe';
import { isToolUi } from '../core/dom';

/**
 * Arranger: switch it on and click any element (an image, a card, a slice
 * of a chart) to select it, or Shift-click to gather several into a group.
 * Drag to move the selection, Option-drag to scale it; a single element also
 * gets corner handles to scale it and a handle above it to turn it (Shift
 * snaps to 15°). Changes sit on top of each element's own styling as an extra
 * transform, last until the page reloads, and copy out as JSON to bake back
 * into the code.
 *
 * Adapted from the Rollouts prototype, where elements could also be tagged
 * through a React hook; here every element is keyed by its page and its path
 * in the document, and transformed directly.
 */

type Adjustment = {
  x: number;
  y: number;
  rotate: number;
  scale: number;
  /** Mirrored left to right, or top to bottom; left out when not. */
  flipX?: boolean;
  flipY?: boolean;
  /** What the element is, so its saved values can be told apart. */
  label?: string;
};

const IDENTITY: Adjustment = { x: 0, y: 0, rotate: 0, scale: 1 };

/** The adjustment as a CSS transform, or, for SVG, a transform attribute. */
function transformOf(adjustment: Adjustment, svg = false) {
  const { x, y, rotate, scale } = adjustment;
  const flipped = `${adjustment.flipX ? -scale : scale}, ${adjustment.flipY ? -scale : scale}`;
  return svg
    ? `translate(${x}, ${y}) rotate(${rotate}) scale(${flipped})`
    : `translate(${x}px, ${y}px) rotate(${rotate}deg) scale(${flipped})`;
}

/** The angle and scale an element's own styles give it. */
function ownTurn(element: Element) {
  const style = getComputedStyle(element);
  const rotate = Number.parseFloat(style.rotate) || 0;
  const scale = Number.parseFloat(style.scale) || 1;
  return { rotate, scale };
}

/** Shapes inside an SVG, which take their transform as an attribute. */
function isInnerSvg(element: Element): element is SVGGraphicsElement {
  return (
    element instanceof SVGGraphicsElement && element.ownerSVGElement !== null
  );
}

// Elements found so far, so a key needn't be looked up each time.
const found = new Map<string, Element>();

function keyOf(element: Element) {
  const key = `${location.pathname}|${pathTo(element)}`;
  found.set(key, element);
  return key;
}

function resolve(key: string): Element | null {
  const split = key.indexOf('|');
  if (key.slice(0, split) !== location.pathname) return null;
  const known = found.get(key);
  if (known?.isConnected) return known;
  let element: Element | null = null;
  try {
    element = resolvePath(key.slice(split + 1));
  } catch {
    // A path from an older layout; it just won't apply.
  }
  if (element) found.set(key, element);
  return element;
}

// What each element had before the Arranger wrote to it, and what it wrote,
// so a re-render that replaces it is noticed and kept underneath.
const written = new Map<
  Element,
  { key: string; original: string | null; priority: string; base: string | null; value: string }
>();

/** Writes an element's adjustment, or restores it without one. */
function applyFree(element: Element, key: string, adjustment?: Adjustment) {
  const svg = isInnerSvg(element);
  const current = svg
    ? element.getAttribute('transform')
    : (element as HTMLElement | SVGElement).style.transform || null;
  const record = written.get(element);
  const original = record && current === record.value ? record.original : current;
  const unchanged = record && current === record.value;
  const priority = unchanged ? record.priority : (element as HTMLElement).style.getPropertyPriority('transform');
  const computed = svg ? null : getComputedStyle(element).transform;
  const base = unchanged ? record.base : current ?? (computed === 'none' ? null : computed);
  const set = (value: string | null) => {
    if (svg) {
      if (value) element.setAttribute('transform', value);
      else element.removeAttribute('transform');
    } else {
      if (value) (element as HTMLElement | SVGElement).style.setProperty('transform', value, adjustment ? 'important' : priority);
      else (element as HTMLElement | SVGElement).style.removeProperty('transform');
    }
  };
  if (!adjustment) {
    if (record) set(original);
    written.delete(element);
    return;
  }
  let value: string;
  if (svg) {
    // Turned and scaled about its own middle, inside any transform it has.
    const box = element.getBBox();
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    value =
      `${original ?? ''} translate(${cx}, ${cy}) ${transformOf(adjustment, true)} translate(${-cx}, ${-cy})`.trim();
  } else {
    value = `${transformOf(adjustment)} ${base ?? ''}`.trim();
  }
  if (value !== current) set(value);
  written.set(element, { key, original, priority, base, value });
}

/** Turns a drag on screen into the element's own coordinates. */
function toLocal(element: Element, dx: number, dy: number) {
  if (isInnerSvg(element)) {
    const ctm = (element.parentNode as SVGGraphicsElement).getScreenCTM?.();
    const k = ctm ? Math.hypot(ctm.a, ctm.b) || 1 : 1;
    return { x: dx / k, y: dy / k };
  }
  // The transform's translate runs inside the element's own rotation and
  // scale, so screen movement is turned back through them.
  const own = ownTurn(element);
  const angle = (-own.rotate * Math.PI) / 180;
  return {
    x: (dx * Math.cos(angle) - dy * Math.sin(angle)) / own.scale,
    y: (dx * Math.sin(angle) + dy * Math.cos(angle)) / own.scale,
  };
}

export function Arranger() {
  const [enabled, setEnabled] = React.useState(false);
  useToolboxExclusive(enabled, () => setEnabled(false));
  const [adjustments, setAdjustments] = React.useState<
    Record<string, Adjustment>
  >({});
  const [selected, setSelected] = React.useState<string[]>([]);
  const [hovered, setHovered] = React.useState<Element | null>(null);
  const state = React.useRef({ adjustments, selected });
  state.current = { adjustments, selected };

  // Elements are written to directly: now, and again every so often to catch
  // them after the page's own scripts re-render them.
  React.useLayoutEffect(() => {
    const apply = () => {
      const current = state.current.adjustments;
      for (const [key, adjustment] of Object.entries(current)) {
        const element = resolve(key);
        if (element) applyFree(element, key, adjustment);
      }
      for (const [element, record] of written) {
        if (!element.isConnected) written.delete(element);
        else if (!current[record.key] || resolve(record.key) !== element)
          applyFree(element, record.key);
      }
    };
    apply();
    const interval = setInterval(apply, 300);
    return () => clearInterval(interval);
  }, [adjustments]);

  /** Saves adjustments, naming each element the first time. */
  const commit = React.useCallback((updates: Record<string, Adjustment>) => {
    for (const [key, adjustment] of Object.entries(updates)) {
      if (adjustment.label) continue;
      const element = resolve(key);
      if (element) updates[key] = { ...adjustment, label: describe(element) };
    }
    setAdjustments((current) => ({ ...current, ...updates }));
  }, []);

  // While on, the whole page is the Arranger's: clicks select and drag rather
  // than reaching the page, apart from the toolbox's own UI.
  React.useLayoutEffect(() => {
    if (!enabled) return;
    const hit = (event: Event) => {
      const node = event.target;
      if (!(node instanceof Element) || isToolUi(node)) return null;
      if (node === document.body || node === document.documentElement)
        return null;
      // Past the empty wrappers and clear image pixels stacked over a spot,
      // to the first thing under the pointer that draws something.
      return event instanceof MouseEvent
        ? (pickAt(event.clientX, event.clientY) ?? node)
        : node;
    };
    const down = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const element = hit(event);
      if (!element) return;
      event.preventDefault();
      event.stopPropagation();
      const key = keyOf(element);
      const { selected: current, adjustments: saved } = state.current;
      if (event.shiftKey) {
        setSelected(
          current.includes(key)
            ? current.filter((k) => k !== key)
            : [...current, key],
        );
        return;
      }
      const keys = current.includes(key) ? current : [key];
      setSelected(keys);
      const targets = keys.flatMap((k) => {
        const target = resolve(k);
        return target
          ? [
              {
                key: k,
                element: target,
                start: saved[k] ?? IDENTITY,
                transition: (target as HTMLElement).style.transition,
              },
            ]
          : [];
      });
      // The elements' own transitions would trail the pointer.
      for (const target of targets)
        (target.element as HTMLElement).style.transition = 'none';
      const mode = event.altKey ? 'scale' : 'move';
      const origin = { x: event.clientX, y: event.clientY };
      const move = (moved: PointerEvent) => {
        const dx = moved.clientX - origin.x;
        const dy = moved.clientY - origin.y;
        const updates: Record<string, Adjustment> = {};
        for (const { key: k, element: target, start } of targets) {
          if (mode === 'move') {
            const local = toLocal(target, dx, dy);
            updates[k] = {
              ...start,
              x: Math.round(start.x + local.x),
              y: Math.round(start.y + local.y),
            };
          } else {
            updates[k] = {
              ...start,
              scale: Math.max(
                0.2,
                Math.round(start.scale * (1 + dx / 200) * 100) / 100,
              ),
            };
          }
        }
        commit(updates);
      };
      const end = () => {
        for (const target of targets)
          (target.element as HTMLElement).style.transition = target.transition;
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', end);
        window.removeEventListener('pointercancel', end);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', end);
      window.addEventListener('pointercancel', end);
    };
    const block = (event: Event) => {
      if (!hit(event)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    const hover = (event: PointerEvent) => setHovered(hit(event));
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (state.current.selected.length > 0) setSelected([]);
      else setEnabled(false);
    };
    const options = { capture: true };
    window.addEventListener('pointerdown', down, options);
    window.addEventListener('mousedown', block, options);
    window.addEventListener('click', block, options);
    window.addEventListener('dblclick', block, options);
    window.addEventListener('dragstart', block, options);
    window.addEventListener('pointermove', hover, options);
    window.addEventListener('keydown', key, options);
    return () => {
      window.removeEventListener('pointerdown', down, options);
      window.removeEventListener('mousedown', block, options);
      window.removeEventListener('click', block, options);
      window.removeEventListener('dblclick', block, options);
      window.removeEventListener('dragstart', block, options);
      window.removeEventListener('pointermove', hover, options);
      window.removeEventListener('keydown', key, options);
      setHovered(null);
    };
  }, [enabled, commit]);

  const single = selected.length === 1 ? selected[0] : null;

  return (
    <>
      <ToolboxItem
        label={enabled ? 'Close arranger' : 'Arranger'}
        active={enabled}
        order={3}
        badge={Object.keys(adjustments).length}
        onClick={() => setEnabled((on) => !on)}
      >
        <ArrangeIcon />
      </ToolboxItem>
      {enabled && (
        <ArrangeOutlines
          hovered={hovered}
          selected={selected.length > 1 ? selected : []}
        />
      )}
      {enabled && single && (
        <ArrangeHandles
          selected={single}
          adjustment={adjustments[single] ?? IDENTITY}
          onChange={(adjustment) => commit({ [single]: adjustment })}
        />
      )}
      {enabled && (
        <ArrangePanel
          onToggle={() => setEnabled((on) => !on)}
          selected={selected}
          adjustments={adjustments}
          onChange={(key, adjustment) => commit({ [key]: adjustment })}
          onReset={() => {
            setAdjustments({});
            setSelected([]);
          }}
        />
      )}
    </>
  );
}

/** Dashed boxes round the hovered element and each one in a group. */
function ArrangeOutlines({
  hovered,
  selected,
}: {
  hovered: Element | null;
  selected: string[];
}) {
  const [boxes, setBoxes] = React.useState<
    { key: string; rect: DOMRect; tone: 'hover' | 'selected' }[]
  >([]);
  React.useLayoutEffect(() => {
    let raf = 0;
    const tick = () => {
      const next: { key: string; rect: DOMRect; tone: 'hover' | 'selected' }[] =
        selected.flatMap((key) => {
          const element = resolve(key);
          return element
            ? [
                {
                  key,
                  rect: element.getBoundingClientRect(),
                  tone: 'selected' as const,
                },
              ]
            : [];
        });
      if (hovered?.isConnected)
        next.push({
          key: 'hovered',
          rect: hovered.getBoundingClientRect(),
          tone: 'hover',
        });
      setBoxes(next);
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [hovered, selected]);
  return (
    <>
      {boxes.map(({ key, rect, tone }) => (
        <div
          key={key}
          className={`tb-arrange-box is-${tone}`}
          style={{
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
          }}
        />
      ))}
    </>
  );
}

// A curved arrow, for the rotate handle's cursor, centred on its hotspot.
const ROTATE_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M18.5 9A7 7 0 1 0 19 15" fill="none" stroke="white" stroke-width="4" stroke-linecap="round"/><path d="M18.5 9A7 7 0 1 0 19 15" fill="none" stroke="black" stroke-width="1.75" stroke-linecap="round"/><path d="M20.5 4.5v5h-5" fill="none" stroke="white" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M20.5 4.5v5h-5" fill="none" stroke="black" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/></svg>',
)}") 12 12, grab`;

const CORNERS = [
  { x: 0, y: 0, cursor: 'nwse-resize' },
  { x: 1, y: 0, cursor: 'nesw-resize' },
  { x: 1, y: 1, cursor: 'nwse-resize' },
  { x: 0, y: 1, cursor: 'nesw-resize' },
] as const;

/** Where the selected element sits on screen, as an unrotated box. */
type Frame = {
  cx: number;
  cy: number;
  width: number;
  height: number;
  angle: number;
};

/** Reads the element's centre, size and angle from its layout and styles. */
function measure(element: Element, adjustment: Adjustment): Frame {
  const rect = element.getBoundingClientRect();
  const angle = ownTurn(element).rotate + adjustment.rotate;
  const radians = (angle * Math.PI) / 180;
  const [w, h] =
    element instanceof HTMLElement
      ? [element.offsetWidth, element.offsetHeight]
      : isInnerSvg(element)
        ? [element.getBBox().width, element.getBBox().height]
        : [element.clientWidth, element.clientHeight];
  // The bounding box of a w×h box turned by the angle, solved for the
  // overall scale, so scaled ancestors are accounted for too.
  const span = w * Math.abs(Math.cos(radians)) + h * Math.abs(Math.sin(radians));
  const k = span > 0 ? rect.width / span : 1;
  return {
    cx: rect.left + rect.width / 2,
    cy: rect.top + rect.height / 2,
    width: w * k,
    height: h * k,
    angle,
  };
}

/**
 * The selected element's frame, drawn over it: corners to scale it from its
 * centre, and a handle above it to turn it.
 */
function ArrangeHandles({
  selected,
  adjustment,
  onChange,
}: {
  selected: string;
  adjustment: Adjustment;
  onChange: (adjustment: Adjustment) => void;
}) {
  const [frame, setFrame] = React.useState<Frame | null>(null);
  const adjustmentRef = React.useRef(adjustment);
  adjustmentRef.current = adjustment;

  // Followed every frame, so the handles keep up with drags, scrolling and
  // the page's own layout changes.
  React.useLayoutEffect(() => {
    let raf = 0;
    const tick = () => {
      const element = resolve(selected);
      const next = element ? measure(element, adjustmentRef.current) : null;
      setFrame((current) =>
        current &&
        next &&
        Math.abs(current.cx - next.cx) < 0.25 &&
        Math.abs(current.cy - next.cy) < 0.25 &&
        Math.abs(current.width - next.width) < 0.25 &&
        Math.abs(current.height - next.height) < 0.25 &&
        Math.abs(current.angle - next.angle) < 0.05
          ? current
          : next,
      );
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [selected]);

  if (!frame) return null;

  const drag = (mode: 'scale' | 'rotate') => (event: PointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);
    const start = adjustment;
    const { cx, cy } = frame;
    const startDistance = Math.hypot(event.clientX - cx, event.clientY - cy);
    const startAngle = Math.atan2(event.clientY - cy, event.clientX - cx);
    const move = (moved: PointerEvent) => {
      if (mode === 'scale') {
        const distance = Math.hypot(moved.clientX - cx, moved.clientY - cy);
        onChange({
          ...start,
          scale: Math.max(
            0.2,
            Math.round(((start.scale * distance) / (startDistance || 1)) * 100) /
              100,
          ),
        });
      } else {
        const angle = Math.atan2(moved.clientY - cy, moved.clientX - cx);
        const turned = start.rotate + ((angle - startAngle) * 180) / Math.PI;
        const step = moved.shiftKey ? 15 : 1;
        onChange({ ...start, rotate: Math.round(turned / step) * step });
      }
    };
    const end = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', end);
      target.removeEventListener('pointercancel', end);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', end);
    target.addEventListener('pointercancel', end);
  };

  return (
    <div
      className="tb-arrange-frame"
      style={{
        left: frame.cx - frame.width / 2,
        top: frame.cy - frame.height / 2,
        width: frame.width,
        height: frame.height,
        transform: `rotate(${frame.angle}deg)`,
      }}
    >
      {CORNERS.map((corner) => (
        <span
          key={`${corner.x}-${corner.y}`}
          onPointerDown={drag('scale')}
          className="tb-handle"
          style={{
            left: `${corner.x * 100}%`,
            top: `${corner.y * 100}%`,
            cursor: corner.cursor,
          }}
        />
      ))}
      <span className="tb-rotate-stem" />
      <span
        onPointerDown={drag('rotate')}
        title="Drag to rotate (Shift snaps to 15°)"
        className="tb-rotate-handle"
        style={{ cursor: ROTATE_CURSOR }}
      />
    </div>
  );
}

const FIELDS: {
  key: 'x' | 'y' | 'rotate' | 'scale';
  label: string;
  step: number;
}[] = [
  { key: 'x', label: 'X', step: 1 },
  { key: 'y', label: 'Y', step: 1 },
  { key: 'rotate', label: 'Rotate', step: 1 },
  { key: 'scale', label: 'Scale', step: 0.01 },
];

function ArrangePanel({
  onToggle,
  selected,
  adjustments,
  onChange,
  onReset,
}: {
  onToggle: () => void;
  selected: string[];
  adjustments: Record<string, Adjustment>;
  onChange: (key: string, adjustment: Adjustment) => void;
  onReset: () => void;
}) {
  const clipboard = useClipboard();
  const drag = useDraggablePanel();
  const single = selected.length === 1 ? selected[0] : null;
  const current = single ? (adjustments[single] ?? IDENTITY) : null;
  const element = single ? resolve(single) : null;
  const name = single
    ? (adjustments[single]?.label ?? (element ? describe(element) : single))
    : null;
  const flip = (key: 'flipX' | 'flipY') => {
    // Flipped together, and left out of the saved values while off.
    const on = selected.every((k) => adjustments[k]?.[key]);
    for (const k of selected) {
      const { [key]: _was, ...rest } = adjustments[k] ?? IDENTITY;
      onChange(k, on ? rest : { ...rest, [key]: true });
    }
  };
  return (
    <div
      data-panel="arranger"
      style={drag.style}
      onPointerDown={drag.handle.onPointerDown}
      className={`tb-panel tb-panel-arrange ${drag.handle.className}`}
    >
      <div className="tb-flex tb-between tb-center-y">
        <span className="tb-title">Arranger</span>
        <button type="button" className="tb-button is-primary" onClick={onToggle}>
          Done
        </button>
      </div>
      {selected.length > 0 ? (
        <div className="tb-stack-8">
          {single && current ? (
            <span className="tb-muted tb-truncate" title={name ?? ''}>
              {name}
            </span>
          ) : (
            <span className="tb-muted">{selected.length} elements grouped</span>
          )}
          {single && current && (
            <div className="tb-grid-2">
              {FIELDS.slice(0, 2).map((field) => (
                <ArrangeField
                  key={field.key}
                  field={field}
                  value={current[field.key]}
                  onChange={(value) =>
                    onChange(single, { ...current, [field.key]: value })
                  }
                />
              ))}
            </div>
          )}
          {/* Turn, scale and the flips share a row. */}
          <div className="tb-flex tb-gap-8 tb-end-y">
            {single &&
              current &&
              FIELDS.slice(2).map((field) => (
                <ArrangeField
                  key={field.key}
                  field={field}
                  value={current[field.key]}
                  onChange={(value) =>
                    onChange(single, { ...current, [field.key]: value })
                  }
                />
              ))}
            {(
              [
                { key: 'flipX', label: 'Flip horizontal', turn: 0 },
                { key: 'flipY', label: 'Flip vertical', turn: 90 },
              ] as const
            ).map((option) => {
              const on = selected.every((k) => adjustments[k]?.[option.key]);
              return (
                <button
                  key={option.key}
                  type="button"
                  aria-pressed={on}
                  aria-label={option.label}
                  title={option.label}
                  onClick={() => flip(option.key)}
                  className={`tb-flip ${on ? 'is-on' : ''}`}
                >
                  <FlipIcon turn={option.turn} />
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        <p className="tb-muted tb-m0">
          Click anything to select it. Drag to move, ⌥-drag to scale,
          Shift-click to group.
        </p>
      )}
      <div className="tb-flex tb-gap-8">
        <button
          type="button"
          className="tb-button"
          onClick={() => {
            void clipboard.copy(JSON.stringify(adjustments, null, 2));
          }}
        >
          {clipboard.label('Copy values')}
        </button>
        <button type="button" className="tb-button is-plain" onClick={onReset}>
          Reset all
        </button>
      </div>
      <CopyForAI
        tool="Arranger"
        getData={() => ({
          // Keys are `page|selector`, with a label saying what each is.
          adjustments,
          selected,
        })}
      />
    </div>
  );
}

/** One of the panel's number fields, labelled above. */
function ArrangeField({
  field,
  value,
  onChange,
}: {
  field: (typeof FIELDS)[number];
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="tb-field">
      {field.label}
      <input
        type="number"
        min={field.key === 'scale' ? 0.05 : undefined}
        step={field.step}
        value={value}
        onInput={(event: Event) => {
          const value = Number((event.target as HTMLInputElement).value);
          if (Number.isFinite(value)) onChange(field.key === 'scale' ? Math.max(0.05, value) : value);
        }}
        className="tb-input tb-input-number"
      />
    </label>
  );
}

/** Two halves mirrored across a dashed line, upright or turned on its side. */
function FlipIcon({ turn }: { turn: number }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinejoin="round"
      aria-hidden
      style={{ rotate: `${turn}deg` }}
    >
      <path d="M7 1v12" strokeDasharray="1.5 1.5" />
      <path d="M5 3 1 11h4V3Z" fill="currentColor" />
      <path d="m9 3 4 8H9V3Z" />
    </svg>
  );
}

function ArrangeIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 18 18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="tb-tool-move"
    >
      <path d="M9 2v14M2 9h14M9 2 7 4M9 2l2 2M9 16l-2-2M9 16l2-2M2 9l2-2M2 9l2 2M16 9l-2-2M16 9l-2 2" />
    </svg>
  );
}
