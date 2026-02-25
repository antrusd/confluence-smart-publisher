import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as yaml from 'js-yaml';
import { load, type CheerioAPI, type Cheerio } from 'cheerio';
import type { AnyNode, Element } from 'domhandler';
import hljs from 'highlight.js';

/**
 * Parsed structure of a .confluence file
 */
interface ConfluenceFile {
    csp: {
        file_id?: string;
        title?: string;
        labels_list?: string;
        parent_id?: string;
        properties?: Array<{ key: string; value: string }>;
        [key: string]: any;
    };
    content: string;
}

/**
 * ConfluenceRenderer — parses .confluence files (YAML frontmatter + Confluence Storage Format)
 * and transforms them into preview-ready HTML using cheerio for DOM manipulation
 * and highlight.js for syntax highlighting.
 */
export class ConfluenceRenderer {
    private extensionUri: vscode.Uri;

    /** Maps panel macro names to CSS class suffixes */
    private static readonly PANEL_TYPES: Record<string, { label: string; icon: string }> = {
        'info': { label: 'Info', icon: 'ℹ️' },
        'note': { label: 'Note', icon: '📝' },
        'warning': { label: 'Warning', icon: '⚠️' },
        'tip': { label: 'Tip', icon: '💡' },
        'error': { label: 'Error', icon: '🚨' },
    };

    /** Maps language aliases to highlight.js language names */
    private static readonly LANG_ALIASES: Record<string, string> = {
        'js': 'javascript',
        'ts': 'typescript',
        'py': 'python',
        'cs': 'csharp',
        'c#': 'csharp',
        'sh': 'bash',
        'shell': 'bash',
        'yml': 'yaml',
        'golang': 'go',
        'kt': 'kotlin',
        'rb': 'ruby',
        'dockerfile': 'docker',
        'conf': 'ini',
        'properties': 'ini',
    };

    constructor(extensionUri: vscode.Uri) {
        this.extensionUri = extensionUri;
    }

