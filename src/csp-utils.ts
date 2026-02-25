/**
 * Utility for creating CSP (Confluence Smart Publisher) blocks
 * Creates metadata blocks in JSON or YAML format for .confluence files
 * or in YAML frontmatter format for .md files
 */

import * as yaml from 'js-yaml';

export interface CSPMetadata {
    file_id?: string;
    title?: string;
    labels_list?: string;
    parent_id?: string;
    properties?: Array<{ key: string; value: string }>;
    [key: string]: any;
}

export interface CSPBlock {
    csp: CSPMetadata;
    content?: any;
}

/**
 * Creates a CSP block in the appropriate format based on file type
 * @param metadata - CSP metadata
 * @param content - File content (optional)
 * @param fileExtension - File extension (.confluence or .md)
 * @returns String with formatted CSP block
 */
export function createCSPBlock(
    metadata: CSPMetadata,
    content?: any,
    fileExtension: '.confluence' | '.md' = '.confluence'
): string {
    if (fileExtension === '.confluence') {
        return createJSONCSPBlock(metadata, content);
    } else if (fileExtension === '.md') {
        return createYAMLCSPBlock(metadata);
    }
    throw new Error(`Unsupported file extension: ${fileExtension}`);
}

/**
 * Creates a CSP block in JSON format for .confluence files
 * @param metadata - CSP metadata
 * @param content - File content
 * @returns String with formatted JSON
 */
export function createJSONCSPBlock(metadata: CSPMetadata, content?: any): string {
    const cspBlock: CSPBlock = {
        csp: {
            file_id: metadata.file_id || '',
            labels_list: metadata.labels_list || '',
            parent_id: metadata.parent_id || '',
            properties: metadata.properties || [],
            ...metadata
        }
    };

    if (content !== undefined) {
        cspBlock.content = content;
    }

    return JSON.stringify(cspBlock, null, 2);
}

/**
 * Creates a CSP block in YAML format for .confluence files.
 * Uses YAML block scalar (|) for the content field to preserve multiline XHTML readability.
 * @param metadata - CSP metadata
 * @param content - XHTML storage content string (optional)
 * @returns String with formatted YAML document
 */
export function createYAMLConfluenceBlock(metadata: CSPMetadata, content?: string): string {
    // Build the csp metadata part separately so we can force block literal style on content
    const cspPart: any = {
        csp: {
            file_id: metadata.file_id || '',
            title: metadata.title || '',
            labels_list: metadata.labels_list || '',
            parent_id: metadata.parent_id || '',
            properties: metadata.properties || []
        }
    };

    const cspYaml = yaml.dump(cspPart, {
        lineWidth: -1,
        quotingType: '"',
        forceQuotes: false,
        noRefs: true
    });

    if (content === undefined) {
        return cspYaml;
    }

    // Force block literal strip style (|-) for content field by manually constructing it.
    // Strip style removes trailing newlines, keeping the content clean.
    const contentValue = content.endsWith('\n') ? content.slice(0, -1) : content;
    // Indent each line of content by 2 spaces for YAML block scalar
    const indentedContent = contentValue
        .split('\n')
        .map(line => line.length > 0 ? '  ' + line : '')
        .join('\n');

    return cspYaml + 'content: |-\n' + indentedContent + '\n';
}

/**
 * Creates a CSP block in YAML frontmatter format for .md files
 * @param metadata - CSP metadata
 * @returns String with formatted YAML frontmatter
 */
