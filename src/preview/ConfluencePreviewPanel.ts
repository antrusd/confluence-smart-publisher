import * as vscode from 'vscode';
import { ConfluenceRenderer } from './ConfluenceRenderer';

/**
 * ConfluencePreviewPanel manages the lifecycle of the Confluence preview WebviewPanel.
 * Follows the same singleton pattern as PreviewPanel but for .confluence files.
 */
export class ConfluencePreviewPanel {
    public static currentPanel: ConfluencePreviewPanel | undefined;
    private static readonly viewType = 'confluencePreview';

    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private readonly _renderer: ConfluenceRenderer;
    private _disposables: vscode.Disposable[] = [];
    private _currentDocument: vscode.TextDocument | undefined;
    private _initialDocument: vscode.TextDocument | undefined;
    private _updateTimeout: NodeJS.Timeout | undefined;

    public static createOrShow(extensionUri: vscode.Uri, outputChannel: vscode.OutputChannel) {
        const activeEditor = vscode.window.activeTextEditor;
        const column = activeEditor ? vscode.ViewColumn.Beside : undefined;

        // If we already have a panel, show it and update with current document
        if (ConfluencePreviewPanel.currentPanel) {
            ConfluencePreviewPanel.currentPanel._panel.reveal(column);
            // Update with current active document if it's a confluence file
            if (activeEditor && ConfluencePreviewPanel.currentPanel._isConfluenceDocument(activeEditor.document)) {
                ConfluencePreviewPanel.currentPanel._initialDocument = activeEditor.document;
                ConfluencePreviewPanel.currentPanel._update();
            }
            return;
        }

        // Otherwise, create a new panel
        const panel = vscode.window.createWebviewPanel(
            ConfluencePreviewPanel.viewType,
            'Confluence Preview',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [extensionUri],
                retainContextWhenHidden: true,
            }
        );

