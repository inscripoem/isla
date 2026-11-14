import { describe, expect, it } from 'vitest';

import { parseReferenceLiveConfig } from '../../src/runtime/deployments/reference-live-config';

const REQUIRED_NAMES = [
  'ISLA_LIVE_TEXT_BASE_URL',
  'ISLA_LIVE_TEXT_MODEL',
  'ISLA_LIVE_TEXT_API_KEY',
  'ISLA_VTS_WS_URL',
  'ISLA_VTS_PLUGIN_NAME',
  'ISLA_VTS_PLUGIN_DEVELOPER',
  'ISLA_VTS_TOKEN_PATH',
  'ISLA_VTS_HOTKEY_MAP',
  'ISLA_KOKORO_MODEL_DIR',
  'ISLA_ALLOWED_ORIGINS',
] as const;

const SECRET_VALUES = [
  'sk-live-example-value',
  'wss://vts.example.test:8001',
  'Reference Plugin',
  'Reference Studio',
  '/run/secrets/vts-token',
  '/models/kokoro',
] as const;

function validEnv(): Record<string, string> {
  return {
    ISLA_LIVE_TEXT_BASE_URL: 'https://text.example.test/v1',
    ISLA_LIVE_TEXT_MODEL: 'reference-model',
    ISLA_LIVE_TEXT_API_KEY: 'sk-live-example-value',
    ISLA_VTS_WS_URL: 'wss://vts.example.test:8001',
    ISLA_VTS_PLUGIN_NAME: 'Reference Plugin',
    ISLA_VTS_PLUGIN_DEVELOPER: 'Reference Studio',
    ISLA_VTS_TOKEN_PATH: '/run/secrets/vts-token',
    ISLA_VTS_HOTKEY_MAP: '{"toggle-mute": "Ctrl+Alt+M"}',
    ISLA_KOKORO_MODEL_DIR: '/models/kokoro',
    ISLA_ALLOWED_ORIGINS: 'https://app.example.test,https://admin.example.test',
    ISLA_ALLOWED_HOSTS: 'app.example.test,admin.example.test',
  };
}

function captureError(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw new Error('expected an Error instance to be thrown');
  }
  throw new Error('expected the function to throw');
}

