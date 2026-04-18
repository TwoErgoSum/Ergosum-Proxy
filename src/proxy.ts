import * as http from 'http';
import * as https from 'https';
import { spawn, execSync, execFileSync } from 'child_process';
import { openSync, readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import type { IncomingMessage, ServerResponse } from 'http';
import { getToken, getBaseUrl } from './config.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const ANTHROPIC_HOST = 'api.anthropic.com';
// High port — avoids conflicts with common dev servers
export const PROXY_PORT = 49200;
const DEFAULT_WINDOW_TOKENS = 200_000;

const PID_FILE = join(homedir(), '.config', 'ergosum', 'proxy.pid');
const PAUSE_FILE = join(homedir(), '.config', 'ergosum', 'proxy-paused');
const PROXY_CONFIG_FILE = join(homedir(), '.config', 'ergosum', 'proxy.json');
const LOG_FILE = '/tmp/ergosum-proxy.log';
const CLAUDE_SETTINGS = join(homedir(), '.claude', 'settings.json');

// ── Proxy mode config ─────────────────────────────────────────────────────────

export type ProxyMode = 'inject' | 'smart';

export interface ProxyConfig {
  mode: ProxyMode;
  windowTokens?: number;
  oauthBridge?: boolean;
}

export function readProxyConfig(): ProxyConfig {
  if (existsSync(PROXY_CONFIG_FILE)) {
    try { return JSON.parse(readFileSync(PROXY_CONFIG_FILE, 'utf8')) as ProxyConfig; }
    catch { /* fall through */ }
  }
  return { mode: 'inject' };
}

export function writeProxyConfig(config: Partial<ProxyConfig>): void {
  const current = readProxyConfig();
  const merged = { ...current, ...config };
  const dir = dirname(PROXY_CONFIG_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(PROXY_CONFIG_FILE, JSON.stringify(merged, null, 2), 'utf8');
}

// ── OAuth bridge: read Claude Code's token from macOS Keychain ───────────────
// Only affects x-api-key (Anthropic auth). Other providers (OpenAI, Codex, etc.)
// use Authorization: Bearer headers which are never touched.

let _oauthTokenCache: string | null = null;
let _oauthTokenCachedAt = 0;
const OAUTH_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function getClaudeOAuthToken(): string | null {
  const now = Date.now();
  if (_oauthTokenCache && now - _oauthTokenCachedAt < OAUTH_CACHE_TTL_MS) {
    return _oauthTokenCache;
  }
  try {
    const raw = execSync('security find-generic-password -s "Claude Code-credentials" -w', {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const creds = JSON.parse(raw);
    const token = creds?.claudeAiOauth?.accessToken;
    if (typeof token === 'string' && token.length > 0) {
      _oauthTokenCache = token;
      _oauthTokenCachedAt = now;
      return token;
    }
    return null;
  } catch {
    return null;
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  content?: string | ContentBlock[];
  tool_use_id?: string;
  [key: string]: unknown;
}

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

interface MessagesRequest {
  model?: string;
  messages: AnthropicMessage[];
  system?: unknown;
  max_tokens?: number;
  stream?: boolean;
  [key: string]: unknown;
}

// ── System fragment cache ─────────────────────────────────────────────────────
// Fetched from server at startup so the tagging schema never lives in the binary.

let _systemFragmentCache: string | null = null;
let _systemFragmentFetchedAt = 0;
const FRAGMENT_TTL_MS = 60 * 60 * 1000; // 1 hour

async function getSystemFragment(baseUrl: string, token: string): Promise<string> {
  const now = Date.now();
  if (_systemFragmentCache && now - _systemFragmentFetchedAt < FRAGMENT_TTL_MS) {
    return _systemFragmentCache;
  }
  return new Promise(resolve => {
    const url = new URL(`${baseUrl}/api/cli/proxy/system-fragment`);
    const isHttps = url.protocol === 'https:';
    const mod: typeof http | typeof https = isHttps ? https : http;
    const reqObj = mod.request({
      hostname: url.hostname,
      port: url.port ? parseInt(url.port, 10) : (isHttps ? 443 : 80),
      path: url.pathname,
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
    }, res => {
      let data = '';
      res.on('data', (c: Buffer) => { data += c.toString('utf8'); });
      res.on('end', () => {
        if (res.statusCode === 200 && data) {
          _systemFragmentCache = data;
          _systemFragmentFetchedAt = Date.now();
          resolve(data);
        } else {
          resolve(_systemFragmentCache ?? '');
        }
      });
      res.on('error', () => resolve(_systemFragmentCache ?? ''));
    });
    const timer = setTimeout(() => { reqObj.destroy(); resolve(_systemFragmentCache ?? ''); }, 3000);
    reqObj.on('error', () => { clearTimeout(timer); resolve(_systemFragmentCache ?? ''); });
    reqObj.on('close', () => clearTimeout(timer));
    reqObj.end();
  });
}

function hasThinkingState(req: MessagesRequest): boolean {
  const thinking = req.thinking;
  if (thinking !== undefined) {
    if (typeof thinking === 'object' && thinking !== null) {
      const obj = thinking as Record<string, unknown>;
      if (obj.type === 'enabled') return true;
      if (typeof obj.budget_tokens === 'number' && obj.budget_tokens > 0) return true;
    }
    return true;
  }

  for (const msg of req.messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content as ContentBlock[]) {
      if (block.type === 'thinking' || block.type === 'redacted_thinking') return true;
    }
  }
  return false;
}

function appendSystemText(existing: unknown, text: string): unknown {
  if (typeof existing === 'string') {
    return existing ? `${existing}\n\n---\n\n${text}` : text;
  }
  if (Array.isArray(existing)) {
    const blocks = existing as ContentBlock[];
    const prefix = blocks.length > 0 ? '\n\n---\n\n' : '';
    return [...blocks, { type: 'text', text: `${prefix}${text}` }];
  }
  return text;
}

// ── Settings helpers ──────────────────────────────────────────────────────────

function updateSettings(fn: (s: Record<string, unknown>) => void): void {
  let settings: Record<string, unknown> = {};
  if (existsSync(CLAUDE_SETTINGS)) {
    try { settings = JSON.parse(readFileSync(CLAUDE_SETTINGS, 'utf8')) as Record<string, unknown>; }
    catch { settings = {}; }
  }
  fn(settings);
  const dir = dirname(CLAUDE_SETTINGS);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2) + '\n', 'utf8');
}

function setAnthropicBaseUrl(port: number): void {
  updateSettings(s => {
    const env = (s.env as Record<string, string> | undefined) ?? {};
    env['ANTHROPIC_BASE_URL'] = `http://localhost:${port}`;
    s.env = env;
  });
}

function removeAnthropicBaseUrl(): void {
  if (!existsSync(CLAUDE_SETTINGS)) return;
  updateSettings(s => {
    const env = s.env as Record<string, string> | undefined;
    if (!env) return;
    delete env['ANTHROPIC_BASE_URL'];
    if (Object.keys(env).length === 0) delete s.env;
  });
}

function removeCodexBaseUrl(): void {
  const configPath = join(homedir(), '.codex', 'config.toml');
  if (!existsSync(configPath)) return;
  try {
    const content = readFileSync(configPath, 'utf8');
    const updated = content.split('\n')
      .filter(line => !/^openai_base_url\s*=\s*"http:\/\/localhost/.test(line))
      .join('\n');
    if (updated !== content) writeFileSync(configPath, updated, 'utf8');
  } catch { /* ignore */ }
}

// ── PID file ──────────────────────────────────────────────────────────────────

function writePid(pid: number): void {
  const dir = dirname(PID_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(PID_FILE, String(pid), 'utf8');
}

function readPid(): number | null {
  if (!existsSync(PID_FILE)) return null;
  const raw = readFileSync(PID_FILE, 'utf8').trim();
  const pid = parseInt(raw, 10);
  return isNaN(pid) ? null : pid;
}

function isRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

// ── Token estimation ──────────────────────────────────────────────────────────

function estimateTokens(obj: unknown): number {
  return Math.ceil(JSON.stringify(obj).length / 4);
}

// ── HTTP proxying ─────────────────────────────────────────────────────────────

function buildForwardHeaders(incoming: IncomingMessage, bodyLength: number, oauthToken?: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, val] of Object.entries(incoming.headers)) {
    if (!val) continue;
    const k = key.toLowerCase();
    if (['host', 'connection', 'transfer-encoding', 'content-length'].includes(k)) continue;
    if (oauthToken && k === 'x-api-key') continue;
    headers[k] = Array.isArray(val) ? val.join(', ') : val;
  }
  if (oauthToken) {
    headers['x-api-key'] = oauthToken;
  }
  headers['host'] = ANTHROPIC_HOST;
  headers['content-length'] = String(bodyLength);
  return headers;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Patch a single SSE line: replace input_tokens in message_start events
// so Claude Code's context counter reflects the trimmed count, not the original.
function patchSseLine(line: string, trimmedTokens: number): string {
  if (!line.startsWith('data: ')) return line;
  try {
    const json = JSON.parse(line.slice(6)) as Record<string, unknown>;
    if (json.type === 'message_start') {
      const msg = json.message as Record<string, unknown> | undefined;
      const usage = msg?.usage as Record<string, unknown> | undefined;
      if (usage && typeof usage.input_tokens === 'number') {
        usage.input_tokens = trimmedTokens;
        return 'data: ' + JSON.stringify(json);
      }
    }
  } catch { /* not JSON, pass through */ }
  return line;
}

async function forwardRequest(
  method: string,
  path: string,
  headers: Record<string, string>,
  body: Buffer,
  res: ServerResponse,
  trimmedTokens?: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const upstream = https.request(
      { hostname: ANTHROPIC_HOST, port: 443, path, method, headers },
      upstreamRes => {
        const isStream = (upstreamRes.headers['content-type'] ?? '').includes('text/event-stream');

        res.writeHead(upstreamRes.statusCode ?? 200, upstreamRes.headers as Record<string, string>);

        if (!isStream || trimmedTokens === undefined) {
          upstreamRes.pipe(res);
          upstreamRes.on('end', resolve);
          upstreamRes.on('error', reject);
          return;
        }

        let buf = '';
        upstreamRes.on('data', (chunk: Buffer) => {
          buf += chunk.toString('utf8');
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';
          for (const line of lines) {
            res.write(patchSseLine(line, trimmedTokens) + '\n');
          }
        });
        upstreamRes.on('end', () => {
          if (buf) res.write(patchSseLine(buf, trimmedTokens) + '\n');
          res.end();
          resolve();
        });
        upstreamRes.on('error', reject);
      },
    );
    upstream.on('error', reject);
    upstream.write(body);
    upstream.end();
  });
}

// ── Stable session ID (daily, unique per proxy process) ───────────────────────
const PROXY_SESSION_ID = `proxy-${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 8)}`;

function extractQueryContext(messages: AnthropicMessage[]): string {
  const texts: string[] = [];
  for (let i = messages.length - 1; i >= 0 && texts.length < 3; i--) {
    const msg = messages[i];
    if (msg.role !== 'user') continue;
    if (typeof msg.content === 'string') {
      if (msg.content.trim()) texts.push(msg.content.slice(0, 300));
    } else {
      const blocks = msg.content as ContentBlock[];
      const textBlocks = blocks.filter(b => b.type === 'text' && b.text);
      if (textBlocks.length === 0) continue;
      const combined = textBlocks.map(b => b.text as string).join(' ');
      if (combined.trim()) texts.push(combined.slice(0, 300));
    }
  }
  return texts.reverse().join(' ... ').slice(0, 800);
}

function ergoRawPost(
  baseUrl: string,
  path: string,
  token: string,
  body: unknown,
  timeoutMs: number,
): Promise<{ status: number; text: string } | null> {
  return new Promise(resolve => {
    const bodyBuf = Buffer.from(JSON.stringify(body), 'utf8');
    let url: URL;
    try { url = new URL(path, baseUrl); }
    catch { resolve(null); return; }
    const isHttps = url.protocol === 'https:';
    const mod: typeof http | typeof https = isHttps ? https : http;
    const req = mod.request(
      {
        hostname: url.hostname,
        port: url.port ? parseInt(url.port, 10) : (isHttps ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers: {
          'authorization': `Bearer ${token}`,
          'content-type': 'application/json',
          'content-length': String(bodyBuf.length),
        },
      },
      res => {
        let data = '';
        res.on('data', (c: Buffer) => { data += c.toString('utf8'); });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: data }));
        res.on('error', () => resolve(null));
      },
    );
    const timer = setTimeout(() => { req.destroy(); resolve(null); }, timeoutMs);
    req.on('error', () => { clearTimeout(timer); resolve(null); });
    req.on('close', () => clearTimeout(timer));
    req.end(bodyBuf);
  });
}

