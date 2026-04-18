#!/usr/bin/env node
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  startProxy,
  stopProxy,
  resumeProxy,
  proxyStatus,
  proxyLogs,
  startServer,
  installDaemon,
  uninstallProxy,
  writeProxyConfig,
  PROXY_PORT,
  type ProxyMode,
} from './proxy.js';

function printVersion(): void {
  for (const candidate of [join(__dirname, '..', 'package.json'), join(__dirname, 'package.json')]) {
    try {
      const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as { version?: string };
      if (pkg.version) { console.log(`ergosum-proxy ${pkg.version}`); return; }
    } catch { /* try next */ }
  }
  console.log('ergosum-proxy (version unknown)');
}

interface ParsedArgs {
  action?: string;
  port?: number;
  window?: number;
  mode?: ProxyMode;
  verbose: boolean;
  foreground: boolean;
  persistent: boolean;
  oauthBridge: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    verbose: false,
    foreground: false,
    persistent: false,
    oauthBridge: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--port':
      case '-p':
        out.port = parseInt(argv[++i] ?? '', 10);
        break;
      case '--window':
      case '-w':
        out.window = parseInt(argv[++i] ?? '', 10);
        break;
      case '--mode':
      case '-m': {
        const v = argv[++i];
        if (v !== 'inject' && v !== 'smart') {
          console.error(`Invalid mode "${v}". Choose: inject | smart`);
          process.exit(1);
        }
        out.mode = v;
        break;
      }
      case '--verbose':
      case '-v':
        out.verbose = true;
        break;
      case '--foreground':
        out.foreground = true;
        break;
      case '--persistent':
        out.persistent = true;
        break;
      case '--oauth-bridge':
        out.oauthBridge = true;
        break;
      case '--help':
      case '-h':
        out.help = true;
        break;
      case '--version':
      case '-V':
        out.action = 'version';
        break;
      default:
        if (arg?.startsWith('-')) {
          console.error(`Unknown flag: ${arg}`);
          process.exit(1);
        }
        if (!out.action) out.action = arg;
    }
  }
  return out;
}

function printHelp(): void {
  const help = `
ergosum-proxy — local proxy for Claude Code / Anthropic API

USAGE
  ergosum-proxy [action] [options]

ACTIONS
  (none)       Start in background (trimming on)
  stop         Pause trimming — proxy stays up so Claude Code stays connected
  resume       Resume trimming
  status       Show running state
  logs         Tail live proxy logs (Ctrl+C to exit)
  install      Install as macOS LaunchAgent (survives reboots)
  uninstall    Kill proxy + clear ANTHROPIC_BASE_URL (restart Claude after)
  version      Print proxy version and exit

OPTIONS
  -p, --port <n>         Port (default ${PROXY_PORT})
  -w, --window <tokens>  Token window — trim above this (default 100000)
  -m, --mode <mode>      Proxy mode: inject | smart
  -v, --verbose          Log every intercepted call
      --foreground       Run in foreground (internal — used by background spawn)
      --persistent       Do not clear ANTHROPIC_BASE_URL on shutdown (used by LaunchAgent)
      --oauth-bridge     Swap x-api-key with Claude Code OAuth token from macOS Keychain
  -V, --version          Print version and exit
  -h, --help             Show this help

ENV
  ERGOSUM_URL            Base URL for ErgoSum server (default https://ergosum.cc)
  ERGOSUM_TOKEN          Auth token (otherwise read from local 'conf' storage)

DOCS
  https://github.com/TwoErgoSum/Ergosum-Proxy
`.trim();
  console.log(help);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    return;
  }

  const port = args.port ?? PROXY_PORT;
  const window = args.window ?? 100_000;

  if (args.mode) {
    writeProxyConfig({ mode: args.mode });
    console.log(`Proxy mode set to: ${args.mode}`);
    if (!args.action && !args.foreground) return;
  }
  if (args.oauthBridge) {
    writeProxyConfig({ oauthBridge: true });
    console.log('OAuth bridge: enabled (persisted to config)');
  }

  switch (args.action) {
    case 'stop':
      stopProxy();
      return;
    case 'resume':
      resumeProxy();
      return;
    case 'status':
      proxyStatus();
      return;
    case 'logs':
      proxyLogs();
      return;
    case 'install':
      installDaemon(port, window);
      return;
    case 'uninstall':
      uninstallProxy();
      return;
    case 'version':
      printVersion();
      return;
    case undefined:
      if (args.foreground) {
        startServer({
          port,
          window,
          verbose: args.verbose,
          oauthBridge: args.oauthBridge,
          persistent: args.persistent,
        });
      } else {
        startProxy({ port, window, oauthBridge: args.oauthBridge });
      }
      return;
    default:
      console.error(`Unknown action: ${args.action}`);
      printHelp();
      process.exit(1);
  }
}

main();
