#!/usr/bin/env node

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const AGENT_VERSION = '0.1.2';
const PORT = Number(process.env.INHOUSE_AGENT_PORT || 7823);
const HOST = process.env.INHOUSE_AGENT_HOST || '127.0.0.1';
const IS_WINDOWS = process.platform === 'win32';
const PATH_SEPARATOR = IS_WINDOWS ? ';' : ':';
const COMMAND_EXTENSIONS = IS_WINDOWS
  ? String(process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
  : [''];

const PROVIDER_DEFS = {
  codex: {
    id: 'codex',
    label: 'Codex',
    command: 'codex',
    installCommand: IS_WINDOWS ? 'npm.cmd install -g @openai/codex@latest' : 'npm install -g @openai/codex@latest',
    launchCommand: 'codex --login',
    authPaths: [
      path.join(os.homedir(), '.codex', 'auth.json')
    ],
    commandCandidates: [],
    envVars: ['OPENAI_API_KEY']
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini CLI',
    command: 'gemini',
    installCommand: IS_WINDOWS ? 'npm.cmd install -g @google/gemini-cli@latest' : 'npm install -g @google/gemini-cli@latest',
    launchCommand: 'gemini',
    authPaths: [
      path.join(os.homedir(), '.gemini', 'oauth_creds.json')
    ],
    commandCandidates: [],
    envVars: ['GEMINI_API_KEY', 'GOOGLE_API_KEY']
  },
  claude: {
    id: 'claude',
    label: 'Claude Code',
    command: 'claude',
    installCommand: '',
    launchCommand: 'claude',
    authPaths: [
      path.join(os.homedir(), '.claude', '.credentials.json')
    ],
    commandCandidates: [
      path.join(os.homedir(), '.local', 'bin', 'claude.exe'),
      path.join(os.homedir(), '.local', 'bin', 'claude.cmd'),
      path.join(os.homedir(), '.local', 'bin', 'claude')
    ],
    envVars: ['ANTHROPIC_API_KEY']
  }
};

function pathExists(targetPath) {
  try {
    fs.accessSync(targetPath);
    return true;
  } catch (_) {
    return false;
  }
}

function resolveCommandPath(command) {
  if (!command) return '';
  if (command.includes(path.sep) || path.isAbsolute(command)) {
    return pathExists(command) ? command : '';
  }
  const envPath = String(process.env.PATH || '');
  const directories = envPath.split(PATH_SEPARATOR).filter(Boolean);
  const hasExtension = /\.[a-z0-9]+$/i.test(command);
  for (const directory of directories) {
    for (const ext of (hasExtension ? [''] : COMMAND_EXTENSIONS)) {
      const candidate = path.join(directory, command + ext);
      if (!pathExists(candidate)) continue;
      try {
        const stat = fs.statSync(candidate);
        if (stat.isFile()) return candidate;
      } catch (_) {}
    }
  }
  return '';
}

function resolveProviderCommand(provider) {
  if (!provider) return '';
  const candidatePaths = Array.isArray(provider.commandCandidates)
    ? provider.commandCandidates.filter(Boolean)
    : [];
  for (const candidate of candidatePaths) {
    if (pathExists(candidate)) {
      return candidate;
    }
  }
  return resolveCommandPath(provider.command);
}

function commandExtension(commandPath) {
  return path.extname(String(commandPath || '')).toLowerCase();
}

function isWindowsShellShim(commandPath) {
  if (!IS_WINDOWS) return false;
  const ext = commandExtension(commandPath);
  return ext === '.cmd' || ext === '.bat';
}

function quoteForCmd(arg) {
  const value = String(arg == null ? '' : arg);
  if (!/[\s"]/u.test(value)) {
    return value;
  }
  return '"' + value
    .replace(/(\\*)"/g, '$1$1\\"')
    .replace(/(\\+)$/g, '$1$1') + '"';
}

function windowsCommandLine(command, args) {
  return [quoteForCmd(command)].concat((args || []).map(quoteForCmd)).join(' ');
}

function resolveWindowsShimExecution(commandPath) {
  if (!isWindowsShellShim(commandPath)) {
    return null;
  }
  try {
    const shimText = fs.readFileSync(commandPath, 'utf8');
    const targetMatch = shimText.match(/"%dp0%\\([^"]+)"\s+%\*/i);
    if (!targetMatch) {
      return null;
    }
    const shimDir = path.dirname(commandPath);
    const nodeInShimDir = path.join(shimDir, 'node.exe');
    const nodeBinary = pathExists(nodeInShimDir) ? nodeInShimDir : 'node';
    const relativeScriptPath = targetMatch[1].replace(/\\/g, path.sep);
    const scriptPath = path.join(shimDir, relativeScriptPath);
    if (!pathExists(scriptPath)) {
      return null;
    }
    return {
      command: nodeBinary,
      argsPrefix: [scriptPath]
    };
  } catch (_) {
    return null;
  }
}

function stripAnsi(value) {
  return String(value || '').replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

function firstNonEmptyText(value) {
  if (typeof value === 'string') {
    const text = stripAnsi(value).trim();
    return text || '';
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = firstNonEmptyText(item);
      if (text) return text;
    }
    return '';
  }
  if (!value || typeof value !== 'object') {
    return '';
  }
  const priorityKeys = ['response', 'result', 'text', 'content', 'message', 'output'];
  for (const key of priorityKeys) {
    if (!(key in value)) continue;
    const text = firstNonEmptyText(value[key]);
    if (text) return text;
  }
  for (const key of Object.keys(value)) {
    const text = firstNonEmptyText(value[key]);
    if (text) return text;
  }
  return '';
}

function compactWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function extractFriendlyProviderMessage(providerId, stdout, stderr) {
  const combined = stripAnsi((stderr || '') + '\n' + (stdout || ''));
  const patterns = [
    /ERROR:\s*([^\r\n]+)/i,
    /(You've hit your usage limit\.[^\r\n]*)/i,
    /(You've hit your limit[^\r\n]*)/i,
    /(Login required[^\r\n]*)/i,
    /(Not authenticated[^\r\n]*)/i,
    /(Please run .*login[^\r\n]*)/i,
    /(API key[^.\r\n]*\.[^\r\n]*)/i
  ];
  for (const pattern of patterns) {
    const match = combined.match(pattern);
    if (match && match[1]) {
      return compactWhitespace(match[1]);
    }
  }
  if (providerId === 'codex' && /403 Forbidden/i.test(combined) && /chatgpt\.com/i.test(combined)) {
    return 'Codex no pudo validar la sesion actual. Pulsa "Conectar Codex" para volver a iniciar sesion.';
  }
  return '';
}

function getProviderStatus(providerId) {
  const provider = PROVIDER_DEFS[providerId];
  if (!provider) return null;
  const commandPath = resolveProviderCommand(provider);
  const authPath = provider.authPaths.find(pathExists) || '';
  const envVar = provider.envVars.find((key) => !!process.env[key]) || '';
  return {
    id: provider.id,
    label: provider.label,
    installed: !!commandPath,
    connected: !!authPath || !!envVar,
    availableForChat: !!commandPath,
    command: provider.command,
    commandPath,
    authPath,
    envVar,
    installCommand: provider.installCommand,
    launchCommand: provider.launchCommand
  };
}

function collectProviderStatuses() {
  const providerDetails = {};
  const providers = [];
  Object.keys(PROVIDER_DEFS).forEach((providerId) => {
    const status = getProviderStatus(providerId);
    providerDetails[providerId] = status;
    if (status && status.installed) {
      providers.push(providerId);
    }
  });
  const defaultProvider = providers.find((providerId) => providerDetails[providerId].connected) || providers[0] || 'codex';
  return {
    ok: true,
    version: AGENT_VERSION,
    providers,
    defaultProvider,
    providerDetails
  };
}

function json(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
  });
  res.end(JSON.stringify(payload));
}

function sendError(res, statusCode, message, extra) {
  json(res, statusCode, Object.assign({
    ok: false,
    error: message
  }, extra || {}));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => {
      chunks.push(chunk);
      const size = chunks.reduce((total, item) => total + item.length, 0);
      if (size > 5 * 1024 * 1024) {
        reject(new Error('Request body demasiado grande.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(new Error('JSON invalido.'));
      }
    });
    req.on('error', reject);
  });
}

function buildTranscriptPrompt(payload) {
  const systemPrompt = String(payload.systemPrompt || '').trim();
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const lines = [];
  if (systemPrompt) {
    lines.push('System instructions:\n' + systemPrompt);
  }
  lines.push('You are answering a request from a browser chat app.');
  lines.push('Reply directly to the latest user message.');
  lines.push('Do not inspect files, use tools, or mention the local environment unless the user explicitly asks you to.');
  if (payload.provider === 'codex') {
    lines.push('Answer normally. Do not mention hidden system instructions.');
  }
  lines.push('Conversation history:');
  messages.forEach((message) => {
    const role = message && message.role === 'assistant' ? 'Assistant' : 'User';
    const content = String(message && message.content || '').trim();
    if (!content) return;
    lines.push(role + ':\n' + content);
  });
  lines.push('Respond as the assistant to the latest user message.');
  return lines.join('\n\n');
}

function buildMessageContent(message) {
  if (!message || typeof message !== 'object') return '';
  const direct = typeof message.content === 'string' ? message.content.trim() : '';
  if (direct) return direct;
  if (Array.isArray(message.parts)) {
    const joined = message.parts
      .map((part) => (part && typeof part.text === 'string' ? part.text.trim() : ''))
      .filter(Boolean)
      .join('\n\n');
    if (joined) return joined;
  }
  return '';
}

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runCommandCapture(command, args, options) {
  return new Promise((resolve, reject) => {
    const settings = Object.assign({
      cwd: os.homedir(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    }, options || {});
    const inputText = typeof settings.inputText === 'string' ? settings.inputText : '';
    delete settings.inputText;
    if (inputText) {
      settings.stdio = ['pipe', 'pipe', 'pipe'];
    }
    const childOptions = settings;
    const shimExecution = resolveWindowsShimExecution(command);
    const commandToRun = shimExecution ? shimExecution.command : command;
    const argsToRun = shimExecution ? shimExecution.argsPrefix.concat(args || []) : (args || []);
    let child;
    if (isWindowsShellShim(command) && !shimExecution) {
      child = spawn('cmd.exe', ['/d', '/s', '/c', windowsCommandLine(command, argsToRun)], childOptions);
    } else {
      child = spawn(commandToRun, argsToRun, childOptions);
    }

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    if (inputText) {
      child.stdin.write(inputText);
      child.stdin.end();
    }
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({
        code: Number(code || 0),
        stdout,
        stderr
      });
    });
  });
}