interface PrepareResult {
  messages: AnthropicMessage[];
  system_fragment: string;
  trimmed_count: number;
  retrieved_sections: number;
}

async function fetchPrepare(
  baseUrl: string,
  token: string,
  messages: AnthropicMessage[],
  windowTokens: number,
  queryContext: string,
): Promise<PrepareResult | null> {
  const result = await ergoRawPost(baseUrl, '/api/cli/proxy/prepare', token, {
    messages,
    window_tokens: windowTokens,
    last_user_text: queryContext.slice(0, 800),
    session_id: PROXY_SESSION_ID,
  }, 800);
  if (!result || result.status < 200 || result.status >= 300) return null;
  try {
    return JSON.parse(result.text) as PrepareResult;
  } catch { return null; }
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  windowTokens: number,
  verbose: boolean,
  oauthBridge: boolean = false,
): Promise<void> {
  const path = req.url ?? '/';
  const method = req.method ?? 'GET';
  if (verbose) process.stderr.write(`[ergosum proxy] incoming: ${method} ${path}\n`);

  const oauthToken = oauthBridge ? getClaudeOAuthToken() : undefined;
  if (oauthBridge && !oauthToken) {
    if (verbose) process.stderr.write('[ergosum proxy] OAuth bridge: could not read token from keychain — passing through as-is\n');
  }
  if (oauthBridge && oauthToken && verbose) {
    process.stderr.write('[ergosum proxy] OAuth bridge: swapped x-api-key with Claude Code OAuth token\n');
  }
  try {
    const rawBody = await readBody(req);

    const anthropicVersion = req.headers['anthropic-version'];
    if (!anthropicVersion) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Missing anthropic-version header' }));
      if (verbose) process.stderr.write('[ergosum proxy] rejected: missing anthropic-version header\n');
      return;
    }

    const pathBase = path.split('?')[0];
    const isMessages = method === 'POST' && pathBase === '/v1/messages';
    const isCountTokens = method === 'POST' && pathBase === '/v1/messages/count_tokens';

    const ALLOWED_PATH_PREFIXES = ['/v1/'];
    const pathAllowed = ALLOWED_PATH_PREFIXES.some(p => pathBase.startsWith(p));
    if (!pathAllowed) {
      res.writeHead(403);
      res.end(JSON.stringify({ error: 'Forbidden path' }));
      if (verbose) process.stderr.write(`[ergosum proxy] rejected path: ${pathBase}\n`);
      return;
    }

    if (!isMessages && !isCountTokens) {
      await forwardRequest(method, path, buildForwardHeaders(req, rawBody.length, oauthToken ?? undefined), rawBody, res);
      return;
    }

    let parsed: MessagesRequest;
    try { parsed = JSON.parse(rawBody.toString('utf8')) as MessagesRequest; }
    catch {
      await forwardRequest(method, path, buildForwardHeaders(req, rawBody.length, oauthToken ?? undefined), rawBody, res);
      return;
    }

    const paused = existsSync(PAUSE_FILE);

    if (verbose) {
      const label = isCountTokens ? '/v1/messages/count_tokens' : '/v1/messages';
      process.stderr.write(`[ergosum proxy] ${label} — ${parsed.messages.length} msgs, ~${(estimateTokens(parsed.messages) / 1000).toFixed(0)}k tokens [${paused ? 'paused' : 'active'}]\n`);
    }

    let finalMessages = parsed.messages;
    let systemFragment: string | undefined;

    const shouldPrepare = !paused && isMessages && !hasThinkingState(parsed);

    if (shouldPrepare) {
      const token = getToken();
      const baseUrl = token ? getBaseUrl() : null;

      if (token && baseUrl) {
        const queryContext = extractQueryContext(parsed.messages);
        const prepared = await fetchPrepare(baseUrl, token, parsed.messages, windowTokens, queryContext);
        if (prepared) {
          finalMessages = prepared.messages as AnthropicMessage[];
          systemFragment = prepared.system_fragment;
          if (verbose) {
            process.stderr.write(`[ergosum proxy] prepare: trimmed ${prepared.trimmed_count}, retrieved ${prepared.retrieved_sections} sections\n`);
          }
        } else {
          if (verbose) process.stderr.write('[ergosum proxy] prepare failed — passing through untrimmed\n');
        }
      } else {
        if (verbose) process.stderr.write('[ergosum proxy] not authenticated — passing through untrimmed\n');
      }
    }

    let bodyToSend: Buffer;
    if (finalMessages !== parsed.messages || systemFragment !== undefined) {
      const outgoing: MessagesRequest = { ...parsed, messages: finalMessages };
      if (systemFragment) {
        outgoing.system = appendSystemText(outgoing.system, systemFragment);
      }
      bodyToSend = Buffer.from(JSON.stringify(outgoing), 'utf8');
    } else {
      bodyToSend = rawBody;
    }

    const trimmedTokens = isMessages ? estimateTokens(finalMessages) : undefined;
    await forwardRequest(method, path, buildForwardHeaders(req, bodyToSend.length, oauthToken ?? undefined), bodyToSend, res, trimmedTokens);
  } catch (err) {
    if (!res.headersSent) { res.writeHead(502); res.end(JSON.stringify({ error: String(err) })); }
    if (verbose) process.stderr.write(`[ergosum proxy] error: ${err}\n`);
  }
}

