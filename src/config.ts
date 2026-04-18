import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

interface ErgoSumConfig {
  token?: string;
  url?: string;
}

const CONFIG_FILE = join(homedir(), 'Library', 'Preferences', 'ergosum-nodejs', 'config.json');
const XDG_CONFIG_FILE = join(homedir(), '.config', 'ergosum', 'config.json');

function readConfig(): ErgoSumConfig {
  for (const path of [CONFIG_FILE, XDG_CONFIG_FILE]) {
    if (!existsSync(path)) continue;
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as ErgoSumConfig;
    } catch {
      /* fall through */
    }
  }
  return {};
}

export function getToken(): string | undefined {
  return process.env['ERGOSUM_TOKEN'] || readConfig().token;
}

export function getBaseUrl(): string {
  return process.env['ERGOSUM_URL'] || readConfig().url || 'https://ergosum.cc';
}