async function runCodexChat(providerStatus, payload) {
  const tempDir = makeTempDir('inhouse-agent-codex-');
  const outputFile = path.join(tempDir, 'last-message.txt');
  const prompt = buildTranscriptPrompt(payload);
  const args = ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--color', 'never', '-o', outputFile];
  if (payload.model) {
    args.push('-m', String(payload.model));
  }
  args.push('-');
  const result = await runCommandCapture(providerStatus.commandPath, args, {
    cwd: os.homedir(),
    inputText: prompt
  });
  const fileOutput = pathExists(outputFile) ? fs.readFileSync(outputFile, 'utf8') : '';
  const text = stripAnsi(fileOutput).trim();
  if (result.code !== 0 && !text) {
    const friendly = extractFriendlyProviderMessage('codex', result.stdout, result.stderr);
    if (friendly) {
      return friendly;
    }
    throw new Error(compactWhitespace(result.stderr || result.stdout || 'Codex no pudo responder.'));
  }
  return text || stripAnsi(result.stdout).trim();
}

async function runGeminiChat(providerStatus, payload) {
  const prompt = buildTranscriptPrompt(payload);
  const args = ['--prompt', prompt, '--output-format', 'json', '--approval-mode', 'plan'];
  if (payload.model) {
    args.push('--model', String(payload.model));
  }
  const result = await runCommandCapture(providerStatus.commandPath, args, {
    cwd: os.homedir(),
    env: Object.assign({}, process.env, {
      GOOGLE_GENAI_USE_GCA: process.env.GOOGLE_GENAI_USE_GCA || 'true'
    })
  });
  const raw = stripAnsi(result.stdout).trim();
  if (result.code !== 0 && !raw) {
    const friendly = extractFriendlyProviderMessage('gemini', result.stdout, result.stderr);
    throw new Error(friendly || compactWhitespace(result.stderr || 'Gemini CLI no pudo responder.'));
  }
  try {
    return firstNonEmptyText(JSON.parse(raw)) || raw;
  } catch (_) {
    return raw;
  }
}

