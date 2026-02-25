// The module 'vscode' contains the VS Code extensibility API
import * as vscode from 'vscode';
import { registerCommands, registerDiagnostics, registerFormatters, registerCompletionProviders } from './index';
import { ConfluenceClient } from './confluenceClient';

let outputChannel: vscode.OutputChannel;

// This method is called when your extension is activated
export function activate(context: vscode.ExtensionContext) {
	outputChannel = vscode.window.createOutputChannel('Confluence Smart Publisher');
	context.subscriptions.push(outputChannel);

	// Share the output channel with ConfluenceClient so it doesn't create new ones
	ConfluenceClient.setOutputChannel(outputChannel);
	
	// Exibir mensagem de ativação após toda a configuração
	outputChannel.appendLine('Confluence Smart Publisher activated!');
	
	// Registrar diagnósticos
	registerDiagnostics(context, outputChannel);
	outputChannel.appendLine('CSP diagnostics registered!');

	// Registrar comandos
	registerCommands(context, outputChannel);
	outputChannel.appendLine('CSP commands registered!');

	// Registrar formatadores
	registerFormatters(context, outputChannel);
	outputChannel.appendLine('CSP formatters registered!');

	// Registrar provedores de completação
	registerCompletionProviders(context, outputChannel);
	outputChannel.appendLine('CSP completion providers registered!');
	
}

// This method is called when your extension is deactivated
export function deactivate() {
	outputChannel.appendLine('CSP deactivated!');
}