import * as vscode from 'vscode';
import { workspace } from 'vscode';
import { mkdirSync, writeFileSync, createReadStream, existsSync, readFileSync, promises as fsPromises } from 'fs';
import { isAbsolute, join, dirname, basename, extname } from 'path';
import { randomUUID } from 'crypto';
import FormData = require('form-data');
import { decodeHtmlEntities } from './confluenceFormatter';
import { AdfToMarkdownConverter } from './adf-md-converter/adf-to-md-converter';
import {
    createJSONCSPBlock,
    createYAMLConfluenceBlock,
    extractProperties,
    extractParentId,
    extractLabels,
    extractFileId,
    extractCSPValue,
    createXMLCSPBlock,
    createDefaultCSPProperties
} from './csp-utils';
import * as yaml from 'js-yaml';

export enum BodyFormat {
    VIEW = 'view',
    EXPORT_VIEW = 'export_view',
    STYLED_VIEW = 'styled_view',
    STORAGE = 'storage',
    EDITOR = 'editor',
    ATLAS_DOC_FORMAT = 'atlas_doc_format',
    ANONYMOUS_EXPORT_VIEW = 'anonymous_export_view',
}

export class ConfluenceClient {
    private baseUrl: string;
    private username: string;
    private apiToken: string;
    private useBearerAuth: boolean;
    private confluenceVersion: 'cloud' | 'server';
    private debugMode: boolean;
    private outputChannel: vscode.OutputChannel;

    private static _sharedOutputChannel: vscode.OutputChannel | undefined;

    /**
     * Sets the shared output channel for all ConfluenceClient instances.
     * Call this once from extension activation to reuse the extension's output channel.
     */
    static setOutputChannel(channel: vscode.OutputChannel): void {
        ConfluenceClient._sharedOutputChannel = channel;
    }

    private static getSharedOutputChannel(): vscode.OutputChannel {
        if (!ConfluenceClient._sharedOutputChannel) {
            ConfluenceClient._sharedOutputChannel = vscode.window.createOutputChannel('Confluence Smart Publisher');
        }
        return ConfluenceClient._sharedOutputChannel;
    }

    constructor() {
        // Preferencialmente, use as configurações do VSCode para armazenar as credenciais
        const config = workspace.getConfiguration('confluenceSmartPublisher');
        this.baseUrl = (config.get('baseUrl') as string)?.replace(/\/$/, '') || '';
        this.username = config.get('username') as string || '';
        this.apiToken = config.get('apiToken') as string || '';
        this.useBearerAuth = config.get('useBearerAuth') as boolean || false;
        this.confluenceVersion = (config.get('confluenceVersion') as string || 'cloud') as 'cloud' | 'server';
        this.debugMode = config.get('debug') as boolean || false;
        this.outputChannel = ConfluenceClient.getSharedOutputChannel();
        if (!this.baseUrl || !this.apiToken) {
            throw new Error('Configure baseUrl and apiToken in the extension settings.');
        }
        if (!this.useBearerAuth && !this.username) {
            throw new Error('Configure username in the extension settings (required for Basic authentication).');
        }
    }

    private isServer(): boolean {
        return this.confluenceVersion === 'server';
    }

    private getAuthHeader() {
        if (this.useBearerAuth) {
            return { 'Authorization': `Bearer ${this.apiToken}` };
        }
        const token = Buffer.from(`${this.username}:${this.apiToken}`).toString('base64');
        return { 'Authorization': `Basic ${token}` };
    }

    /**
     * Returns the base URL for v1 REST API calls.
     * For Cloud: strips /api/v2 suffix if present.
     * For Server: uses baseUrl as-is (already points to the instance root).
     */
    private getBaseUrlV1(): string {
        if (this.isServer()) {
            return this.baseUrl;
        }
        return this.baseUrl.includes('/api/v2') ? this.baseUrl.split('/api/v2')[0] : this.baseUrl;
    }

    /**
     * Logs a debug message to the output channel when debug mode is enabled.
     */
    /**
     * Logs a debug message to the output channel when debug mode is enabled.
     */
    private debugLog(message: string): void {
        if (this.debugMode) {
            this.outputChannel.appendLine(`[DEBUG] ${message}`);
        }
    }

    /**
     * Logs a warning message to the output channel (always, regardless of debug mode).
     */
    private warnLog(message: string): void {
        this.outputChannel.appendLine(`[WARN] ${message}`);
    }

