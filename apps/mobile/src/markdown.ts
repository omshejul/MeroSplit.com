import { Lexer } from 'marked';
import { decodeHTML } from 'entities';

// Parse GFM once, then render native elements. Never generate or inject HTML.
export const parseNotes = (source: string) => Lexer.lex(source, { gfm: true, breaks: false });
export const markdownText = (value: string) => decodeHTML(value);
export function noteLink(href: string): string | null {
  const value = markdownText(href).trim();
  if (/[\u0000-\u0020\u007f]/.test(value) || !/^(https?:\/\/|mailto:)/i.test(value)) return null;
  try { const url = new URL(value); return url.protocol === 'mailto:' || url.hostname ? value : null; } catch { return null; }
}
