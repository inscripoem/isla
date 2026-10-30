import { renderDialoguePrompt } from './context'
import type { AssembledDialogueContext } from './context'
import type { DialogueComposeCall, DialogueComposeResult, DialogueTextSource } from './dialogue-port'

/**
 * Provider-backed text source over the OpenAI-compatible chat-completions API.
 *
 * Everything this source needs arrives through the injected configuration: no
 * `src/dialogue` file reads the environment, so the composition root owns
 * variable names and credential loading. The credential is used only as an
 * Authorization header and never appears in an error message.
 *
 * Failure discipline (coordination issue #44 §2.4): every fault throws, so the
 * port's existing path reports `DialogueEnd.status 'failed'` instead of
 * substituting text. The single exception is a revoked turn: once the per-call
 * signal is aborted this source returns no lines, and the port's post-compose
 * re-check classifies the call as `'cancelled'`.
 */

export const PROVIDER_DIALOGUE_MODEL_VERSION = 'openai-compatible-v1'

export interface OpenAiCompatibleTextSourceConfig {
  /** Chat-completions base URL, e.g. https://host/v1. Trailing slashes are tolerated. */
  readonly baseUrl: string
  /** Requested model identifier sent to the provider. */
  readonly model: string
  /** Bearer credential. Never logged, never echoed, never defaulted. */
  readonly apiKey: string
}

/**
 * Fixed instruction for the provider. It asks for speech only: one candidate per
 * line, at most the segment cap, so the returned text splits unambiguously and no
 * stage direction is mistaken for a spoken line.
 */
function systemInstruction(maxSegments: number): string {
  return (
    `Reply strictly in character as the character described below. ` +
    `Output at most ${maxSegments} short spoken line(s), one per line, using plain text only. ` +
    `Do not add stage directions, labels, quotation marks, headings or any other commentary.`
  )
}

function isNonBlank(value: string): boolean {
  return value.trim().length > 0
}

function isValidCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** Joins the configured base URL with the endpoint path regardless of trailing slashes. */
function completionsUrl(baseUrl: string): string {
  return `${baseUrl.trim().replace(/\/+$/, '')}/chat/completions`
}

/** Splits the model reply into candidates: trimmed non-empty lines, clamped to the cap. */
function splitLines(content: string, maxSegments: number): readonly string[] {
  const lines: string[] = []
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.length === 0) continue
    lines.push(line)
    if (lines.length >= maxSegments) break
  }
  return lines
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Reads the abort state through a function call: the value is re-read after each
 * await, and a narrowed property would be treated as unchanged by the compiler.
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

export function createOpenAiCompatibleTextSource(
  config: OpenAiCompatibleTextSourceConfig,
): DialogueTextSource {
  return {
    model: config.model,
    modelVersion: PROVIDER_DIALOGUE_MODEL_VERSION,
    /*
     * The served model is only known after a call, so it travels in the compose
     * result (§2.5). Reporting the requested model here would claim an identity the
     * provider never confirmed.
     */
    resolvedModel: null,
    async compose(
      view: AssembledDialogueContext,
      maxSegments: number,
      call?: DialogueComposeCall,
    ): Promise<DialogueComposeResult> {
      const signal = call?.signal
      /*
       * Configuration faults are checked before any network activity: a missing
       * credential must not produce a request at all, so the provider never sees
       * one. Messages name the fault and never repeat the credential value.
       */
      if (!isNonBlank(config.apiKey)) {
        throw new Error('openai-compatible dialogue text source: apiKey is blank or missing')
      }
      if (!isNonBlank(config.baseUrl)) {
        throw new Error('openai-compatible dialogue text source: baseUrl is blank or missing')
      }
      if (!isNonBlank(config.model)) {
        throw new Error('openai-compatible dialogue text source: model is blank or missing')
      }

      /* A turn already revoked before the request must not issue one. */
      if (isAborted(signal)) return { lines: [] }

      let response: Response
      try {
        response = await fetch(completionsUrl(config.baseUrl), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify({
            model: config.model,
            messages: [
              { role: 'system', content: systemInstruction(Math.max(0, maxSegments)) },
              { role: 'user', content: renderDialoguePrompt(view) },
            ],
            stream: false,
          }),
          ...(signal === undefined ? {} : { signal }),
        })
      } catch (error) {
        /*
         * An abort is the revoked turn, reported as an empty result so the port's
         * re-check decides `'cancelled'`. Any other rejection is a real fault and
         * must surface. The cause is a reason, never the request or its headers.
         */
        if (isAborted(signal)) return { lines: [] }
        const reason = error instanceof Error ? error.message : 'unknown transport error'
        throw new Error(`openai-compatible dialogue request failed: ${reason}`)
      }

      if (response.status < 200 || response.status > 299) {
        throw new Error(`openai-compatible dialogue request failed: HTTP ${response.status}`)
      }
      if (isAborted(signal)) return { lines: [] }

      const text = await response.text()
      let body: unknown
      try {
        body = JSON.parse(text)
      } catch {
        /* The response body itself is never echoed: it may carry provider internals. */
        throw new Error('openai-compatible dialogue response is not valid JSON')
      }
      if (!isRecord(body)) {
        throw new Error('openai-compatible dialogue response is not a JSON object')
      }

      const choices = body.choices
      const first = Array.isArray(choices) ? choices[0] : undefined
      const message = isRecord(first) ? first.message : undefined
      const content = isRecord(message) ? message.content : undefined
      if (typeof content !== 'string') {
        throw new Error(
          'openai-compatible dialogue response has no choices[0].message.content string',
        )
      }

      const servedModel =
        typeof body.model === 'string' && body.model.trim().length > 0 ? body.model : null
      const usage = isRecord(body.usage) ? body.usage : undefined
      const inputTokens = isValidCount(usage?.prompt_tokens) ? usage.prompt_tokens : null
      const outputTokens = isValidCount(usage?.completion_tokens) ? usage.completion_tokens : null

      return {
        lines: splitLines(content, Math.max(0, maxSegments)),
        resolvedModel: servedModel,
        inputTokens,
        outputTokens,
      }
    },
  }
}
