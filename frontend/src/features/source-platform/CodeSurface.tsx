// The code on screen, read or written: CodeMirror, on this chunk alone, so that no other page
// carries it. A file's text is only ever a document here, never markup. `codeSetup` says what it
// can do. Reading, a click on a line number links to that line, and so does Enter on the line the
// caret is on. Writing, Tab indents, and Escape then Tab leaves the editor, as CodeMirror's own
// rule for keyboard users has it; Escape never reaches the form around it.
import { gotoLine, openSearchPanel } from '@codemirror/search';
import {
  Compartment,
  EditorSelection,
  EditorState,
  type Extension,
  RangeSet,
  StateEffect,
  StateField,
} from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  GutterMarker,
  gutterLineClass,
  lineNumbers,
} from '@codemirror/view';
import { useEffect, useRef } from 'react';
import { editingState, indentOf, viewingState } from './codeSetup';
import { grammarOf } from './fileFacts';

export type CodeSurfaceProps = {
  value: string;
  path: string;
  /** Names the text for a screen reader. */
  label: string;
  /** The line to mark and scroll to (1-based); one past the end marks nothing. */
  line?: number;
  onLine?: (line: number) => void;
  /** Present, the text can be edited. */
  onChange?: (value: string) => void;
  /** Hands over what the page's own buttons do, and takes it back. */
  onCommands?: (commands: CodeCommands | null) => void;
};

export type CodeCommands = { find: () => void; goToLine: () => void };

const markLine = StateEffect.define<number | null>();
const MARK = Decoration.line({ class: 'cm-line-target' });
const marked = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, transaction) {
    for (const effect of transaction.effects)
      if (effect.is(markLine))
        return effect.value === null ? Decoration.none : Decoration.set(MARK.range(effect.value));
    return marks;
  },
  provide: (field) => EditorView.decorations.from(field),
});
const numberMark = new (class extends GutterMarker {
  elementClass = 'cm-line-target-number';
})();
const markedNumber = gutterLineClass.compute([marked], (state) => {
  const first = state.field(marked).iter();
  return first.value ? RangeSet.of(numberMark.range(first.from)) : RangeSet.empty;
});

function reading(
  label: string,
  text: string,
  path: string,
  onLine?: (line: number) => void,
): Extension {
  const linkCaret = (view: EditorView) => {
    onLine?.(view.state.doc.lineAt(view.state.selection.main.head).number);
    return true;
  };
  return [
    // It stays editable to the browser, for a caret and the keyboard, and asks a phone for no
    // keyboard. The state refuses every change.
    viewingState(indentOf(text, path), [{ key: 'Enter', run: linkCaret }]),
    EditorView.contentAttributes.of({ 'aria-label': label, inputmode: 'none' }),
    lineNumbers({
      domEventHandlers: {
        click(view, block) {
          onLine?.(view.state.doc.lineAt(block.from).number);
          return true;
        },
      },
    }),
  ];
}

function writing(
  label: string,
  text: string,
  path: string,
  onChange: (value: string) => void,
): Extension {
  return [
    editingState(indentOf(text, path)),
    EditorView.contentAttributes.of({ 'aria-label': label }),
    lineNumbers(),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) onChange(update.state.doc.toString());
    }),
  ];
}

/** Whether a key press belongs to the page: typing in a field, or a dialog over it. */
const elsewhere = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.closest('input, textarea, select, [contenteditable="true"]') !== null ||
    document.querySelector('dialog[open]') !== null);

export default function CodeSurface({
  value,
  path,
  label,
  line,
  onLine,
  onChange,
  onCommands,
}: CodeSurfaceProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView>(null);
  const grammar = useRef(new Compartment());
  const onLineNow = useRef(onLine);
  onLineNow.current = onLine;
  const onChangeNow = useRef(onChange);
  onChangeNow.current = onChange;
  const editable = Boolean(onChange);
  // The document is this view's own from here on: a new file is a new surface (`key`).
  // biome-ignore lint/correctness/useExhaustiveDependencies: the start of one document.
  useEffect(() => {
    const made = new EditorView({
      parent: host.current as HTMLDivElement,
      state: EditorState.create({
        doc: value,
        extensions: [
          grammar.current.of([]),
          marked,
          markedNumber,
          editable
            ? writing(label, value, path, (next) => onChangeNow.current?.(next))
            : reading(label, value, path, (at) => onLineNow.current?.(at)),
        ],
      }),
    });
    view.current = made;
    const find = () => {
      made.focus();
      openSearchPanel(made);
    };
    const goToLine = () => {
      made.focus();
      gotoLine(made);
    };
    onCommands?.({ find, goToLine });
    // Lines off screen are not in the page, so the browser's find can't see them. Ours can.
    const findHere = (event: KeyboardEvent) => {
      const asked = (event.metaKey || event.ctrlKey) && !event.altKey && event.key === 'f';
      if (!asked || elsewhere(event.target) || made.hasFocus) return;
      event.preventDefault();
      find();
    };
    if (!editable) window.addEventListener('keydown', findHere);
    return () => {
      window.removeEventListener('keydown', findHere);
      onCommands?.(null);
      view.current = null;
      made.destroy();
    };
  }, [editable]);
  useEffect(() => {
    let current = true;
    grammarOf(path, value.length)
      .then((extension) => {
        if (current && extension)
          view.current?.dispatch({ effects: grammar.current.reconfigure(extension) });
      })
      .catch(() => {}); // A grammar that fails to load leaves plain text.
    return () => {
      current = false;
    };
  }, [path, value.length]);
  useEffect(() => {
    const code = view.current;
    if (!code) return;
    const { doc } = code.state;
    if (!line || line > doc.lines) {
      code.dispatch({ effects: markLine.of(null) });
      return;
    }
    const { from } = doc.line(line);
    code.dispatch({
      selection: EditorSelection.cursor(from),
      effects: [markLine.of(from), EditorView.scrollIntoView(from, { y: 'center' })],
    });
  }, [line]);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: it only keeps Escape from the form.
    <div
      ref={host}
      className="code-surface"
      onKeyDown={(event) => {
        if (event.key === 'Escape') event.stopPropagation();
      }}
    />
  );
}