    /**
     * Wrapper around node-fetch that logs HTTP request and response details when debug mode is enabled.
     */
    private async debugFetch(url: string, options?: any): Promise<any> {
        const { default: fetch } = await import('node-fetch');
        const method = options?.method || 'GET';
        const hasBody = !!options?.body;

        if (this.debugMode) {
            this.debugLog(`→ ${method} ${url}`);
            // Log headers (excluding Authorization for security)
            if (options?.headers) {
                const safeHeaders = { ...options.headers };
                if (safeHeaders['Authorization']) {
                    safeHeaders['Authorization'] = safeHeaders['Authorization'].substring(0, 15) + '...';
                }
                this.debugLog(`  Headers: ${JSON.stringify(safeHeaders)}`);
            }
            if (hasBody && typeof options.body === 'string') {
                const bodyPreview = options.body.length > 1000
                    ? options.body.substring(0, 1000) + `... (${options.body.length} chars total)`
                    : options.body;
                this.debugLog(`  Body: ${bodyPreview}`);
            } else if (hasBody) {
                this.debugLog(`  Body: [non-string body, e.g. FormData]`);
            }
        }

        const startTime = Date.now();
        const resp = await fetch(url, options);
        const elapsed = Date.now() - startTime;

        if (this.debugMode) {
            this.debugLog(`← ${resp.status} ${resp.statusText} (${elapsed}ms)`);
            this.outputChannel.show(true);
        }

        return resp;
    }

    /**
     * Normalizes page response to a consistent format regardless of API version.
     * Cloud v2 API returns: { id, title, spaceId, parentId, body, version }
     * Server v1 API returns: { id, title, space: { key, id }, ancestors: [...], body, version }
     * This method adds spaceId and parentId fields to Server responses for compatibility.
     */
    private normalizePageResponse(page: any): any {
        if (!page || !this.isServer()) {
            return page;
        }
        // Normalize spaceId: Server uses space.id or space.key
        if (!page.spaceId && page.space) {
            page.spaceId = page.space.id || page.space.key;
        }
        // Normalize parentId: Server uses ancestors array
        if (!page.parentId && Array.isArray(page.ancestors) && page.ancestors.length > 0) {
            page.parentId = page.ancestors[page.ancestors.length - 1].id;
        }
        return page;
    }

    async getPageByTitle(spaceKey: string, title: string): Promise<any | null> {
        let url: string;
        if (this.isServer()) {
            url = `${this.baseUrl}/rest/api/content?spaceKey=${encodeURIComponent(spaceKey)}&title=${encodeURIComponent(title)}&expand=body.${BodyFormat.STORAGE},version,space,ancestors`;
        } else {
            url = `${this.baseUrl}/api/v2/pages?spaceKey=${encodeURIComponent(spaceKey)}&title=${encodeURIComponent(title)}&expand=body.${BodyFormat.STORAGE},version,space`;
        }
        const resp = await this.debugFetch(url, { headers: { ...this.getAuthHeader(), 'Content-Type': 'application/json' } });
        if (!resp.ok) {throw new Error(await resp.text());}
        const data = await resp.json() as any;
        const page = data.results?.[0] || null;
        return this.normalizePageResponse(page);
    }

    async getPageById(pageId: string, bodyFormat: BodyFormat = BodyFormat.ATLAS_DOC_FORMAT): Promise<any | null> {
        let url: string;
        if (this.isServer()) {
            // Server v1 API uses expand parameter for body format
            const serverBodyFormat = bodyFormat === BodyFormat.ATLAS_DOC_FORMAT ? BodyFormat.STORAGE : bodyFormat;
            url = `${this.baseUrl}/rest/api/content/${pageId}?expand=body.${serverBodyFormat},version,space,ancestors`;
        } else {
            url = `${this.baseUrl}/api/v2/pages/${pageId}?body-format=${bodyFormat}`;
        }
        const resp = await this.debugFetch(url, { headers: { ...this.getAuthHeader(), 'Content-Type': 'application/json' } });
        if (resp.status === 404) {return null;}
        if (!resp.ok) {throw new Error(await resp.text());}
        const page = await resp.json() as any;
        return this.normalizePageResponse(page);
    }

