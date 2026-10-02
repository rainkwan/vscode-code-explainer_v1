import * as vscode from 'vscode';
import OpenAI from 'openai';

export function activate(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand('lineExplainer.explainLine', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage('No active text editor found.');
      return;
    }

    const document = editor.document;
    const selection = editor.selection;
    const lineNumber = selection.active.line;
    const targetLineText = document.lineAt(lineNumber).text.trim();

    if (!targetLineText) {
      vscode.window.showInformationMessage('Selected line is empty.');
      return;
    }

    // 1. Get API Key
    const config = vscode.workspace.getConfiguration('lineExplainer');
    let apiKey = (config.get('apiKey') as string) || process.env.OPENAI_API_KEY;

    if (!apiKey) {
      apiKey = await vscode.window.showInputBox({
        prompt: 'Enter your OpenAI API Key',
        ignoreFocusOut: true,
        password: true
      });
      if (!apiKey) {
        vscode.window.showWarningMessage('OpenAI API Key is required.');
        return;
      }
    }

    const modelName = (config.get('model') as string) || 'gpt-4o';
    const openai = new OpenAI({ apiKey });

    // 2. Extract Context (Surrounding lines / full file)
    const totalLines = document.lineCount;
    const startLine = Math.max(0, lineNumber - 15);
    const endLine = Math.min(totalLines - 1, lineNumber + 15);
    const surroundingContext = document.getText(new vscode.Range(startLine, 0, endLine, document.lineAt(endLine).text.length));
    const fullFileText = document.getText();

    // 3. Create Webview Panel
    const panel = vscode.window.createWebviewPanel(
      'lineExplainerPanel',
      `Line Explainer: Line ${lineNumber + 1}`,
      vscode.ViewColumn.Beside,
      { enableScripts: true }
    );

    panel.webview.html = getLoadingWebviewHtml(targetLineText, lineNumber + 1);

    try {
      // 4. OpenAI Prompting with Cause-and-Effect Focus
      const response = await openai.beta.chat.completions.parse({
        model: modelName,
        messages: [
          {
            role: 'system',
            content: `You are an intuitive code tutor. Explain lines of code in clear, human-readable terms focusing on cause and effect.
            
When breaking down variables:
1. Explain where the variable originated or was passed in.
2. Explain what role it plays on this line.
3. Explicitly explain cause and effect: "Changing or modifying this value will result in..."

Avoid generic textbook definitions. Use active, relational language.`
          },
          {
            role: 'user',
            content: `Analyze Line ${lineNumber + 1} of file \`${document.fileName}\`:

--- TARGET LINE ${lineNumber + 1} ---
${targetLineText}

--- SURROUNDING FUNCTION / SCOPE ---
${surroundingContext}

--- FULL FILE CONTEXT ---
${fullFileText}`
          }
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'line_cause_effect_explanation',
            strict: true,
            schema: {
              type: 'object',
              properties: {
                summary_sentence: {
                  type: 'string',
                  description: 'A 1-2 sentence plain-English summary of what this line achieves.'
                },
                function_role: {
                  type: 'string',
                  description: 'Explains how this line fits into the parent function or scope.'
                },
                variables: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      name: { type: 'string', description: 'Variable or parameter name.' },
                      origin: { type: 'string', description: 'Where this variable came from (e.g., parameter, previous line, global).' },
                      usage: { type: 'string', description: 'What this variable is used to do on this specific line.' },
                      impact_if_changed: { type: 'string', description: 'Cause-and-effect: what happens if this variable value changes or is broken.' }
                    },
                    required: ['name', 'origin', 'usage', 'impact_if_changed'],
                    additionalProperties: false
                  },
                  description: 'Cause-and-effect breakdown of every variable on this line.'
                },
                downstream_impact: {
                  type: 'string',
                  description: 'What future lines or function returns depend on the output of this line.'
                }
              },
              required: ['summary_sentence', 'function_role', 'variables', 'downstream_impact'],
              additionalProperties: false
            }
          }
        }
      });

      const explanation = response.choices[0].message.parsed;
      panel.webview.html = getResultWebviewHtml(targetLineText, lineNumber + 1, explanation);

    } catch (err: any) {
      panel.webview.html = getErrorWebviewHtml(err?.message || 'Failed to explain line.');
    }
  });

  context.subscriptions.push(disposable);
}