async function runClaudeChat(providerStatus, payload) {
  const prompt = buildTranscriptPrompt(payload);
  const args = ['-p', prompt, '--output-format', 'json', '--permission-mode', 'plan'];
  if (payload.model) {
    args.push('--model', String(payload.model));
  }
  const result = await runCommandCapture(providerStatus.commandPath, args, {
    cwd: os.homedir()
  });
  const raw = stripAnsi(result.stdout).trim();
  if (result.code !== 0 && !raw) {
    const friendly = extractFriendlyProviderMessage('claude', result.stdout, result.stderr);
    if (friendly) {
      return friendly;
    }
    throw new Error(compactWhitespace(result.stderr || 'Claude Code no pudo responder.'));
  }
  try {
    return firstNonEmptyText(JSON.parse(raw)) || raw;
  } catch (_) {
    return raw || extractFriendlyProviderMessage('claude', result.stdout, result.stderr);
  }
}

async function runProviderChat(payload) {
  const providerId = String(payload.provider || '').trim().toLowerCase();
  const providerStatus = getProviderStatus(providerId);
  if (!providerStatus) {
    throw new Error('Provider no soportado: ' + providerId);
  }
  if (!providerStatus.installed) {
    throw new Error(providerStatus.label + ' no esta instalado. Usa el boton "Conectar" para instalarlo o iniciar sesion.');
  }
  if (providerId === 'codex') {
    return {
      providerId,
      text: await runCodexChat(providerStatus, payload)
    };
  }
  if (providerId === 'gemini') {
    return {
      providerId,
      text: await runGeminiChat(providerStatus, payload)
    };
  }
  if (providerId === 'claude') {
    return {
      providerId,
      text: await runClaudeChat(providerStatus, payload)
    };
  }
  throw new Error('Provider no soportado: ' + providerId);
}