    async downloadConfluencePage(pageId: string, bodyFormat: BodyFormat = BodyFormat.ATLAS_DOC_FORMAT, outputDir: string = 'Downloaded'): Promise<string> {
        const page = await this.getPageById(pageId, bodyFormat);
        if (!page) {throw new Error(`Page with ID ${pageId} not found.`);}
        // For Server, ATLAS_DOC_FORMAT is not available; fall back to STORAGE
        const formato = this.isServer() && bodyFormat === BodyFormat.ATLAS_DOC_FORMAT ? BodyFormat.STORAGE : bodyFormat;
        let conteudo: string;
        try {
            conteudo = page.body?.[formato]?.value;
            // Decodifica entidades HTML se o parâmetro estiver ativado
            const config = workspace.getConfiguration('confluenceSmartPublisher');
            if (config.get('htmlEntitiesDecode', false)) {
                conteudo = decodeHtmlEntities(conteudo);
            }
        } catch {
            throw new Error(`Content body.${formato}.value not found in API response.`);
        }
        const titulo = page.title || `${formato}_${pageId}`;
        // Use page ID as filename for consistency and to avoid filesystem issues with special characters
        const fileName = `${pageId}.confluence`;
        let baseDir: string;
        if (isAbsolute(outputDir)) {
            baseDir = outputDir;
        } else {
            const workspaceFolders = workspace.workspaceFolders;
            baseDir = workspaceFolders && workspaceFolders.length > 0 ? workspaceFolders[0].uri.fsPath : process.cwd();
            baseDir = join(baseDir, outputDir);
        }
        const filePath = join(baseDir, fileName);
        mkdirSync(dirname(filePath), { recursive: true });

        // Monta o bloco <csp:parameters>
        // 1. file_id
        const fileId = pageId;
        // 2. parent_id
        const parentId = page.parentId || '';
        // 3. labels_list
        let labelsList = '';
        try {
            // v1 API para labels
            const baseUrlV1 = this.getBaseUrlV1();
            const url = `${baseUrlV1}/rest/api/content/${pageId}/label`;
            const resp = await this.debugFetch(url, { headers: this.getAuthHeader() });
            if (resp.ok) {
                const data = await resp.json();
                if (Array.isArray(data.results)) {
                    labelsList = data.results.map((l: any) => l.name).join(',');
                }
            }
        } catch {}
        // 4. properties
        let propertiesArr: { key: string; value: string }[] = [];
        try {
            const props = await this.getContentProperties(pageId);
            if (props.length > 0) {
                for (const prop of props) {
                    if (prop.key && prop.value !== undefined) {
                        let val = typeof prop.value === 'object' ? JSON.stringify(prop.value) : String(prop.value);
                        propertiesArr.push({ key: String(prop.key), value: val });
                    }
                }
            }
        } catch {
            // Se não conseguir extrair propriedades, mantém array vazio
        }
        // Monta o objeto completo com metadados e conteúdo usando a função utilitária
        const cspMetadata = {
            file_id: String(fileId),
            title: titulo,
            labels_list: labelsList,
            parent_id: String(parentId),
            properties: propertiesArr
        };
        // Determine the output format from configuration (default: json)
        const config = workspace.getConfiguration('confluenceSmartPublisher');
        const outputFormat = (config.get('confluenceFileFormat') as string) || 'json';

        let conteudoFinal: string;
        if (outputFormat === 'yaml') {
            // For YAML format, content is always stored as a string (XHTML or raw)
            const contentStr = typeof conteudo === 'string' ? conteudo : JSON.stringify(conteudo);
            conteudoFinal = createYAMLConfluenceBlock(cspMetadata, contentStr);
        } else {
            // Default: JSON format
            const contentParsed = (() => {
                try {
                    return JSON.parse(conteudo);
                } catch {
                    return conteudo; // fallback se não for JSON válido
                }
            })();
            conteudoFinal = createJSONCSPBlock(cspMetadata, contentParsed);
        }
        writeFileSync(filePath, conteudoFinal, { encoding: 'utf-8' });

        // NOVO: Converter para Markdown se for JSON ADF
        if (formato === BodyFormat.ATLAS_DOC_FORMAT) {
            try {
                const adfJson = JSON.parse(conteudo);
                const converter = new AdfToMarkdownConverter();
                const markdownBlock = await converter.convertNode(adfJson, 0, this.baseUrl);
                const markdown = markdownBlock.markdown;
                const mdFileName = `${pageId}.md`;
                const mdFilePath = join(baseDir, mdFileName);
                writeFileSync(mdFilePath, markdown, { encoding: 'utf-8' });
            } catch (e) {
                // Se não for JSON válido, ignora a conversão
            }
        }
        return filePath;
    }

    async uploadAttachment(pageId: string, filePath: string): Promise<string | null> {
        const baseUrlV1 = this.getBaseUrlV1();
        const fileName = basename(filePath);
        // Verifica se o anexo já existe
        const checkUrl = `${baseUrlV1}/rest/api/content/${pageId}/child/attachment?filename=${encodeURIComponent(fileName)}`;
        let resp = await this.debugFetch(checkUrl, { headers: this.getAuthHeader() });
        if (!resp.ok) {throw new Error(await resp.text());}
        const results = (await resp.json() as any).results || [];
        if (results.length > 0) {
            const downloadLink = results[0]._links.download;
            return downloadLink.startsWith('/') ? baseUrlV1 + downloadLink : downloadLink;
        }
        // Upload
        const url = `${baseUrlV1}/rest/api/content/${pageId}/child/attachment`;
        const form = new FormData();
        form.append('file', createReadStream(filePath), fileName);
        resp = await this.debugFetch(url, {
            method: 'POST',
            headers: { ...this.getAuthHeader(), 'X-Atlassian-Token': 'no-check' },
            body: form as any
        });
        if (!resp.ok) {throw new Error(await resp.text());}
        const uploadResults = (await resp.json() as any).results || [];
        if (uploadResults.length > 0) {
            const downloadLink = uploadResults[0]._links.download;
            return downloadLink.startsWith('/') ? baseUrlV1 + downloadLink : downloadLink;
        }
        return null;
    }