    /**
     * Renders a .confluence file content to full HTML page for webview
     * @param fileContent Raw text content of the .confluence file
     * @param documentUri URI of the document (for resolving relative paths)
     * @returns Complete HTML document string
     */
    public renderToHtml(fileContent: string, documentUri?: vscode.Uri): string {
        const parsed = this.parseConfluenceFile(fileContent);
        const transformedHtml = this.transformConfluenceHtml(parsed.content);
        const metadataHtml = this.renderMetadataHeader(parsed.csp);
        const cssContent = this.loadCss();

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Confluence Preview</title>
    <style>${cssContent}</style>
</head>
<body>
    <div class="confluence-preview">
        ${metadataHtml}
        <article class="confluence-content">
            ${transformedHtml}
        </article>
    </div>
    <script>
        // Toggle expand sections
        document.querySelectorAll('.confluence-expand summary').forEach(summary => {
            summary.addEventListener('click', (e) => {
                // Native <details> handles open/close
            });
        });
    </script>
</body>
</html>`;
    }

    /**
     * Parses a .confluence file into its YAML metadata and HTML content parts
     * The format is YAML with a `csp:` block and a `content: |-` field containing HTML
     */
    public parseConfluenceFile(fileContent: string): ConfluenceFile {
        try {
            // Parse the entire file as YAML
            const parsed = yaml.load(fileContent) as any;

            if (parsed && typeof parsed === 'object') {
                return {
                    csp: parsed.csp || {},
                    content: parsed.content || '',
                };
            }
        } catch (e) {
            console.warn('[ConfluenceRenderer] YAML parsing failed, trying fallback:', e);
        }

        // Fallback: try to extract content manually
        const contentMatch = fileContent.match(/^content:\s*\|-\s*\n([\s\S]+)$/m);
        if (contentMatch) {
            // De-indent the content block
            const content = contentMatch[1].replace(/^  /gm, '');
            return {
                csp: {},
                content,
            };
        }

        // Last resort: treat entire content as HTML
        return {
            csp: {},
            content: fileContent,
        };
    }

    /**
     * Transforms Confluence Storage Format HTML into renderable preview HTML
     * Uses cheerio for DOM-based parsing and manipulation
     */
    public transformConfluenceHtml(html: string): string {
        if (!html || !html.trim()) {
            return '<p><em>No content</em></p>';
        }

        // Pre-process: extract CDATA content before cheerio parsing
        // CDATA sections are not handled well by cheerio's HTML parser
        const cdataMap = new Map<string, string>();
        let cdataCounter = 0;
        let processedHtml = html.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_match, content) => {
            const placeholder = `__CDATA_PLACEHOLDER_${cdataCounter++}__`;
            cdataMap.set(placeholder, content);
            return placeholder;
        });

        // Load into cheerio
        const $ = load(processedHtml, {
            xml: false,
        });

        // Transform ac:structured-macro elements
        this.transformMacros($, cdataMap);

        // Transform ac:layout elements
        this.transformLayouts($);

        // Clean up remaining ac: elements
        this.cleanupAcElements($);

        // Get the transformed HTML
        let result = $('body').html() || '';

        // Restore any remaining CDATA placeholders as plain text
        for (const [placeholder, content] of cdataMap) {
            result = result.replace(placeholder, this.escapeHtml(content));
        }

        return result;
    }

    /**
     * Transforms all ac:structured-macro elements in the DOM
     */
    private transformMacros($: CheerioAPI, cdataMap: Map<string, string>): void {
        // Process macros from innermost to outermost to handle nesting
        let macros = $('ac\\:structured-macro, structured-macro');
        let iterations = 0;
        const maxIterations = 50;

        while (macros.length > 0 && iterations < maxIterations) {
            iterations++;
            // Find the innermost macros first (no nested macros inside)
            let processed = false;

            macros.each((_i: number, el: AnyNode) => {
                const $el = $(el);
                const nestedMacros = $el.find('ac\\:structured-macro, structured-macro');
                if (nestedMacros.length > 0) {
                    return; // Skip — has nested macros, process children first
                }

                const macroName = $el.attr('ac:name') || $el.attr('name') || '';
                const replacement = this.renderMacro($, $el, macroName, cdataMap);
                $el.replaceWith(replacement);
                processed = true;
            });

            if (!processed) {
                // Process remaining macros regardless of nesting to prevent infinite loop
                macros.each((_i: number, el: AnyNode) => {
                    const $el = $(el);
                    const macroName = $el.attr('ac:name') || $el.attr('name') || '';
                    const replacement = this.renderMacro($, $el, macroName, cdataMap);
                    $el.replaceWith(replacement);
                });
                break;
            }

            macros = $('ac\\:structured-macro, structured-macro');
        }
    }

    /**
     * Renders a single macro element based on its type
     */
    private renderMacro(
        $: CheerioAPI,
        $macro: Cheerio<AnyNode>,
        macroName: string,
        cdataMap: Map<string, string>,
    ): string {
        switch (macroName) {
            case 'code':
                return this.renderCodeMacro($, $macro, cdataMap);
            case 'info':
            case 'note':
            case 'warning':
            case 'tip':
            case 'error':
                return this.renderPanelMacro($, $macro, macroName);
            case 'expand':
                return this.renderExpandMacro($, $macro);
            case 'toc':
                return this.renderTocMacro();
            case 'status':
                return this.renderStatusMacro($, $macro);
            case 'anchor':
                return this.renderAnchorMacro($, $macro);
            case 'children':
            case 'page-tree':
                return this.renderChildrenMacro(macroName);
            default:
                return this.renderGenericMacro($, $macro, macroName);
        }
    }

    /**
     * Renders a code macro with syntax highlighting
     */
    private renderCodeMacro(
        $: CheerioAPI,
        $macro: Cheerio<AnyNode>,
        cdataMap: Map<string, string>,
    ): string {
        // Extract parameters
        const params = this.extractParameters($, $macro);
        const language = params.get('language') || '';
        const title = params.get('title') || '';

        // Extract body content
        let body = '';
        const $plainTextBody = $macro.find('ac\\:plain-text-body, plain-text-body');
        if ($plainTextBody.length) {
            body = $plainTextBody.text();
        }

        // Check if body contains a CDATA placeholder and restore it
        for (const [placeholder, content] of cdataMap) {
            if (body.includes(placeholder)) {
                body = body.replace(placeholder, content);
                cdataMap.delete(placeholder);
            }
        }

        // Trim leading/trailing whitespace from code
        body = body.trim();

        // Apply syntax highlighting
        const highlighted = this.highlightCode(body, language);

        // Build the code block HTML
        const headerParts: string[] = [];
        if (language) {
            headerParts.push(`<span class="confluence-code-block__language">${this.escapeHtml(language)}</span>`);
        }
        if (title) {
            headerParts.push(`<span class="confluence-code-block__title">${this.escapeHtml(title)}</span>`);
        }

        const header = headerParts.length > 0
            ? `<div class="confluence-code-block__header">${headerParts.join('')}</div>`
            : '';

        return `<div class="confluence-code-block">${header}<pre><code class="hljs${language ? ` language-${this.escapeHtml(this.normalizeLang(language))}` : ''}">${highlighted}</code></pre></div>`;
    }

    /**
     * Renders a panel macro (info, note, warning, tip, error)
     */
    private renderPanelMacro(
        $: CheerioAPI,
        $macro: Cheerio<AnyNode>,
        type: string,
    ): string {
        const panelInfo = ConfluenceRenderer.PANEL_TYPES[type] || { label: type, icon: '📌' };
        const params = this.extractParameters($, $macro);
        const title = params.get('title') || panelInfo.label;

        // Extract body content
        let bodyHtml = '';
        const $richTextBody = $macro.find('ac\\:rich-text-body, rich-text-body');
        if ($richTextBody.length) {
            bodyHtml = $richTextBody.html() || '';
        }

        return `<div class="confluence-panel confluence-panel--${this.escapeHtml(type)}">
    <div class="confluence-panel__icon">${panelInfo.icon}</div>
    <div class="confluence-panel__title">${this.escapeHtml(title)}</div>
    <div class="confluence-panel__body">${bodyHtml}</div>
</div>`;
    }

    /**
     * Renders an expand/collapse macro
     */
    private renderExpandMacro(
        $: CheerioAPI,
        $macro: Cheerio<AnyNode>,
    ): string {
        const params = this.extractParameters($, $macro);
        const title = params.get('title') || params.get('') || 'Click to expand...';

        let bodyHtml = '';
        const $richTextBody = $macro.find('ac\\:rich-text-body, rich-text-body');
        if ($richTextBody.length) {
            bodyHtml = $richTextBody.html() || '';
        }

        return `<details class="confluence-expand">
    <summary>${this.escapeHtml(title)}</summary>
    <div class="confluence-expand__body">${bodyHtml}</div>
</details>`;
    }

    /**
     * Renders a TOC (table of contents) placeholder
     */
    private renderTocMacro(): string {
        return '<div class="confluence-toc">Table of Contents (auto-generated on Confluence)</div>';
    }

    /**
     * Renders a status macro as a colored badge
     */
    private renderStatusMacro(
        $: CheerioAPI,
        $macro: Cheerio<AnyNode>,
    ): string {
        const params = this.extractParameters($, $macro);
        const title = params.get('title') || 'STATUS';
        const colour = (params.get('colour') || params.get('color') || 'grey').toLowerCase();
        return `<span class="confluence-status confluence-status--${this.escapeHtml(colour)}">${this.escapeHtml(title)}</span>`;
    }

    /**
     * Renders an anchor macro as an invisible anchor element
     */
    private renderAnchorMacro(
        $: CheerioAPI,
        $macro: Cheerio<AnyNode>,
    ): string {
        const params = this.extractParameters($, $macro);
        const anchorId = params.get('') || params.get('id') || '';
        if (anchorId) {
            return `<a id="${this.escapeHtml(anchorId)}" class="confluence-anchor"></a>`;
        }
        return '';
    }

    /**
     * Renders a children/page-tree macro as a placeholder
     */
    private renderChildrenMacro(macroName: string): string {
        return `<div class="confluence-toc">📂 ${macroName === 'children' ? 'Child Pages' : 'Page Tree'} (visible on Confluence)</div>`;
    }

    /**
     * Renders an unknown/generic macro as a styled box
     */
    private renderGenericMacro(
        $: CheerioAPI,
        $macro: Cheerio<AnyNode>,
        macroName: string,
    ): string {
        let bodyHtml = '';
        const $richTextBody = $macro.find('ac\\:rich-text-body, rich-text-body');
        const $plainTextBody = $macro.find('ac\\:plain-text-body, plain-text-body');

        if ($richTextBody.length) {
            bodyHtml = $richTextBody.html() || '';
        } else if ($plainTextBody.length) {
            bodyHtml = `<pre>${this.escapeHtml($plainTextBody.text())}</pre>`;
        }

        return `<div class="confluence-unknown-macro">
    <div class="confluence-unknown-macro__name">📦 Macro: ${this.escapeHtml(macroName)}</div>
    ${bodyHtml}
</div>`;
    }

    /**
     * Extracts ac:parameter values from a macro element
     * Returns a Map where the key is the parameter name and the value is its text
     */
    private extractParameters(
        $: CheerioAPI,
        $macro: Cheerio<AnyNode>,
    ): Map<string, string> {
        const params = new Map<string, string>();
        $macro.children('ac\\:parameter, parameter').each((_i: number, el: AnyNode) => {
            const $param = $(el);
            const name = $param.attr('ac:name') || $param.attr('name') || '';
            const value = $param.text().trim();
            params.set(name, value);
        });
        return params;
    }

    /**
     * Transforms ac:layout / ac:layout-section / ac:layout-cell into flex layout
     */
    private transformLayouts($: CheerioAPI): void {
        $('ac\\:layout, layout').each((_i: number, el: AnyNode) => {
            const $layout = $(el);
            const innerHtml = $layout.html() || '';
            $layout.replaceWith(`<div class="confluence-layout">${innerHtml}</div>`);
        });

        $('ac\\:layout-section, layout-section').each((_i: number, el: AnyNode) => {
            const $section = $(el);
            const innerHtml = $section.html() || '';
            $section.replaceWith(`<div class="confluence-layout-section">${innerHtml}</div>`);
        });

        $('ac\\:layout-cell, layout-cell').each((_i: number, el: AnyNode) => {
            const $cell = $(el);
            const innerHtml = $cell.html() || '';
            $cell.replaceWith(`<div class="confluence-layout-cell">${innerHtml}</div>`);
        });
    }

    /**
     * Removes any remaining ac: prefixed elements that weren't explicitly handled
     */
    private cleanupAcElements($: CheerioAPI): void {
        // Remove ac:parameter elements (already extracted)
        $('ac\\:parameter, parameter').remove();

        // Replace ac:plain-text-body / ac:rich-text-body with their contents
        $('ac\\:plain-text-body, plain-text-body, ac\\:rich-text-body, rich-text-body').each((_i: number, el: AnyNode) => {
            const $el = $(el);
            $el.replaceWith($el.html() || $el.text());
        });

        // Replace ac:link with proper anchor
        $('ac\\:link, link').each((_i: number, el: AnyNode) => {
            const $el = $(el);
            const $page = $el.find('ri\\:page, page');
            const $attachment = $el.find('ri\\:attachment, attachment');
            const $body = $el.find('ac\\:link-body, link-body, ac\\:plain-text-link-body, plain-text-link-body');
            const linkText = $body.text() || $page.attr('ri:content-title') || $attachment.attr('ri:filename') || 'Link';
            const pageTitle = $page.attr('ri:content-title') || '';
            $el.replaceWith(`<a href="#" title="${this.escapeHtml(pageTitle)}">${this.escapeHtml(linkText)}</a>`);
        });

        // Replace ac:image with img
        $('ac\\:image, image').each((_i: number, el: AnyNode) => {
            const $el = $(el);
            const $attachment = $el.find('ri\\:attachment, attachment');
            const filename = $attachment.attr('ri:filename') || '';
            const alt = $el.attr('ac:alt') || filename;
            const width = $el.attr('ac:width') || '';
            const widthAttr = width ? ` width="${this.escapeHtml(width)}"` : '';
            $el.replaceWith(`<div class="confluence-image-wrapper"><img src="" alt="${this.escapeHtml(alt)}"${widthAttr} title="${this.escapeHtml(filename)}" /></div>`);
        });

        // Replace ac:emoticon
        $('ac\\:emoticon, emoticon').each((_i: number, el: AnyNode) => {
            const $el = $(el);
            const name = $el.attr('ac:name') || '';
            const emojiMap: Record<string, string> = {
                'smile': '😄', 'sad': '😢', 'cheeky': '😜', 'laugh': '😂',
                'wink': '😉', 'thumbs-up': '👍', 'thumbs-down': '👎',
                'information': 'ℹ️', 'tick': '✅', 'cross': '❌',
                'warning': '⚠️', 'plus': '➕', 'minus': '➖',
                'question': '❓', 'light-on': '💡', 'light-off': '💡',
                'yellow-star': '⭐', 'red-star': '🌟', 'green-star': '💚',
                'blue-star': '💙', 'heart': '❤️', 'broken-heart': '💔',
            };
            const emoji = emojiMap[name] || `(${name})`;
            $el.replaceWith(`<span class="confluence-emoticon">${emoji}</span>`);
        });

        // Remove ri:* elements
        $('ri\\:page, ri\\:attachment, ri\\:url, ri\\:user, ri\\:space, ri\\:content-entity').remove();

        // Replace remaining ac:task-list / ac:task elements
        $('ac\\:task-list, task-list').each((_i: number, el: AnyNode) => {
            const $el = $(el);
            const innerHtml = $el.html() || '';
            $el.replaceWith(`<ul class="task-list">${innerHtml}</ul>`);
        });

        $('ac\\:task, task').each((_i: number, el: AnyNode) => {
            const $el = $(el);
            const $status = $el.find('ac\\:task-status, task-status');
            const $body = $el.find('ac\\:task-body, task-body');
            const isComplete = $status.text().trim() === 'complete';
            const bodyHtml = $body.html() || '';
            $el.replaceWith(`<li class="task-list-item"><input type="checkbox" disabled${isComplete ? ' checked' : ''} /><span>${bodyHtml}</span></li>`);
        });
    }

    /**
     * Applies syntax highlighting to a code string using highlight.js
     */
    private highlightCode(code: string, lang: string): string {
        if (!lang || !lang.trim()) {
            return this.escapeHtml(code);
        }

        const normalizedLang = this.normalizeLang(lang.trim().toLowerCase());

        try {
            if (hljs.getLanguage(normalizedLang)) {
                return hljs.highlight(code, { language: normalizedLang }).value;
            }
            // Try auto-detection
            return hljs.highlightAuto(code).value;
        } catch (err) {
            console.warn(`[ConfluenceRenderer] highlight.js error for language '${lang}':`, err);
            return this.escapeHtml(code);
        }
    }

    /**
     * Normalizes language name aliases to highlight.js expected names
     */
    private normalizeLang(lang: string): string {
        return ConfluenceRenderer.LANG_ALIASES[lang] || lang;
    }

    /**
     * Renders the metadata header section showing page info
     */
    private renderMetadataHeader(csp: ConfluenceFile['csp']): string {
        if (!csp || (!csp.title && !csp.file_id)) {
            return '';
        }

        const parts: string[] = [];

        if (csp.title) {
            parts.push(`<h1 class="confluence-metadata__title">${this.escapeHtml(csp.title)}</h1>`);
        }

        const items: string[] = [];
        if (csp.file_id) {
            items.push(`<span class="confluence-metadata__item">
                <span class="confluence-metadata__label">ID</span>
                <span class="confluence-metadata__value">${this.escapeHtml(csp.file_id)}</span>
            </span>`);
        }
        if (csp.parent_id) {
            items.push(`<span class="confluence-metadata__item">
                <span class="confluence-metadata__label">Parent</span>
                <span class="confluence-metadata__value">${this.escapeHtml(csp.parent_id)}</span>
            </span>`);
        }

        if (items.length) {
            parts.push(`<div class="confluence-metadata__row">${items.join('')}</div>`);
        }

        // Labels
        if (csp.labels_list && csp.labels_list.trim()) {
            const labels = csp.labels_list.split(',').map(l => l.trim()).filter(Boolean);
            if (labels.length) {
                parts.push(`<div class="confluence-metadata__labels">${labels.map(l => `<span class="confluence-metadata__tag">${this.escapeHtml(l)}</span>`).join('')}</div>`);
            }
        }

        if (parts.length === 0) {
            return '';
        }

        return `<div class="confluence-metadata">${parts.join('\n')}</div>`;
    }

    /**
     * Loads CSS from the assets/css/confluence-preview.css file
     */
    private loadCss(): string {
        try {
            const cssPath = path.join(this.extensionUri.fsPath, 'assets', 'css', 'confluence-preview.css');
            if (fs.existsSync(cssPath)) {
                return fs.readFileSync(cssPath, 'utf-8');
            }
        } catch (error) {
            console.warn('[ConfluenceRenderer] Could not load CSS file:', error);
        }

        // Minimal fallback CSS
        return `
body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    line-height: 1.6;
    color: rgba(255,255,255,0.87);
    background: #1e1e1e;
    padding: 1rem;
}
code { background: #404040; padding: 0.125em 0.375em; border-radius: 3px; }
pre { background: #0d1117; padding: 16px; border-radius: 6px; overflow-x: auto; }
table { border-collapse: collapse; width: 100%; }
th, td { border: 1px solid rgba(255,255,255,0.12); padding: 8px 12px; }
th { background: #2d2d2d; }
`;
    }

    /**
     * Escapes HTML entities in text
     */
    private escapeHtml(text: string): string {
        const map: Record<string, string> = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;',
        };
        return text.replace(/[&<>"']/g, (m) => map[m]);
    }
}
