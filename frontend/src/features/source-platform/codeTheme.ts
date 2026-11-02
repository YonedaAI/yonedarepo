// The code surface's look, from the theme's tokens, so light and dark both come from theme.css.
import { HighlightStyle } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { tags } from '@lezer/highlight';

export const codeTheme = EditorView.theme({
  '&': { backgroundColor: 'var(--code-bg)', color: 'var(--text)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'var(--mono)',
    fontSize: 'var(--text-mono-dense)',
    lineHeight: '1.5',
    overflowX: 'auto',
  },
  '.cm-content': { padding: '10px 0', caretColor: 'var(--text)' },
  '.cm-line': { padding: '0 16px' },
  '.cm-gutters': {
    backgroundColor: 'var(--code-bg)',
    color: 'var(--faint)',
    border: 'none',
    paddingLeft: '8px',
  },
  '.cm-lineNumbers .cm-gutterElement': {
    minWidth: '36px',
    padding: '0 8px 0 0',
    cursor: 'pointer',
    userSelect: 'none',
  },
  '.cm-lineNumbers .cm-gutterElement:hover': { color: 'var(--blue-text)' },
  '&.cm-focused .cm-activeLine': { backgroundColor: 'var(--code-line)' },
  '.cm-activeLine': { backgroundColor: 'transparent' },
  '&.cm-focused .cm-activeLineGutter': {
    color: 'var(--text)',
    backgroundColor: 'var(--code-line)',
  },
  '.cm-activeLineGutter': { backgroundColor: 'transparent' },
  '.cm-foldGutter .cm-gutterElement': {
    cursor: 'pointer',
    padding: '0 4px',
    color: 'var(--faint)',
  },
  '.cm-foldGutter .cm-gutterElement:hover': { color: 'var(--text)' },
  '.cm-foldPlaceholder': {
    backgroundColor: 'var(--surface-3)',
    border: 'none',
    borderRadius: '4px',
    color: 'var(--text-2)',
    padding: '0 6px',
  },
  // The linked line outranks the caret's, focused or not.
  '&.cm-editor .cm-line.cm-line-target': { backgroundColor: 'var(--accent-soft)' },
  '&.cm-editor .cm-gutterElement.cm-line-target-number': {
    color: 'var(--blue-text)',
    backgroundColor: 'var(--accent-soft)',
  },
  '.cm-cursor': { borderLeftColor: 'var(--text)' },
  '.cm-dropCursor': { borderLeftColor: 'var(--blue-text)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
    { backgroundColor: 'var(--accent-line)' },
  '.cm-selectionMatch': { backgroundColor: 'var(--accent-soft)' },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
    backgroundColor: 'var(--accent-line)',
    outline: 'none',
  },
  '.cm-searchMatch': {
    backgroundColor: 'var(--warn-soft)',
    outline: '1px solid var(--warn-line)',
  },
  '.cm-searchMatch-selected': { backgroundColor: 'var(--warn-line)' },
  '.cm-panels': {
    backgroundColor: 'var(--surface-2)',
    color: 'var(--text)',
    borderColor: 'var(--line)',
  },
  '.cm-panels-top': { borderBottom: '1px solid var(--line)' },
  '.cm-panel.cm-search': { fontFamily: 'inherit', fontSize: 'var(--text-sm)', padding: '6px 8px' },
  '.cm-panel.cm-search label': { fontSize: 'var(--text-sm)' },
  '.cm-panel.cm-search [name=close]': { color: 'var(--text)', fontSize: 'var(--text-lg)' },
  '.cm-dialog, .cm-panel.cm-gotoLine': {
    backgroundColor: 'var(--surface-2)',
    color: 'var(--text)',
    fontFamily: 'inherit',
    fontSize: 'var(--text-sm)',
    padding: '6px 8px',
  },
  '.cm-textfield': {
    backgroundColor: 'var(--surface)',
    color: 'var(--text)',
    border: '1px solid var(--line-strong)',
    borderRadius: '6px',
    minHeight: '28px',
  },
  '.cm-button': {
    backgroundImage: 'none',
    backgroundColor: 'var(--surface)',
    color: 'var(--text)',
    border: '1px solid var(--line-strong)',
    borderRadius: '6px',
  },
});

export const codeHighlight = HighlightStyle.define([
  {
    tag: [
      tags.keyword,
      tags.modifier,
      tags.operatorKeyword,
      tags.controlKeyword,
      tags.definitionKeyword,
      tags.moduleKeyword,
    ],
    color: 'var(--syntax-keyword)',
  },
  {
    tag: [tags.string, tags.special(tags.string), tags.regexp, tags.docString, tags.character],
    color: 'var(--syntax-string)',
  },
  { tag: tags.escape, color: 'var(--syntax-number)' },
  {
    tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment],
    color: 'var(--syntax-comment)',
    fontStyle: 'italic',
  },
  {
    tag: [tags.number, tags.integer, tags.float, tags.bool, tags.null, tags.atom, tags.unit],
    color: 'var(--syntax-number)',
  },
  // A decorator, an attribute of a type, a preprocessor line.
  { tag: [tags.meta, tags.annotation, tags.processingInstruction], color: 'var(--syntax-number)' },
  {
    tag: [
      tags.typeName,
      tags.className,
      tags.namespace,
      tags.definition(tags.typeName),
      tags.standard(tags.variableName),
      tags.standard(tags.typeName),
    ],
    color: 'var(--syntax-type)',
  },
  {
    tag: [
      tags.function(tags.variableName),
      tags.function(tags.propertyName),
      tags.function(tags.definition(tags.variableName)),
      tags.macroName,
      tags.labelName,
    ],
    color: 'var(--syntax-function)',
  },
  { tag: [tags.self, tags.special(tags.variableName)], color: 'var(--syntax-tag)' },
  { tag: [tags.tagName, tags.angleBracket, tags.attributeName], color: 'var(--syntax-tag)' },
  { tag: [tags.propertyName, tags.definition(tags.propertyName)], color: 'var(--syntax-property)' },
  {
    tag: [tags.heading, tags.heading1, tags.heading2],
    color: 'var(--syntax-type)',
    fontWeight: '600',
  },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: '600' },
  { tag: tags.link, color: 'var(--syntax-function)' },
  { tag: tags.invalid, color: 'var(--danger)' },
]);