    private async _processImagesInContent(content: string, pageId: string, baseDir: string): Promise<string> {
        // Substitui <img src="..."> por links de anexo
        const imgTagRegex = /<img\b[^>]*\bsrc=["']([^"']+)["']/g;
        const replaceImgSrc = async (match: string, src: string) => {
            if (src.startsWith('http://') || src.startsWith('https://')) {
                return match; // Não altera URLs absolutas
            }
            const imgPath = join(baseDir, src);
            if (!existsSync(imgPath)) {
                return match; // Não altera se não encontrar
            }
            const anexoUrl = await this.uploadAttachment(pageId, imgPath);
            if (anexoUrl) {
                return match.replace(src, anexoUrl);
            }
            return match;
        };
        // Como replace async não é suportado diretamente, processa manualmente
        let result = '';
        let lastIndex = 0;
        let matchArr: RegExpExecArray | null;
        while ((matchArr = imgTagRegex.exec(content)) !== null) {
            result += content.slice(lastIndex, matchArr.index);
            result += await replaceImgSrc(matchArr[0], matchArr[1]);
            lastIndex = imgTagRegex.lastIndex;
        }
        result += content.slice(lastIndex);
        content = result;

        // Processa <ac:image><ri:attachment ri:filename="..." /></ac:image>
        const acImageRegex = /<ac:image[\s\S]*?<ri:attachment[^>]*ri:filename=["']([^"']+)["'][^>]*/g;
        let acResult = '';
        lastIndex = 0;
        while ((matchArr = acImageRegex.exec(content)) !== null) {
            acResult += content.slice(lastIndex, matchArr.index);
            const filename = matchArr[1];
            const imgPath = join(baseDir, filename);
            if (existsSync(imgPath)) {
                await this.uploadAttachment(pageId, imgPath);
            }
            acResult += matchArr[0];
            lastIndex = acImageRegex.lastIndex;
        }
        acResult += content.slice(lastIndex);
        return acResult;
    }

    // Remove todas as labels da página (best-effort: logs errors but does not throw)
    async removeAllLabels(pageId: string): Promise<void> {
        const baseUrlV1 = this.getBaseUrlV1();
        const url = `${baseUrlV1}/rest/api/content/${pageId}/label`;
        const resp = await this.debugFetch(url, { headers: this.getAuthHeader() });
        if (!resp.ok) {
            this.warnLog(`Failed to list labels for page ${pageId}: ${resp.status} ${resp.statusText}`);
            return;
        }
        const data = await resp.json();
        if (Array.isArray(data.results)) {
            for (const label of data.results) {
                const labelName = label.name;
                // Server uses path param /{label}, Cloud uses query param ?name=
                const deleteUrl = this.isServer()
                    ? `${baseUrlV1}/rest/api/content/${pageId}/label/${encodeURIComponent(labelName)}`
                    : `${baseUrlV1}/rest/api/content/${pageId}/label?name=${encodeURIComponent(labelName)}`;
                try {
                    const delResp = await this.debugFetch(deleteUrl, { method: 'DELETE', headers: this.getAuthHeader() });
                    if (!delResp.ok) {
                        this.warnLog(`Failed to delete label "${labelName}" from page ${pageId}: ${delResp.status} ${delResp.statusText}`);
                    }
                } catch (e: any) {
                    this.warnLog(`Error deleting label "${labelName}" from page ${pageId}: ${e.message || e}`);
                }
            }
        }
    }

    // Remove todas as propriedades da página (best-effort: logs errors but does not throw)
    async removeAllProperties(pageId: string): Promise<void> {
        let props: any[];
        try {
            props = await this.getContentProperties(pageId);
        } catch (e: any) {
            this.warnLog(`Failed to list properties for page ${pageId}: ${e.message || e}`);
            return;
        }
        for (const prop of props) {
            if (prop.key) {
                const baseUrlV1 = this.getBaseUrlV1();
                const url = `${baseUrlV1}/rest/api/content/${pageId}/property/${encodeURIComponent(prop.key)}`;
                try {
                    const delResp = await this.debugFetch(url, { method: 'DELETE', headers: this.getAuthHeader() });
                    if (!delResp.ok && delResp.status !== 404) {
                        this.warnLog(`Failed to delete property "${prop.key}" from page ${pageId}: ${delResp.status} ${delResp.statusText}`);
                    }
                } catch (e: any) {
                    this.warnLog(`Error deleting property "${prop.key}" from page ${pageId}: ${e.message || e}`);
                }
            }
        }
    }