describe('parseReferenceLiveConfig', () => {
  it('returns every configured value with parsed hotkeys, origins and hosts', () => {
    const config = parseReferenceLiveConfig(validEnv());

    expect(config.text.baseUrl).toBe('https://text.example.test/v1');
    expect(config.text.model).toBe('reference-model');
    expect(config.text.apiKey).toBe('sk-live-example-value');
    expect(config.vts.wsUrl).toBe('wss://vts.example.test:8001');
    expect(config.vts.pluginName).toBe('Reference Plugin');
    expect(config.vts.pluginDeveloper).toBe('Reference Studio');
    expect(config.vts.tokenPath).toBe('/run/secrets/vts-token');
    expect(config.hotkeyMap).toEqual({ 'toggle-mute': 'Ctrl+Alt+M' });
    expect(config.kokoroModelDir).toBe('/models/kokoro');
    expect(config.allowedOrigins).toEqual([
      'https://app.example.test',
      'https://admin.example.test',
    ]);
    expect(config.allowedHosts).toEqual([
      'app.example.test',
      'admin.example.test',
    ]);
  });

  it('treats optional hosts as absent when unset', () => {
    const env = validEnv();
    delete env.ISLA_ALLOWED_HOSTS;

    const config = parseReferenceLiveConfig(env);

    expect(config.allowedHosts).toEqual([]);
  });

  it('trims surrounding whitespace on scalar values', () => {
    const env = validEnv();
    env.ISLA_LIVE_TEXT_MODEL = '  reference-model  ';
    env.ISLA_KOKORO_MODEL_DIR = '\t/models/kokoro \n';

    const config = parseReferenceLiveConfig(env);

    expect(config.text.model).toBe('reference-model');
    expect(config.kokoroModelDir).toBe('/models/kokoro');
  });

  it('reports every missing variable in one error without leaking values', () => {
    const error = captureError(() => parseReferenceLiveConfig({}));

    for (const name of REQUIRED_NAMES) {
      expect(error.message).toContain(name);
    }
    expect(error.message.startsWith('missing or invalid environment variables: ')).toBe(
      true,
    );
    const reported = error.message
      .slice('missing or invalid environment variables: '.length)
      .split(', ');
    expect(reported).toHaveLength(REQUIRED_NAMES.length);
    expect(new Set(reported)).toEqual(new Set(REQUIRED_NAMES));
    for (const secret of SECRET_VALUES) {
      expect(error.message).not.toContain(secret);
    }
  });

  it('treats blank values as missing and names them', () => {
    const env = validEnv();
    env.ISLA_LIVE_TEXT_API_KEY = '   ';
    env.ISLA_ALLOWED_ORIGINS = '\t';

    const error = captureError(() => parseReferenceLiveConfig(env));

    expect(error.message).toContain('ISLA_LIVE_TEXT_API_KEY');
    expect(error.message).toContain('ISLA_ALLOWED_ORIGINS');
    expect(error.message).not.toContain('ISLA_LIVE_TEXT_BASE_URL');
    expect(error.message).not.toContain('ISLA_KOKORO_MODEL_DIR');
  });

  it('reports malformed hotkey JSON by variable name', () => {
    const env = validEnv();
    env.ISLA_VTS_HOTKEY_MAP = '{"toggle-mute": ';

    const error = captureError(() => parseReferenceLiveConfig(env));

    expect(error.message).toContain('ISLA_VTS_HOTKEY_MAP');
    expect(error.message).not.toContain('toggle-mute');
  });

  it('rejects a hotkey map that is not a JSON object', () => {
    for (const raw of ['["toggle-mute"]', '"Ctrl+Alt+M"', 'null', '42', 'true']) {
      const env = validEnv();
      env.ISLA_VTS_HOTKEY_MAP = raw;

      const error = captureError(() => parseReferenceLiveConfig(env));

      expect(error.message).toContain('ISLA_VTS_HOTKEY_MAP');
      expect(error.message).not.toContain('toggle-mute');
    }
  });

  it('rejects hotkey maps with empty keys or empty values', () => {
    const cases = ['{"": "Ctrl+Alt+M"}', '{"toggle-mute": ""}', '{"  ": "   "}'];

    for (const raw of cases) {
      const env = validEnv();
      env.ISLA_VTS_HOTKEY_MAP = raw;

      const error = captureError(() => parseReferenceLiveConfig(env));

      expect(error.message).toContain('ISLA_VTS_HOTKEY_MAP');
    }
  });

  it('rejects hotkey maps with non-string values', () => {
    const env = validEnv();
    env.ISLA_VTS_HOTKEY_MAP = '{"toggle-mute": 1}';

    const error = captureError(() => parseReferenceLiveConfig(env));

    expect(error.message).toContain('ISLA_VTS_HOTKEY_MAP');
  });

  it('trims origins and drops empty entries', () => {
    const env = validEnv();
    env.ISLA_ALLOWED_ORIGINS = ' https://app.example.test , ,https://admin.example.test,  ';
    env.ISLA_ALLOWED_HOSTS = ' app.example.test ,, admin.example.test ';

    const config = parseReferenceLiveConfig(env);

    expect(config.allowedOrigins).toEqual([
      'https://app.example.test',
      'https://admin.example.test',
    ]);
    expect(config.allowedHosts).toEqual([
      'app.example.test',
      'admin.example.test',
    ]);
  });

  it('fails when origins reduce to an empty list', () => {
    const env = validEnv();
    env.ISLA_ALLOWED_ORIGINS = ' , , ';

    const error = captureError(() => parseReferenceLiveConfig(env));

    expect(error.message).toContain('ISLA_ALLOWED_ORIGINS');
  });

  it('accepts an empty host list', () => {
    const env = validEnv();
    env.ISLA_ALLOWED_HOSTS = ' , ';

    const config = parseReferenceLiveConfig(env);

    expect(config.allowedHosts).toEqual([]);
  });

  it('collects missing and invalid names together in one error', () => {
    const env: Record<string, string> = {
      ISLA_LIVE_TEXT_BASE_URL: 'https://text.example.test/v1',
      ISLA_LIVE_TEXT_MODEL: 'reference-model',
      ISLA_LIVE_TEXT_API_KEY: 'sk-live-example-value',
      ISLA_VTS_WS_URL: '   ',
      ISLA_VTS_PLUGIN_NAME: 'Reference Plugin',
      ISLA_VTS_PLUGIN_DEVELOPER: 'Reference Studio',
      ISLA_VTS_TOKEN_PATH: '/run/secrets/vts-token',
      ISLA_VTS_HOTKEY_MAP: 'not json',
      ISLA_KOKORO_MODEL_DIR: '/models/kokoro',
      ISLA_ALLOWED_ORIGINS: ' , ',
    };

    const error = captureError(() => parseReferenceLiveConfig(env));
    const reported = error.message
      .slice('missing or invalid environment variables: '.length)
      .split(', ');

    expect(new Set(reported)).toEqual(
      new Set(['ISLA_VTS_WS_URL', 'ISLA_VTS_HOTKEY_MAP', 'ISLA_ALLOWED_ORIGINS']),
    );
    expect(error.message).not.toContain('sk-live-example-value');
  });
});
