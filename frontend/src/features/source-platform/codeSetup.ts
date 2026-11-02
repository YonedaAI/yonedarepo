// What makes the code surface an editor: the same colors, numbers, folding, line highlight,
// bracket matching, find and go to line whether a file is read or written, and history,
// auto-indent and every editing key on top when it is written. Several cursors work in both:
// reading, they select; writing, they type.
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
} from '@codemirror/language';
import { gotoLine, highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { EditorState, type Extension } from '@codemirror/state';
import {
  crosshairCursor,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  type KeyBinding,
  keymap,
  rectangularSelection,
} from '@codemirror/view';
import { codeHighlight, codeTheme } from './codeTheme';

/** Lines looked at to tell how a file indents. */
const SAMPLE_LINES = 500;

export type Indent = { unit: string; size: number };

/** Languages whose own style is four spaces, for a file too new to say. */
const FOUR_SPACES = /\.(py|pyi|rs|java|kt|c|h|cc|cpp|cxx|hpp)$/i;

/** How `text` indents: tabs, or the smallest run of spaces it starts a line with. With nothing
 * to go on, what its language does, if `path` says, and otherwise the editor's default. */
export function indentOf(text: string, path = ''): Indent | null {
  let smallest = Number.POSITIVE_INFINITY;
  for (const line of text.split('\n', SAMPLE_LINES)) {
    if (line.startsWith('\t')) return { unit: '\t', size: 4 };
    const spaces = /^ +(?=\S)/.exec(line)?.[0].length ?? 0;
    if (spaces > 1 && spaces < smallest) smallest = spaces;
  }
  if (Number.isFinite(smallest)) return { unit: ' '.repeat(smallest), size: smallest };
  return FOUR_SPACES.test(path) ? { unit: '    ', size: 4 } : null;
}

/** Go to line where each system keeps it: Ctrl-G on a Mac, where Cmd-G is find next. */
const moving: KeyBinding[] = [{ mac: 'Ctrl-g', run: gotoLine }];
const reading: readonly KeyBinding[] = [
  ...moving,
  ...searchKeymap,
  ...foldKeymap,
  ...defaultKeymap,
];
const writing: readonly KeyBinding[] = [...reading, ...historyKeymap, indentWithTab];

/** The panels' words, in the site's sentence case. */
const PHRASES = {
  next: 'Next',
  previous: 'Previous',
  all: 'All',
  'match case': 'Match case',
  regexp: 'Regexp',
  'by word': 'By word',
  replace: 'Replace',
  'replace all': 'Replace all',
  close: 'Close',
  'Go to line': 'Go to line',
  go: 'Go',
};

const shared = (indent?: Indent | null): Extension => [
  EditorState.phrases.of(PHRASES),
  codeTheme,
  syntaxHighlighting(codeHighlight),
  highlightSpecialChars(),
  foldGutter(),
  bracketMatching(),
  drawSelection(),
  EditorState.allowMultipleSelections.of(true),
  rectangularSelection(),
  crosshairCursor(),
  highlightActiveLine(),
  highlightActiveLineGutter(),
  highlightSelectionMatches(),
  search({ top: true }),
  indent ? [indentUnit.of(indent.unit), EditorState.tabSize.of(indent.size)] : [],
];

export const viewingState = (
  indent?: Indent | null,
  keys: readonly KeyBinding[] = [],
): Extension => [shared(indent), EditorState.readOnly.of(true), keymap.of([...keys, ...reading])];

export const editingState = (indent?: Indent | null): Extension => [
  shared(indent),
  history(),
  indentOnInput(),
  keymap.of(writing),
];

/** The keys bound for reading or writing, as a test reads them. */
export const keysOf = (mode: 'read' | 'write') =>
  (mode === 'read' ? reading : writing).flatMap((k) => [k.key, k.mac].filter(Boolean)) as string[];