    // Aplica as labels e propriedades do arquivo (best-effort: each step continues on failure)
    private async applyLabelsAndPropertiesFromFile(pageId: string, labelsList: string[], propriedades: { key: string, value: string }[]) {
        try {
            await this.removeAllLabels(pageId);
        } catch (e: any) {
            this.warnLog(`removeAllLabels failed for page ${pageId}: ${e.message || e}`);
        }
        try {
            await this.removeAllProperties(pageId);
        } catch (e: any) {
            this.warnLog(`removeAllProperties failed for page ${pageId}: ${e.message || e}`);
        }
        if (labelsList.length > 0) {
            try {
                await this.setPageLabels(pageId, labelsList);
            } catch (e: any) {
                this.warnLog(`setPageLabels failed for page ${pageId}: ${e.message || e}`);
            }
        }
        if (propriedades.length > 0) {
            for (const prop of propriedades) {
                if (prop.key) {
                    try {
                        await this.updateContentProperty(pageId, prop.key, prop.value);
                    } catch (e: any) {
                        this.warnLog(`updateContentProperty failed for page ${pageId}, key "${prop.key}": ${e.message || e}`);
                    }
                }
            }
        }
    }

    private async extractProperties(content: string): Promise<{ key: string, value: string }[]> {
        return extractProperties(content);
    }

    /**
     * Extracts the XHTML storage content to send to Confluence from the file content.
     * Handles JSON format, YAML format, and legacy XHTML format.
     *
     * For JSON format files, the "content" field already contains the XHTML storage string,
     * so it is extracted via JSON.parse to properly unescape JSON string encoding (e.g., \" → ").
     *
     * For YAML format files, the "content" field contains the XHTML storage string,
     * typically using YAML block scalar (|) for multiline readability.
     *
     * For legacy XHTML files, the <csp:parameters> block is stripped via regex.
     */
    private extractStorageContent(rawContent: string): string {
        // Try JSON format first
        try {
            const parsed = JSON.parse(rawContent);
            if (parsed && typeof parsed.content === 'string') {
                return parsed.content;
            }
        } catch {
            // Not valid JSON — try YAML next
        }
        // Try YAML format
        try {
            const parsed = yaml.load(rawContent) as any;
            if (parsed && typeof parsed === 'object' && typeof parsed.content === 'string') {
                return parsed.content;
            }
        } catch {
            // Not valid YAML — fall through to legacy XHTML handling
        }
        // Legacy XHTML format: strip <csp:parameters> block
        return rawContent.replace(/<csp:parameters[\s\S]*?<\/csp:parameters>\s*/g, '');
    }

    /**
     * Ensures all <ac:structured-macro> tags have an ac:macro-id attribute.
     * Confluence Server rejects content with 500 Internal Server Error if macros lack this attribute.
     * Generates a random UUID for any macro missing ac:macro-id.
     */
    private ensureMacroIds(content: string): string {
        return content.replace(
            /<ac:structured-macro\b((?:(?!ac:macro-id)[^>])*)>/g,
            (_match, attrs: string) => {
                return `<ac:structured-macro${attrs} ac:macro-id="${randomUUID()}">`;
            }
        );
    }

    /**
     * Detects the format of a .confluence file content.
     * Returns 'json', 'yaml', or 'xml' (legacy).
     */
    private detectFileFormat(rawContent: string): 'json' | 'yaml' | 'xml' {
        try {
            const parsed = JSON.parse(rawContent);
            if (parsed && parsed.csp) { return 'json'; }
        } catch { /* not JSON */ }
        try {
            const parsed = yaml.load(rawContent) as any;
            if (parsed && typeof parsed === 'object' && parsed.csp) { return 'yaml'; }
        } catch { /* not YAML */ }
        return 'xml';
    }

    async createPageFromFile(filePath: string): Promise<any> {
        const config = workspace.getConfiguration('confluenceSmartPublisher');
        const pasta = dirname(filePath);
        const parentFile = join(pasta, '.parent');
        let content = readFileSync(filePath, 'utf-8');

        // Extrair informações usando função utilitária
        const parentId = extractParentId(content);
        if (!parentId || !/^[0-9]+$/.test(parentId)) {
            throw new Error(`Invalid or missing parentId tag: ${parentId}`);
        }
        const labelsList = extractLabels(content);
        const properties = await this.extractProperties(content);

        // Obter spaceId a partir do parentId
        const parentPage = await this.getPageById(parentId);
        if (!parentPage || !parentPage.spaceId) {
            throw new Error(`Could not get spaceId for parentId ${parentId}`);
        }
        const spaceId = parentPage.spaceId;

        // Título: use title from CSP metadata if available, otherwise fall back to file name
        const cspTitle = extractCSPValue(content, 'title');
        let title: string;
        if (cspTitle && typeof cspTitle === 'string' && cspTitle.trim()) {
            title = cspTitle.trim();
        } else {
            const titleBase = basename(filePath, extname(filePath));
            let cardJiraId: string | null = null;
            const match = content.match(/<h1>Card Jira<\/h1>\s*<a [^>]*href="[^"]+\/browse\/([A-Z]+-\d+)/);
            if (match) {
                cardJiraId = match[1];
            }
            title = cardJiraId ? `${titleBase} (${cardJiraId})` : titleBase;
        }