export function createYAMLCSPBlock(metadata: CSPMetadata): string {
    const yamlLines: string[] = ['---'];

    // Add required fields first
    if (metadata.file_id) {
        yamlLines.push(`file_id: "${metadata.file_id}"`);
    }
    if (metadata.labels_list) {
        yamlLines.push(`labels_list: "${metadata.labels_list}"`);
    }
    if (metadata.parent_id) {
        yamlLines.push(`parent_id: "${metadata.parent_id}"`);
    }

    // Add properties
    if (metadata.properties && metadata.properties.length > 0) {
        yamlLines.push('properties:');
        metadata.properties.forEach(prop => {
            yamlLines.push(`  - key: "${prop.key}"`);
            yamlLines.push(`    value: "${prop.value}"`);
        });
    }

    // Add other custom fields
    Object.keys(metadata).forEach(key => {
        if (!['file_id', 'labels_list', 'parent_id', 'properties'].includes(key)) {
            const value = metadata[key];
            if (typeof value === 'string') {
                yamlLines.push(`${key}: "${value}"`);
            } else if (typeof value === 'number' || typeof value === 'boolean') {
                yamlLines.push(`${key}: ${value}`);
            } else if (Array.isArray(value)) {
                yamlLines.push(`${key}:`);
                value.forEach(item => {
                    yamlLines.push(`  - "${item}"`);
                });
            } else if (typeof value === 'object' && value !== null) {
                yamlLines.push(`${key}: ${JSON.stringify(value)}`);
            }
        }
    });

    yamlLines.push('---');
    return yamlLines.join('\n');
}

/**
 * Creates a CSP XML block (legacy format, for compatibility)
 * @param metadata - CSP metadata
 * @returns String with formatted XML
 */
export function createXMLCSPBlock(metadata: CSPMetadata): string {
    const properties = metadata.properties || [];
    const propertiesXML = properties.map(prop =>
        `    <csp:key>${prop.key}</csp:key>\n    <csp:value>${prop.value}</csp:value>`
    ).join('\n');

    return `<csp:parameters xmlns:csp="https://confluence.smart.publisher/csp">
  <csp:file_id>${metadata.file_id || ''}</csp:file_id>
  <csp:labels_list>${metadata.labels_list || ''}</csp:labels_list>
  <csp:parent_id>${metadata.parent_id || ''}</csp:parent_id>
  <csp:properties>
${propertiesXML}
  </csp:properties>
</csp:parameters>`;
}

/**
 * Creates default CSP properties for new documents
 * @returns Array of default properties
 */
export function createDefaultCSPProperties(): Array<{ key: string; value: string }> {
    return [
        { key: 'content-appearance-published', value: 'fixed-width' },
        { key: 'content-appearance-draft', value: 'fixed-width' }
    ];
}

/**
 * Extracts CSP metadata from JSON content
 * @param jsonContent - JSON content from .confluence file
 * @returns Extracted CSP metadata
 */
export function extractCSPFromJSON(jsonContent: string): CSPMetadata | null {
    try {
        const parsed = JSON.parse(jsonContent);
        return parsed.csp || null;
    } catch {
        return null;
    }
}

/**
 * Extracts CSP metadata from YAML frontmatter
 * @param markdownContent - Markdown content with frontmatter
 * @returns Extracted CSP metadata
 */
