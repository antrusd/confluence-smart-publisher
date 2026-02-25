// Função utilitária para formatar documentos da linguagem Confluence
// Mantém apenas a numeração de headings e a formatação padrão HTML-like

import * as vscode from 'vscode';
import { decode as decodeEntities, EntityLevel } from 'entities';
import { TAG_BEHAVIOR } from './confluenceSchema';
import * as yaml from 'js-yaml';
import { createYAMLConfluenceBlock } from './csp-utils';

// Formatter para arquivos Confluence (JSON or YAML)

export function formatConfluenceDocument(text: string): string {
  // Try JSON format first
  try {
    const obj = JSON.parse(text);
    return JSON.stringify(obj, null, 2) + '\n';
  } catch {
    // Not JSON, try YAML
  }

  // Try YAML format
  try {
    const obj = yaml.load(text) as any;
    if (obj && typeof obj === 'object' && obj.csp) {
      // Use createYAMLConfluenceBlock to force block literal style (|-) on content
      return createYAMLConfluenceBlock(obj.csp, obj.content);
    }
  } catch {
    // Not YAML either
  }

  throw new Error('Invalid format: file is neither valid JSON nor YAML');
}

/**
 * Block-level elements that should start on their own line with indentation.
 * Inline elements are kept on the same line as their parent.
 */
const BLOCK_ELEMENTS = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'p', 'div', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
  'colgroup', 'col',
  'ul', 'ol', 'li',
  'pre', 'blockquote', 'hr',
  'ac:structured-macro', 'ac:rich-text-body', 'ac:plain-text-body',
  'ac:parameter', 'ac:layout', 'ac:layout-section', 'ac:layout-cell',
  'ac:task-list', 'ac:task',
]);

/**
 * Self-closing elements (no closing tag expected)
 */
const VOID_ELEMENTS = new Set([
  'br', 'hr', 'col', 'img', 'input', 'meta', 'link', 'area', 'base',
]);

/**
 * Tidies (prettifies) XHTML content inside a YAML .confluence file.
 * Parses YAML, prettifies the `content` field's XHTML with proper indentation,
 * and reconstructs the file with the tidied content.
 *
 * @param text - Full .confluence file content (YAML format)
 * @returns Tidied .confluence file content
 */
export function tidyConfluenceContent(text: string): string {
  // Parse YAML
  const obj = yaml.load(text) as any;
  if (!obj || typeof obj !== 'object' || !obj.csp) {
    throw new Error('Invalid format: file is not a valid YAML .confluence file');
  }

  if (!obj.content || typeof obj.content !== 'string') {
    throw new Error('No content field found in the .confluence file');
  }

  // Prettify the XHTML content
  const tidied = prettifyXhtml(obj.content);

  // Reconstruct the file with tidied content
  return createYAMLConfluenceBlock(obj.csp, tidied);
}

/**
 * Prettifies XHTML/HTML content with proper indentation.
 * Handles Confluence Storage Format elements (ac:*, ri:*), CDATA sections,
 * and mixed inline/block content.
 *
 * @param html - Raw XHTML string
 * @param indentStr - Indentation unit (default: 2 spaces)
 * @returns Prettified XHTML string
 */
export function prettifyXhtml(html: string, indentStr: string = '  '): string {
  if (!html || !html.trim()) {
    return '';
  }

  // Step 1: Extract and protect CDATA sections
  const cdataMap = new Map<string, string>();
  let cdataCounter = 0;
  let processed = html.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_match, content) => {
    const placeholder = `__CDATA_TIDY_${cdataCounter++}__`;
    cdataMap.set(placeholder, content);
    return placeholder;
  });

  // Step 2: Normalize whitespace (collapse multiple spaces/newlines to single space)
  processed = processed.replace(/\s+/g, ' ').trim();

  // Step 3: Tokenize into tags and text
  const tokens = tokenizeHtml(processed);

  // Step 4: Build prettified output
  const lines: string[] = [];
  let depth = 0;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    if (token.type === 'open') {
      const tagName = token.tagName!.toLowerCase();
      if (BLOCK_ELEMENTS.has(tagName)) {
        lines.push(indentStr.repeat(depth) + token.raw);
        if (!VOID_ELEMENTS.has(tagName)) {
          depth++;
        }
      } else {
        // Inline element — append to current line or start new
        appendInline(lines, token.raw, depth, indentStr);
      }
    } else if (token.type === 'close') {
      const tagName = token.tagName!.toLowerCase();
      if (BLOCK_ELEMENTS.has(tagName)) {
        depth = Math.max(0, depth - 1);
        lines.push(indentStr.repeat(depth) + token.raw);
      } else {
        appendInline(lines, token.raw, depth, indentStr);
      }
    } else if (token.type === 'selfclose') {
      const tagName = token.tagName!.toLowerCase();
      if (BLOCK_ELEMENTS.has(tagName) || VOID_ELEMENTS.has(tagName)) {
        lines.push(indentStr.repeat(depth) + token.raw);
      } else {
        appendInline(lines, token.raw, depth, indentStr);
      }
    } else if (token.type === 'comment' || token.type === 'doctype') {
      lines.push(indentStr.repeat(depth) + token.raw);
    } else if (token.type === 'text') {
      const text = token.raw.trim();
      if (text) {
        appendInline(lines, text, depth, indentStr);
      }
    }
  }

  // Step 5: Restore CDATA sections
  let result = lines.join('\n');
  for (const [placeholder, content] of cdataMap) {
    result = result.replace(placeholder, `<![CDATA[${content}]]>`);
  }

  return result;
}

