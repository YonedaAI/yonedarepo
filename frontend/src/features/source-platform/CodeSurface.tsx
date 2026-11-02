// The code on screen, read or written: CodeMirror, on this chunk alone, so that no other page
// carries it. A file's text is only ever a document here, never markup. Reading, a click on a
// line number links to that line. Writing, Tab indents, and Escape then Tab leaves the editor,
// as CodeMirror's own rule for keyboard users has it; Escape never reaches the form around it.
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import {
  Compartment,
  EditorState,
  type Extension,
  RangeSet,
  StateEffect,
  StateField,
} from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  drawSelection,
  EditorView,
  GutterMarker,
  gutterLineClass,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { useEffect, useRef } from 'react';
import { codeHighlight, codeTheme } from './codeTheme';
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
};

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

function reading(label: string, onLine?: (line: number) => void): Extension {
  return [
    EditorState.readOnly.of(true),
    // Not editable, so a phone's keyboard stays down; still focusable, to scroll and search.
    EditorView.editable.of(false),
    EditorView.contentAttributes.of({ tabindex: '0', 'aria-label': label }),
    lineNumbers({
      domEventHandlers: {
        click(view, block) {
          onLine?.(view.state.doc.lineAt(block.from).number);
          return true;
        },
      },
    }),
    keymap.of(searchKeymap),
  ];
}

function writing(label: string, onChange: (value: string) => void): Extension {
  return [
    EditorView.contentAttributes.of({ 'aria-label': label }),
    lineNumbers(),
    history(),
    drawSelection(),
    indentOnInput(),
    bracketMatching(),
    highlightSelectionMatches(),
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) onChange(update.state.doc.toString());
    }),
  ];
}

export default function CodeSurface({
  value,
  path,
  label,
  line,
  onLine,
  onChange,
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
          codeTheme,
          syntaxHighlighting(codeHighlight),
          search({ top: true }),
          marked,
          markedNumber,
          editable
            ? writing(label, (next) => onChangeNow.current?.(next))
            : reading(label, (at) => onLineNow.current?.(at)),
        ],
      }),
    });
    view.current = made;
    return () => {
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
