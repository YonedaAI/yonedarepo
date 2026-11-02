// A fenced code block in the viewer's colors: the same grammars and the same highlight style,
// with no editor around them. It loads only when a fence names a language.
import { ensureSyntaxTree } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { highlightTree } from '@lezer/highlight';
import { StyleModule } from 'style-mod';
import { codeHighlight } from './codeTheme';
import { fenceExtension, grammarOf } from './fileFacts';

/** Parsing past this is not worth a reader's wait. */
const PARSE_MS = 200;

/** `text` in runs, each with the class that colors it, or null for plain text. */
export async function fenceSegments(lang: string, text: string) {
  const extension = fenceExtension(lang);
  const grammar = extension && (await grammarOf(`fence.${extension}`, text.length));
  if (!grammar) return null;
  const state = EditorState.create({ doc: text, extensions: grammar });
  const tree = ensureSyntaxTree(state, text.length, PARSE_MS);
  if (!tree) return null;
  if (typeof document !== 'undefined' && codeHighlight.module)
    StyleModule.mount(document, codeHighlight.module);
  const parts: { text: string; className: string }[] = [];
  let at = 0;
  highlightTree(tree, codeHighlight, (from, to, className) => {
    if (from > at) parts.push({ text: text.slice(at, from), className: '' });
    parts.push({ text: text.slice(from, to), className });
    at = to;
  });
  if (at < text.length) parts.push({ text: text.slice(at), className: '' });
  return parts;
}