// ── Start the HTTP server (foreground) ────────────────────────────────────────

export function startServer(options: { port: number; window: number; verbose: boolean; oauthBridge?: boolean; persistent?: boolean }): void {
  const { port, window: windowTokens, verbose } = options;
  const oauthBridge = options.oauthBridge ?? readProxyConfig().oauthBridge ?? false;
  const persistent = options.persistent ?? false;

  const server = http.createServer((req, res) => {
    handleRequest(req, res, windowTokens, verbose, oauthBridge).catch(err => {
      process.stderr.write(`[ergosum proxy] unhandled: ${err}\n`);
    });
  });

  const gracefulShutdown = () => {
    process.stderr.write('[ergosum proxy] shutting down gracefully...\n');
    if (!persistent) {
      removeAnthropicBaseUrl();
      process.stderr.write('[ergosum proxy] ANTHROPIC_BASE_URL cleared.\n');
    }
    server.close(() => {
      process.stderr.write('[ergosum proxy] stopped.\n');
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGTERM', gracefulShutdown);
  process.on('SIGINT', gracefulShutdown);

  server.listen(port, () => {
    process.stderr.write(`[ergosum proxy] listening on :${port} window=${(windowTokens / 1000).toFixed(0)}k\n`);
    if (oauthBridge) {
      process.stderr.write('[ergosum proxy] OAuth bridge: ON — x-api-key will be swapped with Claude Code OAuth token\n');
    }
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    process.stderr.write(`[ergosum proxy] ${err.code === 'EADDRINUSE' ? `port ${port} already in use` : err.message}\n`);
    process.exit(1);
  });
}

// ── Background start / stop ───────────────────────────────────────────────────

export function startProxy(options: { port?: number; window?: number; passthrough?: boolean; oauthBridge?: boolean }): void {
  const port = options.port ?? PROXY_PORT;
  const windowTokens = options.window ?? DEFAULT_WINDOW_TOKENS;

  if (!options.passthrough && existsSync(PAUSE_FILE)) unlinkSync(PAUSE_FILE);

  const existingPid = readPid();
  if (existingPid && isRunning(existingPid)) {
    if (existsSync(PAUSE_FILE)) {
      if (existsSync(PAUSE_FILE)) unlinkSync(PAUSE_FILE);
      console.log(`Proxy resumed — trimming active (PID ${existingPid}).`);
    } else {
      console.log(`Proxy already running with trimming active (PID ${existingPid}).`);
    }
    return;
  }

  const logFd = openSync(LOG_FILE, 'a');
  const child = spawn(
    process.execPath,
    [process.argv[1], '--foreground', '--verbose', '--port', String(port), '--window', String(windowTokens), ...(options.oauthBridge ? ['--oauth-bridge'] : [])],
    { detached: true, stdio: ['ignore', logFd, logFd] },
  );
  child.unref();

  if (!child.pid) {
    console.error('Failed to start proxy — could not spawn process.');
    return;
  }

  writePid(child.pid);
  setAnthropicBaseUrl(port);

  console.log(`ErgoSum proxy started (PID ${child.pid}) on port ${port}`);
  console.log(`Context window: ~${(windowTokens / 1000).toFixed(0)}k tokens`);
  console.log(`Log: tail -f ${LOG_FILE}`);
  console.log(`Stop: ergosum-proxy stop`);
}

export function stopProxy(): void {
  const dir = dirname(PAUSE_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(PAUSE_FILE, '', 'utf8');

  const pid = readPid();
  if (!pid || !isRunning(pid)) {
    console.log('Proxy was not running — starting in passthrough mode.');
    startProxy({ passthrough: true });
    return;
  }

  console.log(`Proxy paused — running in passthrough mode (PID ${pid}).`);
  console.log('Trimming disabled. Claude Code connection maintained.');
  console.log('Resume trimming: ergosum-proxy');
  console.log('Remove proxy entirely: ergosum-proxy uninstall');
}

export function resumeProxy(): void {
  if (existsSync(PAUSE_FILE)) unlinkSync(PAUSE_FILE);
  const pid = readPid();
  if (!pid || !isRunning(pid)) {
    console.log('Proxy not running — starting with trimming enabled.');
    startProxy({});
    return;
  }
  console.log(`Proxy resumed — trimming active (PID ${pid}).`);
}

export function proxyLogs(): void {
  if (!existsSync(LOG_FILE)) {
    console.log(`No log file yet. Start the proxy first: ergosum-proxy`);
    return;
  }

  const pid = readPid();
  const running = pid && isRunning(pid);
  const paused = existsSync(PAUSE_FILE);
  if (running) {
    console.log(`Proxy PID ${pid} — ${paused ? 'PASSTHROUGH' : 'TRIMMING'} — tailing ${LOG_FILE}`);
  } else {
    console.log(`Proxy not running — showing last entries from ${LOG_FILE}`);
  }
  console.log('Press Ctrl+C to stop.\n');

  const tail = spawn('tail', ['-f', LOG_FILE], { stdio: 'inherit' });

  process.on('SIGINT', () => {
    tail.kill();
    process.exit(0);
  });
}

export function proxyStatus(): void {
  const pid = readPid();
  if (!pid || !isRunning(pid)) {
    console.log('Proxy: not running');
    console.log('Start: ergosum-proxy');
    return;
  }
  const paused = existsSync(PAUSE_FILE);
  const cfg = readProxyConfig();
  const modeStr = paused ? 'PASSTHROUGH' : `${cfg.mode.toUpperCase()} mode`;
  console.log(`Proxy: running (PID ${pid}) — ${modeStr}`);
  if (!paused) {
    if (cfg.mode === 'smart') console.log('Mode:  smart — ErgoSum compresses old turns server-side');
    else console.log('Mode:  inject — ErgoSum context injected into system prompt (default)');
  }
  console.log(`Log:   tail -f ${LOG_FILE}`);
  console.log(`Switch mode: ergosum-proxy --mode inject|smart`);
  if (paused) {
    console.log(`Resume trimming: ergosum-proxy`);
  } else {
    console.log(`Pause trimming:  ergosum-proxy stop`);
  }
  console.log(`Remove entirely: ergosum-proxy uninstall`);
}

// ── LaunchAgent (persistent across reboots) ───────────────────────────────────

const LAUNCH_AGENT_LABEL = 'cc.ergosum.proxy';

function getLaunchAgentPath(): string {
  const dir = join(homedir(), 'Library', 'LaunchAgents');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, `${LAUNCH_AGENT_LABEL}.plist`);
}

function getAbsolutePaths(): { node: string; script: string } {
  const nodePath = execSync('which node', { encoding: 'utf8' }).trim();
  try {
    const resolved = execSync(
      `readlink -f "${nodePath}" 2>/dev/null || realpath "${nodePath}" 2>/dev/null || echo "${nodePath}"`,
      { encoding: 'utf8' },
    ).trim();
    return { node: resolved, script: process.argv[1] };
  } catch {
    return { node: nodePath, script: process.argv[1] };
  }
}

function buildPlist(node: string, script: string, port: number, windowTokens: number): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node}</string>
    <string>${script}</string>
    <string>--foreground</string>
    <string>--port</string>
    <string>${port}</string>
    <string>--window</string>
    <string>${windowTokens}</string>
    <string>--persistent</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${LOG_FILE}</string>
  <key>StandardErrorPath</key>
  <string>${LOG_FILE}</string>
</dict>
</plist>
`;
}

export function installDaemon(port: number, windowTokens: number): void {
  const plistPath = getLaunchAgentPath();
  const { node, script } = getAbsolutePaths();
  try { execFileSync('launchctl', ['unload', plistPath], { stdio: 'ignore' }); } catch { /* not loaded */ }
  writeFileSync(plistPath, buildPlist(node, script, port, windowTokens), 'utf8');
  try {
    execFileSync('launchctl', ['load', '-w', plistPath]);
    setAnthropicBaseUrl(port);
    console.log(`ErgoSum proxy installed as LaunchAgent (starts on login, survives reboots).`);
    console.log(`Port: ${port}  |  Window: ${(windowTokens / 1000).toFixed(0)}k tokens`);
    console.log(`Log:  tail -f ${LOG_FILE}`);
    console.log(`Stop: ergosum-proxy uninstall`);
  } catch (err) {
    console.error(`launchctl load failed: ${err}`);
    console.error(`  launchctl load -w ${plistPath}`);
  }
}

export function uninstallProxy(): void {
  const pid = readPid();
  if (pid && isRunning(pid)) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* ignore */ }
  }
  if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
  if (existsSync(PAUSE_FILE)) unlinkSync(PAUSE_FILE);

  const plistPath = getLaunchAgentPath();
  if (existsSync(plistPath)) {
    try { execFileSync('launchctl', ['unload', '-w', plistPath]); } catch { /* ignore */ }
    unlinkSync(plistPath);
  }

  removeAnthropicBaseUrl();
  removeCodexBaseUrl();
  console.log('ErgoSum proxy uninstalled. All models route to default.');
}
