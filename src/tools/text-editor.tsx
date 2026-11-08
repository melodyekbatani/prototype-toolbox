import React from 'react';
import { useClipboard } from '../core/clipboard';
import {
  CopyForAI,
  ToolboxItem,
  useDraggablePanel,
  useToolboxExclusive,
} from '../core/toolbox';
import { componentName, describe, pathTo } from '../core/describe';
import { isToolUi, realTarget } from '../core/dom';

/**
 * Content editor: while it's on, any text on the page can be clicked and
 * typed over in place. Each change is listed with what it was, to copy or
 * send on. The edits live only in the page, so they're gone on a refresh or
 * whenever the page's own scripts redraw that text.
 */

type Edit = { el: HTMLElement; name: string; before: string; after: string; nodes: Node[]; text: [Node, string | null][] };

function snapshot(el: HTMLElement) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const text: [Node, string | null][] = [];
  while (walker.nextNode()) text.push([walker.currentNode, walker.currentNode.nodeValue]);
  return { nodes: [...el.childNodes], text };
}

/** The text node under a point on screen, as the caret would land there. */
function textNodeAt(x: number, y: number) {
  const doc = document as Document & {
    caretPositionFromPoint?: (
      x: number,
      y: number,
    ) => { offsetNode: Node } | null;
  };
  const node =
    doc.caretPositionFromPoint?.(x, y)?.offsetNode ??
    document.caretRangeFromPoint?.(x, y)?.startContainer;
  if (node?.nodeType !== Node.TEXT_NODE || !node.textContent?.trim())
    return null;
  // The caret snaps to the nearest text, so it counts only if the pointer is
  // on the text itself.
  const range = document.createRange();
  range.selectNodeContents(node);
  const onIt = [...range.getClientRects()].some(
    (r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom,
  );
  return onIt ? node : null;
}

/**
 * The element whose text is under the pointer: found by the text itself, so
 * it's reached through overlays, labels and wrappers stacked over it, or
 * else the element clicked when it has text of its own.
 */
function textTarget(event: MouseEvent) {
  if (isToolUi(event.target)) return null;
  const node = textNodeAt(event.clientX, event.clientY);
  const parent = node?.parentElement;
  if (parent && parent !== document.body && !isToolUi(parent) && !parent.closest('input,textarea,select,script,style,[contenteditable="true"]')) return parent;
  const target = realTarget(event);
  if (!(target instanceof HTMLElement) || isToolUi(target)) return null;
  if (target.closest('input,textarea,select,script,style')) return null;
  if (target === document.body || target === document.documentElement)
    return null;
  const ownText = [...target.childNodes].some(
    (child) => child.nodeType === Node.TEXT_NODE && child.textContent?.trim(),
  );
  return ownText ? target : null;
}

export function TextEditor() {
  const [open, setOpen] = React.useState(false);
  const [hovered, setHovered] = React.useState<HTMLElement | null>(null);
  const [editing, setEditing] = React.useState<HTMLElement | null>(null);
  const [edits, setEdits] = React.useState<Edit[]>([]);
  const clipboard = useClipboard();
  const drag = useDraggablePanel();
  useToolboxExclusive(open, () => setOpen(false));

  // Notes what the text is now, dropping the entry once it's back as it was.
  const record = React.useCallback((el: HTMLElement) => {
    setEdits((current) => {
      const after = el.textContent ?? '';
      const found = current.find((e) => e.el === el);
      if (!found) return current;
      return current.map((e) => (e === found ? { ...e, after } : e));
    });
  }, []);

  // While on, hovering outlines text and a click starts typing in it, with
  // links and buttons held so the click doesn't go anywhere.
  React.useLayoutEffect(() => {
    if (!open) return;
    const move = (e: MouseEvent) => setHovered(textTarget(e));
    const block = (e: MouseEvent) => {
      const el = textTarget(e);
      if (!el || el.isContentEditable) return;
      e.preventDefault();
      e.stopPropagation();
    };
    const pick = (e: MouseEvent) => {
      const el = textTarget(e);
      if (!el || el.isContentEditable) return;
      e.preventDefault();
      e.stopPropagation();
      setEdits((current) =>
        current.some((x) => x.el === el)
          ? current
          : [
              ...current,
              {
                el,
                name: componentName(el) ?? describe(el),
                before: el.textContent ?? '',
                after: el.textContent ?? '',
                ...snapshot(el),
              },
            ],
      );
      setEditing(el);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      if (document.activeElement instanceof HTMLElement)
        document.activeElement.blur();
      setEditing(null);
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
      setHovered(null);
      setEditing(null);
    };
  }, [open]);

  // The element being typed in is editable only while it's the one picked,
  // with the caret dropped at the end of its text.
  React.useLayoutEffect(() => {
    if (!editing) return;
    const previousEditable = editing.getAttribute('contenteditable');
    editing.contentEditable = 'plaintext-only';
    if (editing.contentEditable !== 'plaintext-only')
      editing.contentEditable = 'true';
    editing.focus();
    const range = document.createRange();
    range.selectNodeContents(editing);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    const input = () => record(editing);
    const keydown = (e: KeyboardEvent) => {
      // Enter finishes, rather than breaking the line.
      if (e.key === 'Enter') {
        e.preventDefault();
        setEditing(null);
      }
    };
    editing.addEventListener('input', input);
    editing.addEventListener('keydown', keydown);
    return () => {
      editing.removeEventListener('input', input);
      editing.removeEventListener('keydown', keydown);
      if (previousEditable === null) editing.removeAttribute('contenteditable');
      else editing.setAttribute('contenteditable', previousEditable);
      record(editing);
    };
  }, [editing, record]);

  const reset = (edit: Edit) => {
    if (edit.el === editing) setEditing(null);
    for (const [node, value] of edit.text) node.nodeValue = value;
    edit.el.replaceChildren(...edit.nodes);
    setEdits((current) => current.filter((e) => e !== edit));
  };

  const changed = edits.filter((e) => e.before !== e.after);
  const summary = [
    `Copy edits on ${location.href}`,
    ...changed.map((e) => `${e.name}: "${e.before}" → "${e.after}"`),
  ].join('\n');

  return (
    <>
      {open && hovered && hovered !== editing && <Outline el={hovered} />}
      {open && editing && <Outline el={editing} editing />}
      <ToolboxItem
        label={open ? 'Close content editor' : 'Content editor'}
        active={open}
        order={4}
        badge={changed.length}
        onClick={() => setOpen(!open)}
      >
        <TextIcon />
      </ToolboxItem>
      {open && (
        <aside
          data-panel="content-editor"
          style={drag.style}
          onPointerDown={drag.handle.onPointerDown}
          className={`tb-panel tb-panel-text ${drag.handle.className}`}
        >
          <div className="tb-panel-head">
            <span className="tb-title">Content editor</span>
            <span className="tb-muted">Click any text to type over it</span>
          </div>
          {changed.length > 0 && (
            <ul className="tb-list tb-divide">
              {changed.map((edit) => (
                <li key={edit.name + edit.before} className="tb-row">
                  <button
                    type="button"
                    className="tb-edit-diff"
                    onClick={() => setEditing(edit.el)}
                  >
                    <span className="tb-before">{edit.before}</span>
                    <span className="tb-after">{edit.after}</span>
                  </button>
                  <button
                    type="button"
                    aria-label="Undo this edit"
                    className="tb-icon-button"
                    onClick={() => reset(edit)}
                  >
                    <CloseIcon />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="tb-panel-foot">
            <CopyForAI
              tool="Content editor"
              getData={() => ({
                summary,
                edits: changed.map((e) => ({
                  component: e.name,
                  element: describe(e.el),
                  selector: pathTo(e.el),
                  before: e.before,
                  after: e.after,
                })),
              })}
            />
            <div className="tb-links">
              <button
                type="button"
                disabled={changed.length === 0}
                onClick={() => {
                  void clipboard.copy(summary);
                }}
              >
                {clipboard.label('Copy edits')}
              </button>
              <button
                type="button"
                disabled={edits.length === 0}
                onClick={() => [...edits].reverse().forEach(reset)}
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

/** A box round the text under the pointer, or the text being typed in. */
function Outline({ el, editing = false }: { el: HTMLElement; editing?: boolean }) {
  const [, setFrame] = React.useState(0);
  // Follows the text as it grows while typing, or the page scrolls.
  React.useLayoutEffect(() => {
    let raf = 0;
    const tick = () => {
      setFrame((n) => n + 1);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  const r = el.getBoundingClientRect();
  return (
    <div
      aria-hidden
      className={editing ? 'tb-text-outline is-editing' : 'tb-text-outline'}
      style={{
        left: r.left - 3,
        top: r.top - 2,
        width: r.width + 6,
        height: r.height + 4,
      }}
    />
  );
}

export function CloseIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

/** Lines of text with a pencil at the last, which writes while hovered. */
function TextIcon() {
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
    >
      <path d="M2.75 4.5h10.5M2.75 8.5h7M2.75 12.5h3.5" />
      <path
        d="M10.75 15.25 11.3 13l4.2-4.2a1.25 1.25 0 0 1 1.75 1.75l-4.2 4.2Z"
        className="tb-tool-move"
      />
    </svg>
  );
}
