// What the code surface does with a file, on the real grammar and commands. Failing here means
// the editor has stopped being one.
import { insertNewlineAndIndent, undo } from '@codemirror/commands';
import { python } from '@codemirror/lang-python';
import { ensureSyntaxTree, foldable, getIndentUnit } from '@codemirror/language';
import { selectNextOccurrence } from '@codemirror/search';
import { EditorState } from '@codemirror/state';
import { highlightTree } from '@lezer/highlight';
import { describe, expect, it } from 'vitest';
import { editingState, indentOf, keysOf, viewingState } from './codeSetup';
import { codeHighlight } from './codeTheme';

const source = [
  'import os',
  '',
  '@decorated',
  'class Thing:',
  '    """A docstring."""',
  '',
  '    def greet(self, name):',
  '        # a comment',
  '        return f"hello {name}" + str(42) + None',
  '',
].join('\n');

const editing = (doc: string, at: number) =>
  EditorState.create({
    doc,
    selection: { anchor: at },
    extensions: [editingState(indentOf(doc, 'a.py')), python()],
  });

/** Runs a state command, answering the state it leaves. */
function run(
  state: EditorState,
  command: (target: { state: EditorState; dispatch: (t: any) => void }) => boolean,
) {
  let after = state;
  command({
    state,
    dispatch: (t) => {
      after = t.state;
    },
  });
  return after;
}

describe('editing code', () => {
  it('indents a new line by what the language says', () => {
    const doc = 'def greet():';
    const after = run(editing(doc, doc.length), insertNewlineAndIndent);
    expect(after.doc.toString()).toBe('def greet():\n    ');
  });
  it('undoes and redoes', () => {
    const state = editing('a', 1);
    const changed = state.update({ changes: { from: 1, insert: 'b' } }).state;
    expect(run(changed, undo).doc.toString()).toBe('a');
  });
  it('holds several cursors at once', () => {
    const state = editing('name name name', 0);
    const one = run(state, selectNextOccurrence as never);
    const two = run(one, selectNextOccurrence as never);
    expect(two.selection.ranges).toHaveLength(2);
    const three = run(two, selectNextOccurrence as never);
    expect(three.selection.ranges).toHaveLength(3);
    const typed = three.update(three.replaceSelection('x')).state;
    expect(typed.doc.toString()).toBe('x x x');
  });
  it('takes the file’s own indentation', () => {
    expect(indentOf('def a():\n    return 1\n')).toEqual({ unit: '    ', size: 4 });
    expect(indentOf('a:\n  b: 1\n')).toEqual({ unit: '  ', size: 2 });
    expect(indentOf('void a() {\n\treturn;\n}\n')).toEqual({ unit: '\t', size: 4 });
    expect(indentOf('no indents here\n')).toBeNull();
    const state = EditorState.create({ doc: '', extensions: editingState(indentOf('a\n  b\n')) });
    expect(getIndentUnit(state)).toBe(2);
  });
});

describe('reading code', () => {
  const reading = (doc: string) =>
    EditorState.create({ doc, extensions: [viewingState(), python()] });

  it('edits nothing', () => {
    expect(reading('a').readOnly).toBe(true);
  });
  it('folds what the language says is a block', () => {
    const state = reading(source);
    ensureSyntaxTree(state, state.doc.length, 5000);
    const line = state.doc.line(4);
    expect(foldable(state, line.from, line.to)).not.toBeNull();
    expect(foldable(state, state.doc.line(1).from, state.doc.line(1).to)).toBeNull();
  });
  it('colors each kind of word', () => {
    const state = reading(source);
    const tree = ensureSyntaxTree(state, state.doc.length, 5000);
    const colored = new Map<string, string>();
    highlightTree(tree as never, codeHighlight, (from, to, classes) => {
      colored.set(state.doc.sliceString(from, to), classes);
    });
    const classOf = (word: string) => colored.get(word);
    for (const word of ['class', 'def', 'return', 'None', '42', '# a comment', 'greet', 'Thing'])
      expect(classOf(word), word).toBeTruthy();
    expect(classOf('class')).not.toBe(classOf('42'));
    expect(classOf('# a comment')).not.toBe(classOf('class'));
  });
});

describe('the keyboard', () => {
  const keys = (mode: 'read' | 'write') => keysOf(mode);
  it('has the usual shortcuts, reading and writing', () => {
    for (const key of ['Mod-f', 'Mod-Alt-g', 'Mod-d', 'Ctrl-Shift-[', 'Ctrl-Shift-]'])
      expect(keys('read'), key).toContain(key);
    for (const key of ['Mod-z', 'Mod-y', 'Mod-/', 'Tab', 'Enter', 'Alt-ArrowUp'])
      expect(keys('write'), key).toContain(key);
  });
  it('edits nothing by keyboard when reading', () => {
    expect(keys('read')).not.toContain('Mod-z');
    expect(keys('read')).not.toContain('Tab');
  });
});
