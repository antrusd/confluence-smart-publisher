import * as vscode from 'vscode';
import * as fs from 'fs-extra';
import * as path from 'path';
import { marked, MarkedOptions } from 'marked';
import { randomUUID } from 'crypto';
import { createXMLCSPBlock, createDefaultCSPProperties } from './csp-utils';

export class MarkdownConverter {
    private static instance: MarkdownConverter;

    private constructor() {
        // Initial marked configuration
        const options: MarkedOptions = {
            gfm: true, // GitHub Flavored Markdown
            breaks: true
        };
        marked.setOptions(options);
    }

    public static getInstance(): MarkdownConverter {
        if (!MarkdownConverter.instance) {
            MarkdownConverter.instance = new MarkdownConverter();
        }
        return MarkdownConverter.instance;
    }

    /**
     * Converts a Markdown file to Confluence Storage Format
     * @param markdownFilePath Path to the Markdown file
     * @returns Promise with the path of the converted file
     */
    public async convertFile(markdownFilePath: string): Promise<string> {
        try {
            // Read the Markdown file content
            const markdownContent = await fs.readFile(markdownFilePath, 'utf8');

            // Convert content to HTML using marked
            const htmlContent = marked.parse(markdownContent) as string;

            // Convert HTML to Confluence Storage Format
            const confluenceContent = await this.convertHtmlToConfluence(htmlContent);

            // Generate the new file path
            const confluenceFilePath = this.generateConfluenceFilePath(markdownFilePath);

            // Save the converted file
            await fs.writeFile(confluenceFilePath, confluenceContent, 'utf8');

            return confluenceFilePath;
        } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
            throw new Error(`Error converting file: ${errorMessage}`);
        }
    }

    /**
     * Converts HTML to Confluence Storage Format
     * @param htmlContent HTML content
     * @returns Content in Confluence Storage Format
     */
    private async convertHtmlToConfluence(htmlContent: string): Promise<string> {
        // Adiciona a estrutura csp:parameters no início do documento usando a função utilitária
        const cspMetadata = {
            file_id: '',
            parent_id: '',
            labels_list: '',
            properties: createDefaultCSPProperties()
        };
        const cspParameters = createXMLCSPBlock(cspMetadata);

        // Convert <pre><code> blocks to Confluence ac:structured-macro code blocks
        const convertedContent = this.convertCodeBlocksToMacro(htmlContent);

        // Retorna o conteúdo formatado sem o cabeçalho XML e sem o macro info
        return `${cspParameters}\n\n${convertedContent}`;
    }

    /**
     * Converts HTML <pre><code> blocks to Confluence ac:structured-macro markdown blocks.
     * Uses the "markdown" macro with the original fenced code block (triple backticks) preserved inside CDATA.
     * Handles both language-specific (<code class="language-xxx">) and plain (<code>) blocks.
     * HTML entities inside code content are unescaped since the content goes inside CDATA.
     */
    private convertCodeBlocksToMacro(html: string): string {
        // Match <pre><code class="language-xxx">...</code></pre> or <pre><code>...</code></pre>
        const codeBlockRegex = /<pre><code(?:\s+class="language-([^"]*)")?>([\s\S]*?)<\/code><\/pre>/g;

        return html.replace(codeBlockRegex, (_match, language: string | undefined, codeContent: string) => {
            // Unescape HTML entities since content goes inside CDATA
            const rawContent = this.unescapeHtmlEntities(codeContent);
            // Remove trailing newline that marked adds before </code>
            const trimmedContent = rawContent.endsWith('\n') ? rawContent.slice(0, -1) : rawContent;
            const macroId = randomUUID();
            // Reconstruct the fenced code block with triple backticks inside CDATA
            const langSpec = language || '';
            const fencedBlock = `\`\`\`${langSpec}\n${trimmedContent}\n\`\`\``;
            return `<ac:structured-macro ac:name="markdown" ac:schema-version="1" ac:macro-id="${macroId}"><ac:plain-text-body><![CDATA[${fencedBlock}]]></ac:plain-text-body></ac:structured-macro>`;
        });
    }

    /**
     * Unescapes basic HTML entities back to raw characters (for CDATA content).
     */
    private unescapeHtmlEntities(text: string): string {
        return text
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'");
    }

    /**
     * Generates the Confluence file path based on the Markdown file path
     * @param markdownFilePath Path to the Markdown file
     * @returns Path to the Confluence file
     */
    private generateConfluenceFilePath(markdownFilePath: string): string {
        const dirName = path.dirname(markdownFilePath);
        const baseName = path.basename(markdownFilePath, '.md');
        return path.join(dirName, `${baseName}.confluence`);
    }
}
