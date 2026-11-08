import React from 'react';
import { useClipboard } from '../core/clipboard';
import {
  CopyForAI,
  ToolboxItem,
  useDraggablePanel,
  useToolboxExclusive,
} from '../core/toolbox';
import { componentName, describe, pathTo } from '../core/describe';
import { isToolUi } from '../core/dom';
import { pickAt } from '../core/hit-test';
import { CloseIcon } from './text-editor';

/**
 * Annotate: while it's on, a click anywhere on the page drops a numbered pin
 * there with a note typed beside it. Each pin holds on to the element it was
 * dropped on, so it follows that element as the page scrolls or reflows. The
 * notes are listed to copy or send on, and live only in the open tab.
 */

type Note = {
  id: number;
  el: Element;
  name: string;
  /** Where the pin sits on its element, as fractions of its box. */
  fx: number;
  fy: number;
  text: string;
};

/** What a click lands on: the element that shows there, else the page. */
function noteTarget(event: MouseEvent) {
  if (isToolUi(event.target)) return null;
  return pickAt(event.clientX, event.clientY) ?? document.body;
}

/** A pin's point on screen, or null once its element has left the page. */
function pinPoint(note: Note) {
  if (!note.el.isConnected) return null;
  const r = note.el.getBoundingClientRect();
  return { x: r.left + note.fx * r.width, y: r.top + note.fy * r.height };
}