        ConfluencePreviewPanel.currentPanel = new ConfluencePreviewPanel(
            panel, extensionUri, outputChannel, activeEditor?.document
        );
    }

    public static revive(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
        outputChannel: vscode.OutputChannel,
    ) {
        ConfluencePreviewPanel.currentPanel = new ConfluencePreviewPanel(panel, extensionUri, outputChannel);
    }

    private constructor(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
        private readonly outputChannel: vscode.OutputChannel,
        initialDocument?: vscode.TextDocument,
    ) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._renderer = new ConfluenceRenderer(extensionUri);
        this._initialDocument = initialDocument;

        // Set the webview's initial html content
        this._update();

        // Listen for when the panel is disposed
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        // Update the content based on view changes
        this._panel.onDidChangeViewState(
            _e => {
                if (this._panel.visible) {
                    this._update();
                }
            },
            null,
            this._disposables,
        );

        // Listen for changes to the active text editor
        vscode.window.onDidChangeActiveTextEditor(
            (editor) => {
                if (this._panel.visible) {
                    if (editor && this._isConfluenceDocument(editor.document)) {
                        this._initialDocument = editor.document;
                    }
                    this._updateDebounced();
                }
            },
            null,
            this._disposables,
        );

        // Listen for text document changes
        vscode.workspace.onDidChangeTextDocument(
            e => {
                if (this._panel.visible && this._isConfluenceDocument(e.document)) {
                    if (this._initialDocument && e.document.uri.toString() === this._initialDocument.uri.toString()) {
                        this._initialDocument = e.document;
                    }
                    this._updateDebounced();
                }
            },
            null,
            this._disposables,
        );

        // Handle messages from the webview
        this._panel.webview.onDidReceiveMessage(
            message => {
                switch (message.command) {
                    case 'alert':
                        vscode.window.showErrorMessage(message.text);
                        return;
                }
            },
            null,
            this._disposables,
        );
    }

    public dispose() {
        ConfluencePreviewPanel.currentPanel = undefined;
        this._panel.dispose();

        if (this._updateTimeout) {
            clearTimeout(this._updateTimeout);
        }

        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }

    private _isConfluenceDocument(document: vscode.TextDocument): boolean {
        return document.languageId === 'confluence';
    }

    private _isDocumentValid(document: vscode.TextDocument): boolean {
        try {
            document.getText();
            return true;
        } catch (_error) {
            return false;
        }
    }

    private _updateDebounced() {
        if (this._updateTimeout) {
            clearTimeout(this._updateTimeout);
        }

        this._updateTimeout = setTimeout(() => {
            this._update();
        }, 300);
    }

    private _update() {
        const activeEditor = vscode.window.activeTextEditor;
        let document: vscode.TextDocument | undefined;

        // Try to use the active editor's document first
        if (activeEditor && this._isConfluenceDocument(activeEditor.document)) {
            document = activeEditor.document;
            this._initialDocument = document;
        }
        // If no active editor or not confluence, use the initial document if still valid
        else if (
            this._initialDocument &&
            this._isDocumentValid(this._initialDocument) &&
            this._isConfluenceDocument(this._initialDocument)
        ) {
            document = this._initialDocument;
        }

        // If no document available, show welcome screen
        if (!document) {
            if (this._initialDocument && !this._isDocumentValid(this._initialDocument)) {
                this._initialDocument = undefined;
            }
            this._panel.webview.html = this._getWelcomeHtml();
            return;
        }

        // If document is not confluence, show not-confluence screen
        if (!this._isConfluenceDocument(document)) {
            this._panel.webview.html = this._getNotConfluenceHtml();
            return;
        }

        this._currentDocument = document;
        const content = document.getText();

        try {
            this.outputChannel.appendLine(`[Confluence Preview] Updating preview for: ${document.fileName}`);
            const html = this._renderer.renderToHtml(content, document.uri);
            this._panel.webview.html = html;

            // Update panel title with file name
            const fileName = document.fileName.split(/[\/\\]/).pop() || 'Confluence Preview';
            this._panel.title = `Preview: ${fileName}`;
        } catch (error) {
            this.outputChannel.appendLine(`[Confluence Preview] Error rendering: ${error}`);
            this._panel.webview.html = this._getErrorHtml(error);
        }
    }

    private _getWelcomeHtml(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Confluence Preview</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 2rem; background: #1e1e1e; color: rgba(255,255,255,0.87); text-align: center; }
        .confluence-welcome { max-width: 600px; margin: 60px auto; padding: 2rem; background: #2d2d2d; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.4); }
        .confluence-welcome__icon { font-size: 4rem; margin-bottom: 1rem; }
        h1 { color: #82b1ff; margin-bottom: 1rem; }
        p { line-height: 1.6; color: rgba(255,255,255,0.7); }
        .confluence-welcome__tip { background: #3c3c3c; padding: 1rem; border-radius: 4px; margin-top: 1rem; font-style: italic; }
        code { background: #404040; color: #e1e1e1; padding: 0.2em 0.4em; border-radius: 3px; }
    </style>
</head>
<body>
    <div class="confluence-welcome">
        <div class="confluence-welcome__icon">📄</div>
        <h1>Confluence Preview</h1>
        <p>Open a <code>.confluence</code> file to see a live preview of the Confluence Storage Format content.</p>
        <div class="confluence-welcome__tip">
            💡 Tip: The preview renders headings, tables, code blocks, panels (info/note/warning/tip), and more!
        </div>
    </div>
</body>
</html>`;
    }

    private _getNotConfluenceHtml(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Confluence Preview</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 2rem; background: #1e1e1e; color: rgba(255,255,255,0.87); text-align: center; }
        .message-container { max-width: 600px; margin: 60px auto; padding: 2rem; background: #2d2d2d; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.4); }
        .message-icon { font-size: 3rem; margin-bottom: 1rem; }
        h2 { color: #ffb74d; margin-bottom: 1rem; }
        p { line-height: 1.6; color: rgba(255,255,255,0.7); }
        code { background: #404040; color: #e1e1e1; padding: 0.2em 0.4em; border-radius: 3px; }
    </style>
</head>
<body>
    <div class="message-container">
        <div class="message-icon">⚠️</div>
        <h2>Not a Confluence File</h2>
        <p>The currently active file is not a Confluence document.</p>
        <p>Please open a <code>.confluence</code> file to see the preview.</p>
    </div>
</body>
</html>`;
    }

    private _getErrorHtml(error: any): string {
        const errorMessage = error?.message || error?.toString() || 'Unknown error';
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Confluence Preview - Error</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 2rem; background: #1e1e1e; color: rgba(255,255,255,0.87); text-align: center; }
        .confluence-error { max-width: 600px; margin: 60px auto; padding: 2rem; background: #2d2d2d; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.4); border-left: 4px solid #ef5350; }
        .confluence-error__icon { font-size: 3rem; margin-bottom: 1rem; }
        h2 { color: #ef5350; margin-bottom: 1rem; }
        p { line-height: 1.6; color: rgba(255,255,255,0.7); }
        .confluence-error__details { background: #3c2222; padding: 1rem; border-radius: 4px; margin-top: 1rem; font-family: monospace; text-align: left; color: #ff8a80; font-size: 13px; }
    </style>
</head>
<body>
    <div class="confluence-error">
        <div class="confluence-error__icon">🚨</div>
        <h2>Preview Error</h2>
        <p>An error occurred while rendering the Confluence preview.</p>
        <div class="confluence-error__details">${this._escapeHtml(errorMessage)}</div>
    </div>
</body>
</html>`;
    }

    private _escapeHtml(text: string): string {
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
