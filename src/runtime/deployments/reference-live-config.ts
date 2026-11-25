/**
 * Parses the environment-variable surface for a reference live deployment.
 *
 * Pure function: no `process.env` reads, no defaults. Every required variable
 * must be present and non-blank after trimming, otherwise parsing fails once
 * with the full list of offending variable names (never their values).
 *
 * The decision mode is the one optional surface: an absent `ISLA_DECISION_MODE`
 * keeps the historical rule ports, and the variables of a model provider group
 * are only required when that group's mode is selected.
 */

/** How the reference deployment obtains its M3 selection and reaction ports. */
export type ReferenceDecisionMode = 'rules' | 'general' | 'jev';

/** Provider settings shared by both decision model groups. */
export interface ReferenceDecisionProviderConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
}

/**
 * The general group is an OpenAI-compatible chat provider and additionally
 * accepts an optional completion-token limit. The Jev decisions adapter has no
 * such setting.
 */
export interface ReferenceGeneralDecisionProviderConfig
  extends ReferenceDecisionProviderConfig {
  /** Optional positive completion-token limit; absent uses the adapter default. */
  maxTokens?: number;
}

/** `rules` needs no provider; a model mode carries exactly one provider group. */
export type ReferenceDecisionConfig =
  | { readonly mode: 'rules' }
  | {
      readonly mode: 'general';
      readonly provider: ReferenceGeneralDecisionProviderConfig;
    }
  | { readonly mode: 'jev'; readonly provider: ReferenceDecisionProviderConfig };

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
  /**
   * Decision mode and its provider settings. Absent means `rules`, the
   * historical default, so a hand-built configuration keeps rule ports.
   */
  decision?: ReferenceDecisionConfig;
}

type Env = Readonly<Record<string, string | undefined>>;

const TEXT_BASE_URL = 'ISLA_LIVE_TEXT_BASE_URL';
const TEXT_MODEL = 'ISLA_LIVE_TEXT_MODEL';
const TEXT_API_KEY = 'ISLA_LIVE_TEXT_API_KEY';
const DECISION_MODE = 'ISLA_DECISION_MODE';
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

/**
 * The same rule the OpenAI-compatible decision adapters enforce before a call:
 * https anywhere, plain http only on loopback, no embedded credentials and no
 * fragment. A URL the adapter would refuse cannot pass startup.
 */
function isProviderBaseUrl(raw: string): boolean {
  if (raw.includes('#')) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.username !== '' || url.password !== '') return false;
  if (url.hash !== '') return false;
  if (url.protocol === 'https:') return true;
  if (url.protocol !== 'http:') return false;
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

interface DecisionProviderNames {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey: string;
  /** Absent for a group whose adapter has no completion-token setting. */
  readonly maxTokens?: string;
}

/** General-purpose chat group; the same names the M3 live harness reads. */
const GENERAL_DECISION_ENV: DecisionProviderNames = {
  baseUrl: 'ISLA_LIVE_DECISION_BASE_URL',
  model: 'ISLA_LIVE_DECISION_MODEL',
  apiKey: 'ISLA_LIVE_DECISION_API_KEY',
  maxTokens: 'ISLA_LIVE_DECISION_MAX_TOKENS',
};

/**
 * Dedicated Jev decisions group for the NFR-03 comparison. The adapter calls
 * `POST /v1/decisions` and has no completion-token setting, so no token-limit
 * variable is read or validated for this group.
 */
const JEV_DECISION_ENV: DecisionProviderNames = {
  baseUrl: 'ISLA_LIVE_JEV_BASE_URL',
  model: 'ISLA_LIVE_JEV_MODEL',
  apiKey: 'ISLA_LIVE_JEV_API_KEY',
};

/** Reads an optional positive integer completion-token limit. */
function readMaxTokens(
  env: Env,
  name: string,
  invalid: Set<string>,
): number | undefined {
  const raw = readTrimmed(env, name);
  if (raw === undefined) {
    return undefined;
  }
  if (!/^[1-9]\d*$/.test(raw)) {
    invalid.add(name);
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    invalid.add(name);
    return undefined;
  }
  return value;
}

function readDecisionProvider(
  env: Env,
  required: (name: string) => string,
  invalid: Set<string>,
  names: DecisionProviderNames,
): ReferenceGeneralDecisionProviderConfig {
  const baseUrl = required(names.baseUrl);
  if (baseUrl.length > 0 && !isProviderBaseUrl(baseUrl)) {
    invalid.add(names.baseUrl);
  }
  const model = required(names.model);
  const apiKey = required(names.apiKey);
  const maxTokensName = names.maxTokens;
  const maxTokens =
    maxTokensName === undefined
      ? undefined
      : readMaxTokens(env, maxTokensName, invalid);
  return {
    baseUrl,
    model,
    apiKey,
    ...(maxTokens !== undefined ? { maxTokens } : {}),
  };
}

/**
 * Resolves the decision mode. An absent or blank mode is `rules`; the provider
 * group for a selected model mode is then read and its missing or invalid
 * variables join the one aggregated startup error.
 */
function readDecisionConfig(
  env: Env,
  required: (name: string) => string,
  invalid: Set<string>,
): ReferenceDecisionConfig {
  const mode = readTrimmed(env, DECISION_MODE);
  if (mode === undefined || mode === 'rules') {
    return { mode: 'rules' };
  }
  if (mode === 'general') {
    return {
      mode,
      provider: readDecisionProvider(
        env,
        required,
        invalid,
        GENERAL_DECISION_ENV,
      ),
    };
  }
  if (mode === 'jev') {
    return {
      mode,
      provider: readDecisionProvider(env, required, invalid, JEV_DECISION_ENV),
    };
  }
  // Names the variable only: the value is never reported.
  invalid.add(DECISION_MODE);
  return { mode: 'rules' };
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
  const decision = readDecisionConfig(env, required, invalid);

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
    decision,
  };
}
