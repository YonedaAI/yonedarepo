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
  '.cm-line-target': { backgroundColor: 'var(--accent-soft)' },
  '.cm-line-target-number': { color: 'var(--blue-text)', backgroundColor: 'var(--accent-soft)' },
  '.cm-cursor': { borderLeftColor: 'var(--text)' },
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
  { tag: [tags.keyword, tags.modifier, tags.operatorKeyword], color: 'var(--syntax-keyword)' },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: 'var(--syntax-string)' },
  { tag: [tags.comment, tags.meta], color: 'var(--syntax-comment)', fontStyle: 'italic' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: 'var(--syntax-number)' },
  { tag: [tags.typeName, tags.className, tags.namespace], color: 'var(--syntax-type)' },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.macroName],
    color: 'var(--syntax-function)',
  },
  { tag: [tags.tagName, tags.angleBracket, tags.attributeName], color: 'var(--syntax-tag)' },
  { tag: tags.heading, color: 'var(--syntax-type)', fontWeight: '600' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: '600' },
  { tag: tags.link, color: 'var(--syntax-function)' },
]);