export function Annotate() {
  const [open, setOpen] = React.useState(false);
  const [notes, setNotes] = React.useState<Note[]>([]);
  const [hovered, setHovered] = React.useState<Element | null>(null);
  const [editing, setEditing] = React.useState<number | null>(null);
  const [draft, setDraft] = React.useState('');
  const clipboard = useClipboard();
  const [, setFrame] = React.useState(0);
  const nextId = React.useRef(1);
  const drag = useDraggablePanel();
  useToolboxExclusive(open, () => setOpen(false));

  // The page's click handlers read these, so they always see the latest.
  const live = React.useRef({ editing, draft });
  live.current = { editing, draft };

  // Saves the note being written, dropping it if it was left empty.
  const commit = React.useCallback(() => {
    const { editing: id, draft: text } = live.current;
    if (id === null) return;
    setNotes((current) =>
      text.trim()
        ? current.map((n) => (n.id === id ? { ...n, text: text.trim() } : n))
        : current.filter((n) => n.id !== id),
    );
    setEditing(null);
  }, []);

  // Leaves the note as it was; a new one with nothing in it goes.
  const cancel = React.useCallback(() => {
    const id = live.current.editing;
    setNotes((current) => current.filter((n) => n.id !== id || n.text));
    setEditing(null);
  }, []);

  const edit = (note: Note) => {
    if (note.id === editing) return;
    commit();
    setDraft(note.text);
    setEditing(note.id);
  };

  // While on, hovering outlines what a pin would go on and a click drops one,
  // with links and buttons held so the click doesn't go anywhere.
  React.useLayoutEffect(() => {
    if (!open) return;
    const move = (e: MouseEvent) =>
      setHovered(isToolUi(e.target) ? null : noteTarget(e));
    const block = (e: MouseEvent) => {
      if (isToolUi(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
    };
    const pick = (e: MouseEvent) => {
      const el = noteTarget(e);
      if (!el) return;
      e.preventDefault();
      e.stopPropagation();
      commit();
      const r = el.getBoundingClientRect();
      const note: Note = {
        id: nextId.current++,
        el,
        name: componentName(el) ?? describe(el),
        fx: r.width ? (e.clientX - r.left) / r.width : 0,
        fy: r.height ? (e.clientY - r.top) / r.height : 0,
        text: '',
      };
      setNotes((current) => [...current, note]);
      setDraft('');
      setEditing(note.id);
    };
    document.addEventListener('mousemove', move, true);
    document.addEventListener('pointerdown', block, true);
    document.addEventListener('mousedown', block, true);
    document.addEventListener('click', pick, true);
    // Pins follow their elements as the page scrolls and moves.
    let raf = 0;
    const tick = () => {
      setFrame((n) => n + 1);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      document.removeEventListener('mousemove', move, true);
      document.removeEventListener('pointerdown', block, true);
      document.removeEventListener('mousedown', block, true);
      document.removeEventListener('click', pick, true);
      cancelAnimationFrame(raf);
      setHovered(null);
      commit();
    };
  }, [open, commit]);

  const remove = (note: Note) => {
    if (note.id === editing) setEditing(null);
    setNotes((current) => current.filter((n) => n !== note));
  };

  const saved = notes.filter((n) => n.text);
  const number = (note: Note) => notes.indexOf(note) + 1;
  const summary = [
    `Notes on ${location.href}`,
    ...saved.map((n) => `${number(n)}. ${n.name}: ${n.text}`),
  ].join('\n');
  const writing = notes.find((n) => n.id === editing);

  return (
    <>
      {open && hovered && !writing && <Outline el={hovered} />}
      {open &&
        notes.map((note) => {
          const at = pinPoint(note);
          if (!at) return null;
          return (
            <button
              key={note.id}
              type="button"
              aria-label={`Note ${number(note)}`}
              title={note.text}
              className={note.id === editing ? 'tb-pin is-editing' : 'tb-pin'}
              style={{ left: at.x, top: at.y }}
              onClick={() => edit(note)}
            >
              {number(note)}
            </button>
          );
        })}
      {open && writing && (
        <NoteEditor
          at={pinPoint(writing)}
          number={number(writing)}
          draft={draft}
          onDraft={setDraft}
          onSave={commit}
          onCancel={cancel}
          onDelete={() => remove(writing)}
        />
      )}
      <ToolboxItem
        label={open ? 'Close annotate' : 'Annotate'}
        active={open}
        order={6}
        badge={saved.length}
        onClick={() => setOpen(!open)}
      >
        <NoteIcon />
      </ToolboxItem>
      {open && (
        <aside
          data-panel="annotate"
          style={drag.style}
          onPointerDown={drag.handle.onPointerDown}
          className={`tb-panel tb-panel-text ${drag.handle.className}`}
        >
          <div className="tb-panel-head">
            <span className="tb-title">Annotate</span>
            <span className="tb-muted">Click anywhere to pin a note</span>
          </div>
          {saved.length > 0 && (
            <ul className="tb-list tb-divide">
              {saved.map((note) => (
                <li key={note.id} className="tb-row">
                  <span className="tb-note-number">{number(note)}</span>
                  <button
                    type="button"
                    className="tb-edit-diff"
                    onClick={() => {
                      note.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
                      edit(note);
                    }}
                  >
                    <span className="tb-note-text">{note.text}</span>
                    <span className="tb-note-on">{note.name}</span>
                  </button>
                  <button
                    type="button"
                    aria-label="Delete this note"
                    className="tb-icon-button"
                    onClick={() => remove(note)}
                  >
                    <CloseIcon />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="tb-panel-foot">
            <CopyForAI
              tool="Annotate"
              getData={() => ({
                summary,
                notes: saved.map((n) => ({
                  number: number(n),
                  note: n.text,
                  component: n.name,
                  element: describe(n.el),
                  selector: pathTo(n.el),
                })),
              })}
            />
            <div className="tb-links">
              <button
                type="button"
                disabled={saved.length === 0}
                onClick={() => {
                  void clipboard.copy(summary);
                }}
              >
                {clipboard.label('Copy notes')}
              </button>
              <button
                type="button"
                disabled={notes.length === 0}
                onClick={() => {
                  setEditing(null);
                  setNotes([]);
                }}
              >
                Clear all
              </button>
            </div>
          </div>
        </aside>
      )}
    </>
  );
}

/** The box a note is typed in, beside its pin and kept on screen. */
function NoteEditor({
  at,
  number,
  draft,
  onDraft,
  onSave,
  onCancel,
  onDelete,
}: {
  at: { x: number; y: number } | null;
  number: number;
  draft: string;
  onDraft: (text: string) => void;
  onSave: () => void;
  onCancel: () => void;
  onDelete: () => void;
}) {
  const field = React.useRef<HTMLTextAreaElement>(null);
  React.useLayoutEffect(() => {
    field.current?.focus();
  }, [number]);
  const width = 248;
  const left = Math.max(8, Math.min((at?.x ?? 0) + 18, innerWidth - width - 8));
  const top = Math.max(8, Math.min((at?.y ?? 0) - 8, innerHeight - 140));
  return (
    <div data-no-drag className="tb-note-pop" style={{ left, top, width }}>
      <textarea
        ref={field}
        value={draft}
        rows={3}
        placeholder={`Note ${number}…`}
        className="tb-note-field"
        onInput={(event: Event) =>
          onDraft((event.target as HTMLTextAreaElement).value)
        }
        onKeyDown={(event: KeyboardEvent) => {
          // Enter saves; Shift+Enter breaks the line.
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            onSave();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          }
          event.stopPropagation();
        }}
      />
      <div className="tb-flex tb-between tb-center-y">
        <span className="tb-faint">Enter saves · Esc cancels</span>
        <div className="tb-links">
          <button type="button" onClick={onDelete}>
            Delete
          </button>
          <button type="button" onClick={onSave}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

/** A box round what a pin would be dropped on. */
function Outline({ el }: { el: Element }) {
  const r = el.getBoundingClientRect();
  return (
    <div
      aria-hidden
      className="tb-text-outline"
      style={{ left: r.left, top: r.top, width: r.width, height: r.height }}
    />
  );
}

/** A speech bubble whose lines write themselves while hovered. */
function NoteIcon() {
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
      <path d="M3.5 2.75h11a1.75 1.75 0 0 1 1.75 1.75v6.5a1.75 1.75 0 0 1-1.75 1.75H8l-3.5 3v-3h-1a1.75 1.75 0 0 1-1.75-1.75V4.5A1.75 1.75 0 0 1 3.5 2.75Z" />
      <path d="M5.5 6.5h7M5.5 9h4" className="tb-tool-move" />
    </svg>
  );
}
