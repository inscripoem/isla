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
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key.trim().length === 0) {
      return false;
    }
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      return false;
    }
  }
  return true;
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
  const textModel = required(TEXT_MODEL);
  const textApiKey = required(TEXT_API_KEY);
  const vtsWsUrl = required(VTS_WS_URL);
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
    allowedOrigins = splitList(originsRaw);
    if (allowedOrigins.length === 0) {
      invalid.add(ALLOWED_ORIGINS);
    }
  }

  const hostsRaw = readTrimmed(env, ALLOWED_HOSTS);
  const allowedHosts = hostsRaw === undefined ? [] : splitList(hostsRaw);

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