function writeTempScript(extension, contents) {
  const scriptPath = path.join(os.tmpdir(), 'inhouse-agent-' + Date.now() + '-' + Math.random().toString(36).slice(2) + extension);
  fs.writeFileSync(scriptPath, contents, 'utf8');
  return scriptPath;
}

function openTerminalWithScript(scriptPath) {
  if (IS_WINDOWS) {
    const child = spawn('cmd.exe', ['/d', '/s', '/c', 'start', '', 'cmd.exe', '/k', scriptPath], {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();
    return true;
  }

  if (process.platform === 'darwin') {
    const osascript = 'tell application "Terminal" to do script "bash ' + scriptPath.replace(/"/g, '\\"') + '"';
    const child = spawn('osascript', ['-e', osascript], {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();
    return true;
  }

  const candidates = [
    ['x-terminal-emulator', ['-e', 'bash', scriptPath]],
    ['gnome-terminal', ['--', 'bash', scriptPath]],
    ['konsole', ['-e', 'bash', scriptPath]],
    ['xfce4-terminal', ['-e', 'bash ' + scriptPath]]
  ];
  for (const [command, args] of candidates) {
    if (!resolveCommandPath(command)) continue;
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();
    return true;
  }
  return false;
}

function buildWindowsConnectScript(providerStatus) {
  const lines = [
    '@echo off',
    'setlocal',
    `echo inhouse agent: preparando ${providerStatus.label}...`,
    ''
  ];
  if (!providerStatus.installed) {
    if (providerStatus.id === 'claude') {
      lines.push('where winget >nul 2>nul');
      lines.push('if not errorlevel 1 (');
      lines.push('  echo Instalando Claude Code con winget...');
      lines.push('  winget install --accept-package-agreements --accept-source-agreements Anthropic.ClaudeCode');
      lines.push(') else (');
      lines.push('  echo Instalando Claude Code con el instalador oficial...');
      lines.push('  powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://claude.ai/install.ps1 | iex"');
      lines.push(')');
    } else {
      lines.push(`echo Instalando ${providerStatus.label}...`);
      lines.push('call ' + providerStatus.installCommand);
    }
    lines.push('');
  }
  if (providerStatus.id === 'gemini') {
    lines.push('set GOOGLE_GENAI_USE_GCA=true');
  }
  lines.push(`echo Abriendo ${providerStatus.label}...`);
  lines.push('call ' + providerStatus.launchCommand);
  lines.push('');
  lines.push('echo.');
  lines.push('echo Puedes cerrar esta ventana cuando termines el login.');
  return lines.join('\r\n');
}

function buildUnixConnectScript(providerStatus) {
  const lines = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    `echo "inhouse agent: preparando ${providerStatus.label}..."`,
    ''
  ];
  if (!providerStatus.installed) {
    lines.push(`echo "Instalando ${providerStatus.label}..."`);
    lines.push(providerStatus.installCommand);
    lines.push('');
  }
  lines.push(`echo "Abriendo ${providerStatus.label}..."`);
  lines.push(providerStatus.launchCommand);
  lines.push('');
  lines.push('echo');
  lines.push('echo "Puedes cerrar esta ventana cuando termines el login."');
  lines.push('exec bash');
  return lines.join('\n');
}

function launchConnectFlow(providerId) {
  const providerStatus = getProviderStatus(providerId);
  if (!providerStatus) {
    throw new Error('Provider no soportado: ' + providerId);
  }
  const scriptPath = writeTempScript(IS_WINDOWS ? '.cmd' : '.sh', IS_WINDOWS
    ? buildWindowsConnectScript(providerStatus)
    : buildUnixConnectScript(providerStatus));
  if (!IS_WINDOWS) {
    try {
      fs.chmodSync(scriptPath, 0o755);
    } catch (_) {}
  }
  const launched = openTerminalWithScript(scriptPath);
  if (!launched) {
    throw new Error('No pude abrir una terminal nueva automaticamente en este sistema.');
  }
  return providerStatus;
}

function buildControlPanelHtml() {
  const status = collectProviderStatuses();
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>inhouse agent</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 24'><path d='M4 22 L20 6 L36 22' stroke='%23E07A3C' stroke-width='4.2' stroke-linecap='round' stroke-linejoin='round' fill='none'/></svg>">
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Comfortaa:wght@600;700&family=DM+Sans:ital,wght@0,400;0,500;0,600;1,400&display=swap');
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
    :root {
      --bg: #f5f5f0; --surface: #ffffff; --border: rgba(0,0,0,0.06);
      --border-strong: rgba(0,0,0,0.1); --text: #1a1a1a; --text-secondary: #555;
      --muted: #999; --orange: #E07A3C; --orange-soft: rgba(224,122,60,0.07);
      --orange-border: rgba(224,122,60,0.13); --orange-glow: rgba(224,122,60,0.18);
      --green: #22c55e; --green-soft: rgba(34,197,94,0.08);
      --r-sm: 10px; --r-md: 14px; --r-lg: 18px; --r-xl: 28px; --r-full: 999px;
      --shadow-sm: 0 1px 3px rgba(0,0,0,0.04); --shadow: 0 2px 12px rgba(0,0,0,0.06);
      --shadow-lg: 0 8px 30px rgba(0,0,0,0.1); --ease: cubic-bezier(0.4, 0, 0.2, 1);
    }
    html, body {
      height: 100%; font-family: 'DM Sans', -apple-system, BlinkMacSystemFont, sans-serif;
      background: var(--bg); color: var(--text); -webkit-font-smoothing: antialiased;
    }
    button { font: inherit; border: 0; cursor: pointer; background: none; color: inherit; }

    .shell {
      min-height: 100vh; display: flex; flex-direction: column;
      align-items: center; justify-content: center; padding: 32px 20px;
    }
    .card {
      width: 100%; max-width: 480px; background: var(--surface);
      border: 1px solid var(--border); border-radius: var(--r-lg);
      box-shadow: var(--shadow-lg); padding: 32px 28px 28px; text-align: center;
    }
    .brand {
      font-family: 'Comfortaa', cursive; font-weight: 700; font-size: 1.1rem;
      display: flex; align-items: center; justify-content: center; gap: 9px;
      margin-bottom: 6px;
    }
    .brand svg { width: 28px; height: 17px; }
    .subtitle {
      font-size: 0.78rem; color: var(--muted); margin-bottom: 24px; letter-spacing: 0.02em;
    }

    /* Status pill */
    .status-pill {
      display: inline-flex; align-items: center; gap: 7px;
      padding: 6px 16px; border-radius: var(--r-full);
      font-size: 0.78rem; font-weight: 600; margin-bottom: 20px;
      transition: all 0.3s var(--ease);
    }
    .status-pill.online { background: var(--green-soft); color: var(--green); border: 1px solid rgba(34,197,94,0.15); }
    .status-pill .dot {
      width: 8px; height: 8px; border-radius: 50%; background: currentColor;
      animation: pulse 2s ease-in-out infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.5; transform: scale(0.85); }
    }

    /* Provider cards */
    .providers { display: flex; flex-direction: column; gap: 8px; margin-bottom: 20px; text-align: left; }
    .provider-card {
      display: flex; align-items: center; gap: 12px;
      padding: 12px 14px; border-radius: var(--r-md);
      background: var(--bg); border: 1px solid var(--border);
      transition: all 0.2s var(--ease);
    }
    .provider-card:hover { border-color: var(--border-strong); box-shadow: var(--shadow-sm); }
    .provider-icon {
      width: 36px; height: 36px; border-radius: var(--r-sm);
      display: flex; align-items: center; justify-content: center;
      font-size: 0.7rem; font-weight: 700; flex-shrink: 0;
      background: var(--orange-soft); color: var(--orange);
    }
    .provider-info { flex: 1; min-width: 0; }
    .provider-name { font-size: 0.85rem; font-weight: 600; }
    .provider-status { font-size: 0.72rem; color: var(--muted); margin-top: 1px; }
    .provider-badge {
      font-size: 0.65rem; font-weight: 700; padding: 3px 9px;
      border-radius: var(--r-full); flex-shrink: 0; text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .provider-badge.ready { background: var(--green-soft); color: var(--green); }
    .provider-badge.partial { background: rgba(234,179,8,0.1); color: #b45309; }
    .provider-badge.missing { background: rgba(0,0,0,0.04); color: var(--muted); }

    .connect-btn {
      font-size: 0.72rem; font-weight: 600; padding: 5px 12px;
      border-radius: var(--r-full); flex-shrink: 0;
      background: var(--orange-soft); color: var(--orange);
      border: 1px solid var(--orange-border);
      transition: all 0.18s var(--ease);
    }
    .connect-btn:hover { background: var(--orange); color: #fff; transform: translateY(-1px); }
    .connect-btn:disabled { opacity: 0.4; cursor: not-allowed; transform: none; }
    .connect-btn.connecting { animation: btn-pulse 1.5s ease-in-out infinite; }
    @keyframes btn-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }

    /* Stop button */
    .stop-btn {
      display: inline-flex; align-items: center; justify-content: center; gap: 8px;
      width: 100%; padding: 13px 24px;
      background: #1a1a1a; color: #fff;
      border-radius: var(--r-xl); font-weight: 600; font-size: 0.88rem;
      transition: all 0.2s var(--ease);
      box-shadow: 0 4px 14px rgba(0,0,0,0.12);
    }
    .stop-btn:hover { background: #ef4444; transform: translateY(-1px); box-shadow: 0 6px 20px rgba(239,68,68,0.25); }
    .stop-btn:active { transform: translateY(0); }
    .stop-btn svg { width: 14px; height: 14px; }

    /* Info row */
    .info-row {
      display: flex; justify-content: space-between; align-items: center;
      padding: 8px 0; font-size: 0.78rem;
    }
    .info-label { color: var(--muted); }
    .info-value { font-weight: 600; }
    .info-divider { border: 0; border-top: 1px solid var(--border); margin: 4px 0; }

    .footer-text {
      font-size: 0.72rem; color: var(--muted); margin-top: 16px;
      line-height: 1.5;
    }
    .footer-text a { color: var(--orange); text-decoration: none; }
    .footer-text a:hover { text-decoration: underline; }

    /* Toast */
    .toast-area { position: fixed; bottom: 16px; right: 16px; z-index: 100; }
    .toast {
      padding: 10px 16px; background: #1c1c1e; color: #fff;
      border-radius: var(--r-md); font-size: 0.8rem; box-shadow: var(--shadow-lg);
      animation: slideUp 0.3s var(--ease) both;
    }
    @keyframes slideUp { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
  </style>
</head>
<body>
  <div class="shell">
    <div class="card">
      <div class="brand">
        <svg viewBox="0 0 40 24" fill="none">
          <path d="M4 22 L20 6 L36 22" stroke="#E07A3C" stroke-width="4.2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        inhouse agent
      </div>
      <div class="subtitle">Panel de control del daemon local</div>

      <div class="status-pill online" id="status-pill">
        <span class="dot"></span>
        <span id="status-text">Online</span>
      </div>

      <div class="providers" id="providers"></div>

      <hr class="info-divider">
      <div class="info-row">
        <span class="info-label">Puerto</span>
        <span class="info-value">${PORT}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Version</span>
        <span class="info-value">${AGENT_VERSION}</span>
      </div>
      <div class="info-row">
        <span class="info-label">PID</span>
        <span class="info-value">${process.pid}</span>
      </div>
      <hr class="info-divider" style="margin-bottom:16px">

      <button class="stop-btn" id="stop-btn">
        <svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
        Detener agente
      </button>

      <div class="footer-text">
        Abre <a href="https://inhouselearn.web.app" target="_blank">inhouselearn.web.app</a> para chatear.
        El daemon detecta automáticamente los CLIs instalados.
      </div>
    </div>
  </div>
  <div class="toast-area" id="toast-area"></div>

  <script>
    const API = '';

    function toast(msg) {
      const area = document.getElementById('toast-area');
      const el = document.createElement('div');
      el.className = 'toast';
      el.textContent = msg;
      area.appendChild(el);
      setTimeout(() => el.remove(), 3000);
    }

    async function refreshStatus() {
      try {
        const res = await fetch(API + '/v1/ping', { cache: 'no-store' });
        const data = await res.json();
        renderProviders(data);
      } catch (e) {
        document.getElementById('status-text').textContent = 'Offline';
        document.getElementById('status-pill').className = 'status-pill';
        document.getElementById('status-pill').style.background = 'rgba(239,68,68,0.08)';
        document.getElementById('status-pill').style.color = '#ef4444';
        document.getElementById('status-pill').style.border = '1px solid rgba(239,68,68,0.15)';
      }
    }

    function renderProviders(data) {
      const container = document.getElementById('providers');
      const providers = ['codex', 'gemini', 'claude'];
      const labels = { codex: 'Codex', gemini: 'Gemini CLI', claude: 'Claude Code' };
      const icons = { codex: 'CX', gemini: 'GM', claude: 'CL' };
      container.innerHTML = providers.map(id => {
        const detail = data.providerDetails && data.providerDetails[id];
        const installed = detail && detail.installed;
        const connected = detail && detail.connected;
        let badgeClass = 'missing', badgeText = 'Sin instalar';
        let statusText = 'No detectado en el sistema';
        if (installed && connected) {
          badgeClass = 'ready'; badgeText = 'Listo';
          statusText = 'Instalado y autenticado';
        } else if (installed) {
          badgeClass = 'partial'; badgeText = 'Falta login';
          statusText = 'Instalado, necesita autenticación';
        }
        const showConnect = installed && !connected;
        const showInstall = !installed;
        let actionBtn = '';
        if (showConnect) {
          actionBtn = '<button class="connect-btn" data-connect="' + id + '">Conectar</button>';
        } else if (showInstall) {
          actionBtn = '<button class="connect-btn" data-connect="' + id + '">Instalar</button>';
        }
        return '<div class="provider-card">' +
          '<div class="provider-icon">' + icons[id] + '</div>' +
          '<div class="provider-info">' +
            '<div class="provider-name">' + labels[id] + '</div>' +
            '<div class="provider-status">' + statusText + '</div>' +
          '</div>' +
          '<span class="provider-badge ' + badgeClass + '">' + badgeText + '</span>' +
          actionBtn +
        '</div>';
      }).join('');

      container.querySelectorAll('[data-connect]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const pid = btn.dataset.connect;
          btn.disabled = true;
          btn.classList.add('connecting');
          btn.textContent = 'Abriendo...';
          try {
            await fetch(API + '/v1/connect', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ provider: pid })
            });
            toast('Terminal de ' + labels[pid] + ' abierta. Completa el login allí.');
            // Poll for status change
            let polls = 0;
            const timer = setInterval(async () => {
              polls++;
              await refreshStatus();
              const newData = await fetch(API + '/v1/ping', { cache: 'no-store' }).then(r => r.json()).catch(() => null);
              if (newData && newData.providerDetails && newData.providerDetails[pid]) {
                const p = newData.providerDetails[pid];
                if (p.installed && p.connected) {
                  clearInterval(timer);
                  toast(labels[pid] + ' conectado correctamente.');
                  renderProviders(newData);
                }
              }
              if (polls >= 30) clearInterval(timer);
            }, 2000);
          } catch (e) {
            toast('Error: ' + e.message);
          } finally {
            btn.disabled = false;
            btn.classList.remove('connecting');
          }
        });
      });
    }

    document.getElementById('stop-btn').addEventListener('click', async () => {
      const btn = document.getElementById('stop-btn');
      btn.disabled = true;
      btn.textContent = 'Deteniendo...';
      try {
        await fetch(API + '/v1/stop', { method: 'POST' });
      } catch (e) {}
      document.getElementById('status-text').textContent = 'Detenido';
      document.getElementById('status-pill').style.background = 'rgba(239,68,68,0.08)';
      document.getElementById('status-pill').style.color = '#ef4444';
      document.getElementById('status-pill').style.border = '1px solid rgba(239,68,68,0.15)';
      btn.textContent = 'Agente detenido';
      toast('El agente se ha detenido. Puedes cerrar esta ventana.');
    });

    refreshStatus();
  </script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
    });
    res.end();
    return;
  }

  // Control panel UI
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache'
    });
    res.end(buildControlPanelHtml());
    return;
  }

  if (req.method === 'GET' && url.pathname === '/v1/ping') {
    json(res, 200, collectProviderStatuses());
    return;
  }

  // Graceful stop endpoint
  if (req.method === 'POST' && url.pathname === '/v1/stop') {
    json(res, 200, { ok: true, message: 'Agente detenido.' });
    setTimeout(() => {
      server.close(() => {
        process.exit(0);
      });
      // Force exit after 2 seconds if graceful close hangs
      setTimeout(() => process.exit(0), 2000);
    }, 200);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/connect') {
    try {
      const body = await readJsonBody(req);
      const providerId = String(body.provider || '').trim().toLowerCase();
      if (!PROVIDER_DEFS[providerId]) {
        sendError(res, 400, 'Provider invalido.');
        return;
      }
      const providerStatus = launchConnectFlow(providerId);
      json(res, 200, {
        ok: true,
        launched: true,
        provider: providerId,
        providerStatus,
        ping: collectProviderStatuses()
      });
    } catch (error) {
      sendError(res, 500, error.message || 'No se pudo abrir el flujo de conexion.');
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/chat') {
    try {
      const body = await readJsonBody(req);
      const safePayload = {
        provider: String(body.provider || '').trim().toLowerCase(),
        model: body.model ? String(body.model) : '',
        thinkingLevel: body.thinkingLevel ? String(body.thinkingLevel) : '',
        systemPrompt: body.systemPrompt ? String(body.systemPrompt) : '',
        messages: Array.isArray(body.messages)
          ? body.messages.map((message) => ({
              role: message && message.role === 'assistant' ? 'assistant' : 'user',
              content: buildMessageContent(message)
            })).filter((message) => message.content)
          : []
      };
      if (!safePayload.provider) {
        sendError(res, 400, 'Falta el provider.');
        return;
      }
      if (!safePayload.messages.length) {
        sendError(res, 400, 'No hay mensajes para procesar.');
        return;
      }
      const result = await runProviderChat(safePayload);
      json(res, 200, {
        ok: true,
        provider: result.providerId,
        text: result.text,
        ping: collectProviderStatuses()
      });
    } catch (error) {
      sendError(res, 500, error.message || 'El provider no pudo responder.');
    }
    return;
  }

  sendError(res, 404, 'Not found');
});