        // Extract XHTML storage content (handles both JSON and legacy XHTML formats)
        let contentToSend = this.ensureMacroIds(this.extractStorageContent(content));

        let payload: any;
        let url: string;
        if (this.isServer()) {
            // Server v1 API uses space.key and ancestors
            const spaceKey = parentPage.space?.key;
            if (!spaceKey) {
                throw new Error(`Could not get space key for parentId ${parentId}`);
            }
            payload = {
                type: 'page',
                status: 'current',
                title,
                space: { key: spaceKey },
                ancestors: [{ id: parentId }],
                body: {
                    storage: {
                        representation: BodyFormat.STORAGE,
                        value: contentToSend
                    }
                }
            };
            url = `${this.baseUrl}/rest/api/content`;
        } else {
            payload = {
                spaceId,
                status: 'current',
                title,
                parentId,
                body: {
                    representation: BodyFormat.STORAGE,
                    value: contentToSend
                }
            };
            url = `${this.baseUrl}/api/v2/pages`;
        }
        const resp = await this.debugFetch(url, {
            method: 'POST',
            headers: { ...this.getAuthHeader(), 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!resp.ok) {throw new Error(await resp.text());}
        const pageData = await resp.json() as any;
        const pageId = pageData.id;
        // Processa imagens locais e atualiza o conteúdo se necessário
        if (pageId) {
            const pasta = dirname(filePath);
            const contentWithImages = await this._processImagesInContent(contentToSend, pageId, pasta);
            if (contentWithImages !== contentToSend) {
                // Atualiza a página com o novo conteúdo
                let updatePayload: any;
                let updateUrl: string;
                if (this.isServer()) {
                    updatePayload = {
                        type: 'page',
                        status: 'current',
                        title,
                        body: {
                            storage: {
                                representation: BodyFormat.STORAGE,
                                value: contentWithImages
                            }
                        },
                        version: {
                            number: 2
                        }
                    };
                    updateUrl = `${this.baseUrl}/rest/api/content/${pageId}`;
                } else {
                    updatePayload = {
                        id: pageId,
                        status: 'current',
                        title,
                        spaceId,
                        body: {
                            representation: BodyFormat.STORAGE,
                            value: contentWithImages
                        },
                        version: {
                            number: 2
                        }
                    };
                    updateUrl = `${this.baseUrl}/api/v2/pages/${pageId}`;
                }
                const updateResp = await this.debugFetch(updateUrl, {
                    method: 'PUT',
                    headers: { ...this.getAuthHeader(), 'Content-Type': 'application/json' },
                    body: JSON.stringify(updatePayload)
                });
                if (!updateResp.ok) {throw new Error(await updateResp.text());}
            }
            // Remove todas as labels e propriedades antes de adicionar as do arquivo
            await this.applyLabelsAndPropertiesFromFile(pageId, labelsList, properties);
        }
        return pageData;
    }

    async updatePageFromFile(filePath: string): Promise<any> {
        const config = workspace.getConfiguration('confluenceSmartPublisher');
        let content = readFileSync(filePath, 'utf-8');

        const pageId = extractFileId(content);
        if (!pageId || !/^\d+$/.test(pageId)) {throw new Error(`Invalid or missing page ID in tag: ${pageId}`);}
        // Extract XHTML storage content (handles both JSON and legacy XHTML formats)
        let contentToSend = this.ensureMacroIds(this.extractStorageContent(content));

        const pasta = dirname(filePath);
        contentToSend = await this._processImagesInContent(contentToSend, pageId, pasta);
        const page = await this.getPageById(pageId);
        if (!page) {throw new Error(`Page with ID ${pageId} not found.`);}
        const spaceId = page.spaceId;
        if (!spaceId) {throw new Error(`spaceId not found for page ${pageId}`);}
        // Use title from CSP metadata if available, otherwise use existing page title
        const cspTitle = extractCSPValue(content, 'title');
        const title = (cspTitle && typeof cspTitle === 'string' && cspTitle.trim()) ? cspTitle.trim() : page.title;
        const version = page.version?.number || 1;
        const labelsList = extractLabels(content);
        const properties = await this.extractProperties(content);
        let payload: any;
        let url: string;
        if (this.isServer()) {
            payload = {
                type: 'page',
                status: 'current',
                title,
                body: {
                    storage: {
                        representation: BodyFormat.STORAGE,
                        value: contentToSend
                    }
                },
                version: {
                    number: version + 1
                }
            };
            url = `${this.baseUrl}/rest/api/content/${pageId}`;
        } else {
            payload = {
                id: pageId,
                status: 'current',
                title,
                spaceId,
                body: {
                    representation: BodyFormat.STORAGE,
                    value: contentToSend
                },
                version: {
                    number: version + 1
                }
            };
            url = `${this.baseUrl}/api/v2/pages/${pageId}`;
        }
        const resp = await this.debugFetch(url, {
            method: 'PUT',
            headers: { ...this.getAuthHeader(), 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!resp.ok) {throw new Error(await resp.text());}
        // Remove todas as labels e propriedades antes de adicionar as do arquivo
        await this.applyLabelsAndPropertiesFromFile(pageId, labelsList, properties);
        return await resp.json();
    }

    async setPageLabels(pageId: string, labels: string[]): Promise<any> {
        if (!Array.isArray(labels) || !labels.every(l => typeof l === 'string')) {
            throw new Error('labels must be a list of strings');
        }
        const payload = labels.map(label => ({ prefix: 'global', name: label }));
        const baseUrlV1 = this.getBaseUrlV1();
        const url = `${baseUrlV1}/rest/api/content/${pageId}/label`;
        const resp = await this.debugFetch(url, {
            method: 'POST',
            headers: { ...this.getAuthHeader(), 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!resp.ok) {throw new Error(await resp.text());}
        return await resp.json();
    }

    async getContentProperties(pageId: string): Promise<any[]> {
        const baseUrlV1 = this.getBaseUrlV1();
        const url = `${baseUrlV1}/rest/api/content/${pageId}/property`;
        const resp = await this.debugFetch(url, { headers: this.getAuthHeader() });
        if (!resp.ok) {throw new Error(await resp.text());}
        const data = await resp.json() as any;
        return data.results || [];
    }

    async updateContentProperty(pageId: string, key: string, value: any): Promise<any> {
        const baseUrlV1 = this.getBaseUrlV1();
        const url = `${baseUrlV1}/rest/api/content/${pageId}/property/${key}`;
        // Buscar a versão atual da propriedade (se existir)
        let versionNumber = 1;
        const respGet = await this.debugFetch(url, { headers: this.getAuthHeader() });
        if (respGet.status === 200) {
            const prop = await respGet.json() as any;
            versionNumber = (prop.version?.number || 1) + 1;
        }
        const payload = {
            key,
            value,
            version: { number: versionNumber }
        };
        const resp = await this.debugFetch(url, {
            method: 'PUT',
            headers: { ...this.getAuthHeader(), 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!resp.ok) {throw new Error(await resp.text());}
        return await resp.json();
    }
}

export async function publishConfluenceFile(filePath: string) {

    async function insertFileIdInFile(filePath: string, fileId: string) {
        let conteudo = await fsPromises.readFile(filePath, 'utf-8');

        // Try JSON format first
        try {
            const parsed = JSON.parse(conteudo);
            if (parsed && parsed.csp) {
                parsed.csp.file_id = fileId;
                await fsPromises.writeFile(filePath, JSON.stringify(parsed, null, 2), { encoding: 'utf-8' });
                return;
            }
        } catch {
            // Not JSON, try YAML next
        }

        // Try YAML format
        try {
            const parsed = yaml.load(conteudo) as any;
            if (parsed && typeof parsed === 'object' && parsed.csp) {
                parsed.csp.file_id = fileId;
                const yamlStr = createYAMLConfluenceBlock(parsed.csp, parsed.content);
                await fsPromises.writeFile(filePath, yamlStr, { encoding: 'utf-8' });
                return;
            }
        } catch {
            // Not YAML, fall through to legacy XML handling
        }

        // Legacy XML format
        const cspRegex = /<csp:parameters[\s\S]*?<\/csp:parameters>/;
        const cspMatch = conteudo.match(cspRegex);

        if (cspMatch) {
            conteudo = conteudo.replace(/<csp:file_id>[\s\S]*?<\/csp:file_id>\s*/, '');
            const cspContent = cspMatch[0];
            const newCspContent = cspContent.replace(
                /<csp:parameters[^>]*>/,
                `$&<csp:file_id>${fileId}</csp:file_id>\n`
            );
            conteudo = conteudo.replace(cspRegex, newCspContent);
        } else {
            const cspMetadata = {
                file_id: fileId,
                labels_list: '',
                parent_id: '',
                properties: createDefaultCSPProperties()
            };
            const cspBlock = createXMLCSPBlock(cspMetadata) + '\n\n';
            conteudo = cspBlock + conteudo;
        }

        await fsPromises.writeFile(filePath, conteudo, { encoding: 'utf-8' });
    }

    async function updatePropertiesInFile(filePath: string) {
        let conteudo = await fsPromises.readFile(filePath, 'utf-8');

        const requiredProperties = [
            { key: 'content-appearance-published', value: 'fixed-width' },
            { key: 'content-appearance-draft', value: 'fixed-width' }
        ];

        // Try JSON format first
        try {
            const parsed = JSON.parse(conteudo);
            if (parsed && parsed.csp) {
                if (!Array.isArray(parsed.csp.properties)) {
                    parsed.csp.properties = [];
                }
                let hasChanges = false;
                for (const prop of requiredProperties) {
                    const exists = parsed.csp.properties.some((p: any) => p.key === prop.key);
                    if (!exists) {
                        parsed.csp.properties.push(prop);
                        hasChanges = true;
                    }
                }
                if (hasChanges) {
                    await fsPromises.writeFile(filePath, JSON.stringify(parsed, null, 2), { encoding: 'utf-8' });
                }
                return;
            }
        } catch {
            // Not JSON, try YAML next
        }

        // Try YAML format
        try {
            const parsed = yaml.load(conteudo) as any;
            if (parsed && typeof parsed === 'object' && parsed.csp) {
                if (!Array.isArray(parsed.csp.properties)) {
                    parsed.csp.properties = [];
                }
                let hasChanges = false;
                for (const prop of requiredProperties) {
                    const exists = parsed.csp.properties.some((p: any) => p.key === prop.key);
                    if (!exists) {
                        parsed.csp.properties.push(prop);
                        hasChanges = true;
                    }
                }
                if (hasChanges) {
                    const yamlStr = createYAMLConfluenceBlock(parsed.csp, parsed.content);
                    await fsPromises.writeFile(filePath, yamlStr, { encoding: 'utf-8' });
                }
                return;
            }
        } catch {
            // Not YAML, fall through to legacy XML handling
        }

        // Legacy XML format
        const cspRegex = /<csp:parameters[\s\S]*?<\/csp:parameters>/;
        const cspMatch = conteudo.match(cspRegex);

        if (cspMatch) {
            const cspContent = cspMatch[0];
            const propertiesRegex = /<csp:properties>[\s\S]*?<\/csp:properties>/;
            const propertiesMatch = cspContent.match(propertiesRegex);

            if (propertiesMatch) {
                let propertiesContent = propertiesMatch[0];
                const requiredProperties = [
                    { key: 'content-appearance-published', value: 'fixed-width' },
                    { key: 'content-appearance-draft', value: 'fixed-width' }
                ];

                let hasChanges = false;
                for (const prop of requiredProperties) {
                    const keyRegex = new RegExp(`<csp:key>${prop.key}</csp:key>\\s*<csp:value>([^<]*)</csp:value>`);
                    const keyMatch = propertiesContent.match(keyRegex);

                    if (!keyMatch) {
                        hasChanges = true;
                        propertiesContent = propertiesContent.replace(
                            '</csp:properties>',
                            `    <csp:key>${prop.key}</csp:key>\n    <csp:value>${prop.value}</csp:value>\n  </csp:properties>`
                        );
                    }
                }

                if (hasChanges) {
                    conteudo = conteudo.replace(propertiesRegex, propertiesContent);
                    await fsPromises.writeFile(filePath, conteudo, { encoding: 'utf-8' });
                }
            } else {
                const newProperties = `  <csp:properties>\n` +
                    `    <csp:key>content-appearance-published</csp:key>\n` +
                    `    <csp:value>fixed-width</csp:value>\n` +
                    `    <csp:key>content-appearance-draft</csp:key>\n` +
                    `    <csp:value>fixed-width</csp:value>\n` +
                    `  </csp:properties>\n`;
                conteudo = conteudo.replace(
                    /<csp:parameters[^>]*>/,
                    `$&${newProperties}`
                );
                await fsPromises.writeFile(filePath, conteudo, { encoding: 'utf-8' });
            }
        }
    }

    if (!existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
    }

    // Atualiza as propriedades no arquivo local antes da publicação
    await updatePropertiesInFile(filePath);

    let conteudo = await fsPromises.readFile(filePath, 'utf-8');
    const fileId = extractFileId(conteudo);
    const client = new ConfluenceClient();
    let pageId: string;
    let resposta: any;
    if (fileId) {
        resposta = await client.updatePageFromFile(filePath);
        pageId = fileId;
    } else {
        resposta = await client.createPageFromFile(filePath);
        pageId = resposta.id;
        if (!pageId) {throw new Error('Could not get the ID of the created page.');}
        await insertFileIdInFile(filePath, pageId);
    }
    return { pageId, resposta };
}