export function deactivate() {}

// ---------------------------------------------------------------------------
// HTML Webview Renderers
// ---------------------------------------------------------------------------

function getLoadingWebviewHtml(lineCode: string, lineNum: number): string {
  return `<!DOCTYPE html>
  <html>
  <head>
    <style>
      body { font-family: system-ui, sans-serif; padding: 20px; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
      .code-box { background: var(--vscode-editor-inactiveSelectionBackground); padding: 10px; border-radius: 6px; font-family: monospace; }
      .spinner { margin-top: 20px; color: var(--vscode-descriptionForeground); }
    </style>
  </head>
  <body>
    <h3>🔍 Analyzing Line ${lineNum}...</h3>
    <div class="code-box"><code>${escapeHtml(lineCode)}</code></div>
    <p class="spinner">⚡ Requesting cause-and-effect breakdown from OpenAI...</p>
  </body>
  </html>`;
}

function getResultWebviewHtml(lineCode: string, lineNum: number, data: any): string {
  const varsHtml = data.variables.map((v: any) => `
    <div style="margin-bottom: 16px; padding: 12px; background: var(--vscode-welcomePage-tileBackground); border-radius: 6px; border-left: 4px solid var(--vscode-symbolIcon-variableForeground);">
      <h4 style="margin: 0 0 6px 0; font-family: monospace; font-size: 1.1em; color: var(--vscode-textPreformat-foreground);">${escapeHtml(v.name)}</h4>
      <p style="margin: 4px 0;"><strong>📍 Where it comes from:</strong> ${escapeHtml(v.origin)}</p>
      <p style="margin: 4px 0;"><strong>⚙️ How it is used here:</strong> ${escapeHtml(v.usage)}</p>
      <p style="margin: 4px 0; color: var(--vscode-editorWarning-foreground);"><strong>💥 Impact if changed:</strong> ${escapeHtml(v.impact_if_changed)}</p>
    </div>
  `).join('');

  return `<!DOCTYPE html>
  <html>
  <head>
    <style>
      body { font-family: system-ui, -apple-system, sans-serif; padding: 20px; line-height: 1.5; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
      .code-header { background: var(--vscode-textBlockQuote-background); padding: 10px 14px; border-left: 4px solid var(--vscode-button-background); font-family: monospace; border-radius: 4px; margin-bottom: 20px; }
      h2 { color: var(--vscode-symbolIcon-keywordForeground); margin-top: 24px; border-bottom: 1px solid var(--vscode-widget-border); padding-bottom: 6px; }
      .card { background: var(--vscode-editor-inactiveSelectionBackground); padding: 12px 16px; border-radius: 6px; margin-bottom: 16px; }
    </style>
  </head>
  <body>
    <div class="code-header">
      <strong>Line ${lineNum}:</strong> <code>${escapeHtml(lineCode)}</code>
    </div>

    <h2>📝 What This Line Does</h2>
    <div class="card">${escapeHtml(data.summary_sentence)}</div>

    <h2>🏗️ Role in Parent Function</h2>
    <div class="card">${escapeHtml(data.function_role)}</div>

    <h2>🔗 Variable Cause & Effect Breakdown</h2>
    ${varsHtml}

    <h2>➡️ Downstream Impact</h2>
    <div class="card">${escapeHtml(data.downstream_impact)}</div>
  </body>
  </html>`;
}

function getErrorWebviewHtml(errorMsg: string): string {
  return `<!DOCTYPE html>
  <html>
  <body style="font-family: system-ui; padding: 20px; color: var(--vscode-errorForeground);">
    <h3>❌ Explanation Failed</h3>
    <p>${escapeHtml(errorMsg)}</p>
  </body>
  </html>`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}