export function extractCSPFromYAML(markdownContent: string): CSPMetadata | null {
    const yamlMatch = markdownContent.match(/^---\n([\s\S]*?)\n---/);
    if (!yamlMatch) {return null;}

    try {
        // Simple YAML parsing implementation
        const yamlLines = yamlMatch[1].split('\n');
        const metadata: CSPMetadata = {};

        for (const line of yamlLines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) {continue;}

            const colonIndex = trimmed.indexOf(':');
            if (colonIndex === -1) {continue;}

            const key = trimmed.substring(0, colonIndex).trim();
            const value = trimmed.substring(colonIndex + 1).trim().replace(/^["']|["']$/g, '');

            metadata[key] = value;
        }

        return metadata;
    } catch {
        return null;
    }
}

/**
 * Interface for extracted CSP IDs
 */
export interface CSPIds {
    file_id: string | null;
    parent_id: string | null;
}

/**
 * Extracts file_id and parent_id from CSP content in any format (JSON, YAML, XML)
 * @param content - Content containing CSP metadata
 * @returns Object with extracted IDs or null values if not found
 */
export function extractCSPIds(content: string): CSPIds {
    return {
        file_id: extractCSPValue(content, 'file_id'),
        parent_id: extractCSPValue(content, 'parent_id')
    };
}

/**
 * Extracts only file_id from CSP content in any format
 * @param content - Content containing CSP metadata
 * @returns file_id as string or null if not found
 */
export function extractFileId(content: string): string | null {
    return extractCSPValue(content, 'file_id');
}

/**
 * Extracts only parent_id from CSP content in any format
 * @param content - Content containing CSP metadata
 * @returns parent_id as string or null if not found
 */
export function extractParentId(content: string): string | null {
    return extractCSPValue(content, 'parent_id');
}

/**
 * Internal helper to extract a value from a parsed CSP metadata object.
 * Used by extractCSPValue to avoid code duplication between JSON and YAML parsing paths.
 */
function _extractFromCSPObject(csp: any, key: string, propertyKey?: string): any {
    if (key === 'properties' && propertyKey) {
        if (Array.isArray(csp.properties)) {
            const prop = csp.properties.find((p: any) => p && p.key === propertyKey);
            return prop ? prop.value : null;
        }
        return null;
    } else if (key === 'properties') {
        return Array.isArray(csp.properties) ? csp.properties : [];
    } else if (key === 'labels_list') {
        const labelsList = csp.labels_list;
        if (typeof labelsList === 'string' && labelsList.trim()) {
            return labelsList.split(',').map((label: string) => label.trim()).filter((label: string) => label);
        }
        return [];
    } else {
        return csp[key] || null;
    }
}

/**
 * Generic function to extract any CSP metadata value from content in any format (JSON, YAML, XML)
 * @param content - Content containing CSP metadata
 * @param key - The key to extract (e.g., 'file_id', 'labels_list', 'properties')
 * @param propertyKey - Optional: specific property key when extracting from properties array
 * @returns The extracted value or null if not found
 */
export function extractCSPValue(content: string, key: string, propertyKey?: string): any {
    if (!content || typeof content !== 'string' || !key) {
        return null;
    }

    // Try JSON format first (most common for .confluence files)
    try {
        const parsed = JSON.parse(content);
        if (parsed.csp) {
            return _extractFromCSPObject(parsed.csp, key, propertyKey);
        }
    } catch {
        // Not JSON, continue to other formats
    }

    // Try full YAML document format (for .confluence files with csp: key)
    try {
        const parsed = yaml.load(content) as any;
        if (parsed && typeof parsed === 'object' && parsed.csp) {
            return _extractFromCSPObject(parsed.csp, key, propertyKey);
        }
    } catch {
        // Not valid YAML, continue to other formats
    }

    // Try YAML frontmatter format (for .md files)
    const yamlMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (yamlMatch) {
        const yamlContent = yamlMatch[1];

        if (key === 'properties' && propertyKey) {
            // Extract specific property value from YAML
            const propertiesMatch = yamlContent.match(/^properties:\s*\n((?:\s+-.*\n)*)/m);
            if (propertiesMatch) {
                const propertiesSection = propertiesMatch[1];
                const propertyBlocks = propertiesSection.split(/\n\s*-\s*/).filter(block => block.trim());

                for (const block of propertyBlocks) {
                    const keyMatch = block.match(/key:\s*["']?([^"'\n]+)["']?/);
                    const valueMatch = block.match(/value:\s*["']?([^"'\n]+)["']?/);

                    if (keyMatch && valueMatch && keyMatch[1].trim() === propertyKey) {
                        return valueMatch[1].trim();
                    }
                }
            }
            return null;
        } else if (key === 'properties') {
            // Return all properties from YAML
            const properties: Array<{ key: string; value: string }> = [];
            const propertiesMatch = yamlContent.match(/^properties:\s*\n((?:\s+-.*\n)*)/m);

            if (propertiesMatch) {
                const propertiesSection = propertiesMatch[1];
                const propertyBlocks = propertiesSection.split(/\n\s*-\s*/).filter(block => block.trim());

                for (const block of propertyBlocks) {
                    const keyMatch = block.match(/key:\s*["']?([^"'\n]+)["']?/);
                    const valueMatch = block.match(/value:\s*["']?([^"'\n]+)["']?/);

                    if (keyMatch && valueMatch) {
                        properties.push({
                            key: keyMatch[1].trim(),
                            value: valueMatch[1].trim()
                        });
                    }
                }
            }
            return properties;
        } else if (key === 'labels_list') {
            // Special handling for labels in YAML
            const labelsMatch = yamlContent.match(/^labels_list:\s*["']?([^"'\n]+)["']?/m);
            if (labelsMatch) {
                const labelsList = labelsMatch[1].trim();
                if (labelsList) {
                    return labelsList.split(',').map((label: string) => label.trim()).filter((label: string) => label);
                }
            }
            return [];
        } else {
            // Direct key extraction from YAML
            const keyMatch = yamlContent.match(new RegExp(`^${key}:\\s*["']?([^"'\\n]+)["']?`, 'm'));
            return keyMatch ? keyMatch[1].trim() : null;
        }
    }

    // Try XML format (legacy format)
    if (key === 'properties' && propertyKey) {
        // Extract specific property value from XML
        const xmlPropsMatch = content.match(/<csp:properties>([\s\S]*?)<\/csp:properties>/);
        if (xmlPropsMatch) {
            const propContent = xmlPropsMatch[1];
            const keyRegex = /<csp:key>(.*?)<\/csp:key>\s*<csp:value>(.*?)<\/csp:value>/g;
            let keyMatch;

            while ((keyMatch = keyRegex.exec(propContent)) !== null) {
                if (keyMatch[1].trim() === propertyKey) {
                    return keyMatch[2].trim();
                }
            }
        }
        return null;
    } else if (key === 'properties') {
        // Return all properties from XML
        const properties: Array<{ key: string; value: string }> = [];
        const xmlPropsMatch = content.match(/<csp:properties>([\s\S]*?)<\/csp:properties>/);
        if (xmlPropsMatch) {
            const propContent = xmlPropsMatch[1];
            const keyRegex = /<csp:key>(.*?)<\/csp:key>\s*<csp:value>(.*?)<\/csp:value>/g;
            let keyMatch;

            while ((keyMatch = keyRegex.exec(propContent)) !== null) {
                const propKey = keyMatch[1].trim();
                const propValue = keyMatch[2].trim();
                if (propKey) {
                    properties.push({ key: propKey, value: propValue });
                }
            }
        }
        return properties;
    } else if (key === 'labels_list') {
        // Special handling for labels in XML
        const xmlLabelsMatch = content.match(/<csp:labels_list>(.*?)<\/csp:labels_list>/);
        if (xmlLabelsMatch) {
            const labelsList = xmlLabelsMatch[1].trim();
            if (labelsList) {
                return labelsList.split(',').map((label: string) => label.trim()).filter((label: string) => label);
            }
        }
        return [];
    } else {
        // Direct key extraction from XML
        const xmlMatch = content.match(new RegExp(`<csp:${key}>(.*?)</csp:${key}>`));
        return xmlMatch ? xmlMatch[1].trim() : null;
    }
}

/**
 * Extracts properties from CSP content in any format (JSON, YAML, XML)
 * @param content - Content containing CSP metadata
 * @returns Array of properties with key-value pairs
 */
export function extractProperties(content: string): Array<{ key: string; value: string }> {
    return extractCSPValue(content, 'properties') || [];
}

/**
 * Extracts labels from CSP content in any format (JSON, YAML, XML)
 * @param content - Content containing CSP metadata
 * @returns Array of label strings
 */
export function extractLabels(content: string): string[] {
    return extractCSPValue(content, 'labels_list') || [];
}