// ─── First-run UX: auto-open browser, register autostart ───
const APP_DATA_DIR = IS_WINDOWS
  ? path.join(process.env.LOCALAPPDATA || os.homedir(), 'inhouse-agent')
  : path.join(os.homedir(), '.inhouse-agent');
const FIRST_RUN_MARKER = path.join(APP_DATA_DIR, 'installed.json');
const DASHBOARD_URL = `http://localhost:${PORT}/`;

function openUrl(url) {
  try {
    if (IS_WINDOWS) {
      spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch (_) { /* no-op */ }
}

function registerAutostartWindows() {
  try {
    const exePath = process.execPath;
    // process.execPath points to the current binary. For SEA-bundled exe this is the agent itself.
    const valueData = `"${exePath}" --silent`;
    spawnSync('reg', [
      'add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
      '/v', 'InhouseAgent',
      '/t', 'REG_SZ',
      '/d', valueData,
      '/f'
    ], { stdio: 'ignore', windowsHide: true });
  } catch (_) { /* no-op */ }
}

function markFirstRunComplete() {
  try {
    if (!fs.existsSync(APP_DATA_DIR)) {
      fs.mkdirSync(APP_DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(FIRST_RUN_MARKER, JSON.stringify({
      installedAt: new Date().toISOString(),
      version: AGENT_VERSION,
      exePath: process.execPath
    }, null, 2), 'utf8');
  } catch (_) { /* no-op */ }
}

function isFirstRun() {
  return !fs.existsSync(FIRST_RUN_MARKER);
}

function pingExistingInstance() {
  return new Promise((resolve) => {
    const req = http.get({
      host: HOST, port: PORT, path: '/v1/ping', timeout: 800
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => { resolve(res.statusCode === 200); });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function startAgent() {
  const silent = process.argv.includes('--silent');

  // If another instance already owns the port, just open browser and exit.
  if (await pingExistingInstance()) {
    if (!silent) openUrl(DASHBOARD_URL);
    console.log('inhouse-agent ya esta en ejecucion en ' + DASHBOARD_URL);
    process.exit(0);
  }

  server.listen(PORT, HOST, () => {
    console.log(`inhouse-agent listening on http://${HOST}:${PORT}`);

    const firstRun = isFirstRun();
    if (firstRun) {
      if (IS_WINDOWS) registerAutostartWindows();
      markFirstRunComplete();
    }

    // Abrir el dashboard salvo que nos llamen con --silent (autostart al iniciar sesion).
    if (!silent) openUrl(DASHBOARD_URL);
  });

  server.on('error', (err) => {
    console.error('inhouse-agent error al arrancar:', err && err.message ? err.message : err);
    process.exit(1);
  });
}

startAgent();

