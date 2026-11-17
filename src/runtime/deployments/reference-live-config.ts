/**
 * Parses the environment-variable surface for a reference live deployment.
 *
 * Pure function: no `process.env` reads, no defaults. Every required variable
 * must be present and non-blank after trimming, otherwise parsing fails once
 * with the full list of offending variable names (never their values).
 */

export interface ReferenceLiveConfig {
  text: {
    baseUrl: string;
    model: string;
    apiKey: string;
  };
  vts: {
    wsUrl: string;
    pluginName: string;
    pluginDeveloper: string;
    tokenPath: string;
  };
  hotkeyMap: Readonly<Record<string, string>>;
  kokoroModelDir: string;
  allowedOrigins: readonly string[];
  allowedHosts: readonly string[];
}

type Env = Readonly<Record<string, string | undefined>>;

const TEXT_BASE_URL = 'ISLA_LIVE_TEXT_BASE_URL';
const TEXT_MODEL = 'ISLA_LIVE_TEXT_MODEL';
const TEXT_API_KEY = 'ISLA_LIVE_TEXT_API_KEY';
const VTS_WS_URL = 'ISLA_VTS_WS_URL';
const VTS_PLUGIN_NAME = 'ISLA_VTS_PLUGIN_NAME';
const VTS_PLUGIN_DEVELOPER = 'ISLA_VTS_PLUGIN_DEVELOPER';
const VTS_TOKEN_PATH = 'ISLA_VTS_TOKEN_PATH';
const VTS_HOTKEY_MAP = 'ISLA_VTS_HOTKEY_MAP';
const KOKORO_MODEL_DIR = 'ISLA_KOKORO_MODEL_DIR';
const ALLOWED_ORIGINS = 'ISLA_ALLOWED_ORIGINS';
const ALLOWED_HOSTS = 'ISLA_ALLOWED_HOSTS';

function readTrimmed(env: Env, name: string): string | undefined {
  const raw = env[name];
  if (typeof raw !== 'string') {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) {
    return false;
  }
  for (const [key, entry] of entries) {
    if (key.trim().length === 0) {
      return false;
    }
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      return false;
    }
  }
  return true;
}

function isHttpsOrLoopbackHttp(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  if (url.protocol !== 'http:') return false;
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

function isWebSocketUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'ws:' || url.protocol === 'wss:';
  } catch {
    return false;
  }
}

/** Returns the canonical `scheme://host` origin, or null for anything else. */
function canonicalOrigin(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.pathname !== '/' || url.search.length > 0 || url.hash.length > 0) return null;
  if (url.username.length > 0 || url.password.length > 0) return null;
  return `${url.protocol}//${url.host}`;
}

/** Host header entries are a hostname or bracketed IPv6, optionally with a port. */
function isValidHostEntry(raw: string): boolean {
  return /^(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(?::\d{1,5})?$/.test(raw);
}

export function parseReferenceLiveConfig(env: Env): ReferenceLiveConfig {
  const invalid = new Set<string>();

  const required = (name: string): string => {
    const value = readTrimmed(env, name);
    if (value === undefined) {
      invalid.add(name);
      return '';
    }
    return value;
  };

  const textBaseUrl = required(TEXT_BASE_URL);
  if (textBaseUrl.length > 0 && !isHttpsOrLoopbackHttp(textBaseUrl)) {
    invalid.add(TEXT_BASE_URL);
  }
  const textModel = required(TEXT_MODEL);
  const textApiKey = required(TEXT_API_KEY);
  const vtsWsUrl = required(VTS_WS_URL);
  if (vtsWsUrl.length > 0 && !isWebSocketUrl(vtsWsUrl)) {
    invalid.add(VTS_WS_URL);
  }
  const vtsPluginName = required(VTS_PLUGIN_NAME);
  const vtsPluginDeveloper = required(VTS_PLUGIN_DEVELOPER);
  const vtsTokenPath = required(VTS_TOKEN_PATH);

  const hotkeyRaw = readTrimmed(env, VTS_HOTKEY_MAP);
  let hotkeyMap: Record<string, string> = {};
  if (hotkeyRaw === undefined) {
    invalid.add(VTS_HOTKEY_MAP);
  } else {
    try {
      const parsed: unknown = JSON.parse(hotkeyRaw);
      if (isStringRecord(parsed)) {
        hotkeyMap = { ...parsed };
      } else {
        invalid.add(VTS_HOTKEY_MAP);
      }
    } catch {
      invalid.add(VTS_HOTKEY_MAP);
    }
  }

  const kokoroModelDir = required(KOKORO_MODEL_DIR);

  const originsRaw = readTrimmed(env, ALLOWED_ORIGINS);
  let allowedOrigins: string[] = [];
  if (originsRaw === undefined) {
    invalid.add(ALLOWED_ORIGINS);
  } else {
    const entries = splitList(originsRaw);
    const canonical = entries.map(canonicalOrigin);
    if (entries.length === 0 || canonical.some((origin) => origin === null)) {
      invalid.add(ALLOWED_ORIGINS);
    } else {
      allowedOrigins = [...new Set(canonical as string[])];
    }
  }

  const hostsRaw = readTrimmed(env, ALLOWED_HOSTS);
  let allowedHosts: string[] = [];
  if (hostsRaw !== undefined) {
    const hosts = splitList(hostsRaw);
    if (hosts.some((host) => !isValidHostEntry(host))) {
      invalid.add(ALLOWED_HOSTS);
    } else {
      allowedHosts = hosts;
    }
  }

  if (invalid.size > 0) {
    throw new Error(
      `missing or invalid environment variables: ${[...invalid].join(', ')}`,
    );
  }

  return {
    text: {
      baseUrl: textBaseUrl,
      model: textModel,
      apiKey: textApiKey,
    },
    vts: {
      wsUrl: vtsWsUrl,
      pluginName: vtsPluginName,
      pluginDeveloper: vtsPluginDeveloper,
      tokenPath: vtsTokenPath,
    },
    hotkeyMap,
    kokoroModelDir,
    allowedOrigins,
    allowedHosts,
  };
}
