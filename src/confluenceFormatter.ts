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
      // Use createYAMLConfluenceBlock to force block literal style (|) on content
      return createYAMLConfluenceBlock(obj.csp, obj.content);
    }
  } catch {
    // Not YAML either
  }

  throw new Error('Invalid format: file is neither valid JSON nor YAML');
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