interface HtmlToken {
  type: 'open' | 'close' | 'selfclose' | 'text' | 'comment' | 'doctype';
  raw: string;
  tagName?: string;
}

/**
 * Tokenizes HTML/XHTML into a flat list of tokens (tags and text nodes).
 */
function tokenizeHtml(html: string): HtmlToken[] {
  const tokens: HtmlToken[] = [];
  // Match: comments, doctypes, self-closing tags, opening tags, closing tags, text
  const regex = /<!--[\s\S]*?-->|<!DOCTYPE[^>]*>|<([a-zA-Z][a-zA-Z0-9:._-]*)((?:\s+[^>]*?)?)\/\s*>|<\/([a-zA-Z][a-zA-Z0-9:._-]*)\s*>|<([a-zA-Z][a-zA-Z0-9:._-]*)((?:\s+[^>]*?)?)>|([^<]+)/g;
  let match;

  while ((match = regex.exec(html)) !== null) {
    const full = match[0];

    if (full.startsWith('<!--')) {
      tokens.push({ type: 'comment', raw: full });
    } else if (full.startsWith('<!DOCTYPE') || full.startsWith('<!doctype')) {
      tokens.push({ type: 'doctype', raw: full });
    } else if (match[1] !== undefined) {
      // Self-closing tag: <tag ... />
      tokens.push({ type: 'selfclose', raw: full, tagName: match[1] });
    } else if (match[3] !== undefined) {
      // Closing tag: </tag>
      tokens.push({ type: 'close', raw: full, tagName: match[3] });
    } else if (match[4] !== undefined) {
      // Opening tag: <tag ...>
      const tagName = match[4];
      if (VOID_ELEMENTS.has(tagName.toLowerCase())) {
        tokens.push({ type: 'selfclose', raw: full, tagName });
      } else {
        tokens.push({ type: 'open', raw: full, tagName });
      }
    } else if (match[6] !== undefined) {
      // Text node
      tokens.push({ type: 'text', raw: match[6] });
    }
  }

  return tokens;
}

/**
 * Appends inline content to the last line or creates a new indented line.
 */
function appendInline(lines: string[], content: string, depth: number, indentStr: string): void {
  if (lines.length > 0) {
    const lastLine = lines[lines.length - 1];
    // If the last line is a block-level line, append inline to it
    lines[lines.length - 1] = lastLine + content;
  } else {
    lines.push(indentStr.repeat(depth) + content);
  }
}

function numberHeadings(text: string): string {
  // Numera h1-h6 sequencialmente, reiniciando a contagem para subníveis
  const headingRegex = /([ \t]*)<(h[1-6])>([\s\S]*?)<\/\2>/gi;
  const counters = [0, 0, 0, 0, 0, 0];

  // Primeiro, vamos limpar qualquer numeração existente
  let cleanedText = text.replace(headingRegex, (_, spaces, tag, content) => {
    const cleanContent = cleanHeadingContent(content);
    return `${spaces}<${tag}>${cleanContent}</${tag}>`;
  });

  // Agora, vamos adicionar a nova numeração
  return cleanedText.replace(headingRegex, (_, spaces, tag, content) => {
    const level = parseInt(tag[1]);
    // Zera contadores de subníveis
    for (let i = level; i < counters.length; i++) {counters[i] = 0;}
    counters[level - 1]++;
    // Prefixo esperado com ponto no final
    const expectedPrefix = counters.slice(0, level).filter(n => n > 0).join('.') + '. ';
    return `${spaces}<${tag}>${expectedPrefix}${content}</${tag}>`;
  });
}

function cleanHeadingContent(content: string): string {
  // Remove all numeric prefixes from the beginning of content, as many times as they appear
  let cleaned = content.trim();

  // Regex para identificar numeração no início do conteúdo
  // Captura números seguidos de ponto e espaço, podendo ter múltiplos níveis
  const numberPrefixRegex = /^(\d+(\.\d+)*\.\s+)+/;

  // Remove a numeração existente, mantendo o resto do conteúdo intacto
  cleaned = cleaned.replace(numberPrefixRegex, '');

  return cleaned;
}

// Decodifica entidades HTML apenas nos textos entre as tags, preservando tags e atributos
export function decodeHtmlEntities(text: string): string {
  return text.replace(/(<[^>]+>)|([^<]+)/g, (match, tag, txt) => {
    if (tag) {return tag;}
    if (txt) {return decodeEntities(txt, { level: EntityLevel.HTML });}
    return match;
  });
}
