import { REPLY_INTENTS } from '../contracts'
import type { ReplyIntent } from '../contracts'
import { CHARACTER_CONTENT, PERSONA_AUTHORING_STATUS } from './persona-content'
import type { PersonaContent } from './persona-content'
import { isSubstantiveSpeech } from './text'

/**
 * 角色配置文件及其到上下文的映射。
 *
 * 两种配置来源并列存在，但绝不混用：
 *   - `harness` —— 离线 fixture 配置，用于让共享一致性套件在没有正式角色配置
 *     时仍可运行。它不是真实角色，不要为了改善角色语气而修改它。
 *   - `author` —— 从 ./content 读取的正式角色，由角色作者维护。这里不会重写
 *     或默认替换其中的措辞。
 *
 * M4-01 使用固定表格，使流水线能够在没有在线提供方时完成集成和测试。M4-02
 * 将表格替换为真实模型调用，但下面的解析、校验和渲染逻辑保持不变。
 */

/**
 * 每轮常驻事实的上限。
 *
 * `standingFacts` 与已确认历史共用同一份字符预算，清单无上限就会挤掉它本应
 * 支持的记忆。角色标记为 ready 后由校验强制执行；草稿阶段仅作为问题报告。
 */
export const MAX_STANDING_FACTS = 5
export const MAX_STANDING_FACT_CHARACTERS = 80

export interface CharacterProfile {
  profileId: string
  version: string
  personaSummary: string
  styleNotes: readonly string[]
  /** 每轮都必须成立的事实；缺少表示没有常驻事实。 */
  standingFacts?: readonly string[]
  /** 缺少该字段表示角色对任何意图都没有可说内容。 */
  intentTemplates?: Readonly<Record<ReplyIntent, readonly string[]>>
  boundaries?: readonly string[]
  /**
   * `harness` 配置是测试脚手架，`author` 配置来自 ./content。校验结果会报告
   * 来源，避免把 fixture 角色误认为正式角色。
   */
  origin: 'harness' | 'author'
}

/**
 * 共享离线 fixture 所需的配置。`character-fixture` 必须持续注册并产生有效文本，
 * 否则一致性套件会失去基线，而不是发现真正的缺陷。
 */
const FIXTURE_INTENT_REPLY_LINES: Readonly<Record<ReplyIntent, readonly string[]>> = {
  answer: ['We talked about the concert.', 'It was loud and fun.'],
  clarify: ['Which part should I start with?'],
  acknowledge: ['Thanks for saying that.'],
  support: ['That sounds rough, but you have got this.'],
  playful: ['I would rate it eleven out of ten.'],
  // 特意请求核实而不是直接同意：契约要求该意图请求验证，不能直接承认纠正。
  'check-correction': ['Let me double-check that before I agree.'],
}

export const FIXTURE_CHARACTER_PROFILE: CharacterProfile = {
  profileId: 'character-fixture',
  version: '1',
  personaSummary: 'A concise, friendly character.',
  styleNotes: ['keeps replies short', 'speaks in at most two segments'],
  intentTemplates: FIXTURE_INTENT_REPLY_LINES,
  origin: 'harness',
}

export const AUTHOR_CHARACTER_PROFILE: CharacterProfile = {
  profileId: CHARACTER_CONTENT.profileId,
  version: CHARACTER_CONTENT.version,
  personaSummary: CHARACTER_CONTENT.personaSummary,
  styleNotes: CHARACTER_CONTENT.styleNotes,
  standingFacts: CHARACTER_CONTENT.standingFacts,
  intentTemplates: CHARACTER_CONTENT.intentTemplates,
  boundaries: CHARACTER_CONTENT.boundaries,
  origin: 'author',
}

export const DEFAULT_CHARACTER_PROFILES: readonly CharacterProfile[] = [
  FIXTURE_CHARACTER_PROFILE,
  AUTHOR_CHARACTER_PROFILE,
]

/**
 * 用于记忆版本管理的角色身份。两部分都很重要：不同 profile ID 下的同一版本号
 * 代表不同角色。记忆记录保存此键，以便之后识别旧角色说过的话。
 */
export function personaVersionKey(profileId: string, version: string): string {
  return `${profileId}@${version}`
}

/**
 * 按身份和版本解析角色配置。两者必须同时匹配：配置版本变化意味着角色已变化，
 * 不能静默替换。未知配置返回 null，由调用方报告生成失败，而不是凭空创建角色。
 */
export function resolveCharacterProfile(
  profileId: string,
  version: string,
  profiles: readonly CharacterProfile[] = DEFAULT_CHARACTER_PROFILES,
): CharacterProfile | null {
  return (
    profiles.find((profile) => profile.profileId === profileId && profile.version === version) ??
    null
  )
}

/**
 * 返回该配置针对某意图的台词，顺序即说话顺序。空数组具有明确含义：角色没有
 * 可说内容，调用方应将其转为无语音结果，而不是临时编造填充台词。
 */
export function intentTemplatesFor(
  profile: CharacterProfile,
  intent: ReplyIntent,
): readonly string[] {
  return profile.intentTemplates?.[intent] ?? []
}

/**
 * 不得出现在“ready”角色中的占位标记。发布后仍说出“TODO”的角色比缺失角色更
 * 糟糕，因为它看似已经编写完成，实际却并未完成。
 */
export const PERSONA_PLACEHOLDER_MARKERS: readonly string[] = [
  'TODO',
  'FIXME',
  'FILL ME',
  'PLACEHOLDER',
  '待填',
]

function hasPlaceholder(text: string): boolean {
  const upper = text.toUpperCase()
  return PERSONA_PLACEHOLDER_MARKERS.some((marker) => upper.includes(marker))
}

/**
 * 校验正式角色内容。返回可读的问题列表，绝不抛出异常：草稿角色允许不完整，
 * 报告问题优于在编写过程中使测试套件崩溃。
 *
 * 当 `PERSONA_AUTHORING_STATUS` 为 'ready' 后，同样的检查将成为强制要求。
 */
export function collectPersonaContentIssues(content: PersonaContent): readonly string[] {
  const issues: string[] = []

  if (content.sourceDocument.trim().length === 0 || hasPlaceholder(content.sourceDocument)) {
    issues.push('sourceDocument is missing: the persona must point at its character bible')
  }
  if (content.sourceVersion.trim().length === 0 || hasPlaceholder(content.sourceVersion)) {
    issues.push('sourceVersion is missing or still a placeholder')
  }
  if (content.profileId.trim().length === 0 || hasPlaceholder(content.profileId)) {
    issues.push('profileId is missing or still a placeholder')
  }
  if (content.personaSummary.trim().length === 0 || hasPlaceholder(content.personaSummary)) {
    issues.push('personaSummary is missing or still a placeholder')
  }
  if (content.styleNotes.length === 0) {
    issues.push('styleNotes is empty')
  }
  for (const note of content.styleNotes) {
    if (note.trim().length === 0 || hasPlaceholder(note)) {
      issues.push(`styleNotes contains an empty or placeholder entry: "${note}"`)
    }
  }
  if (content.standingFacts.length === 0) {
    issues.push('standingFacts is empty: nothing is guaranteed to hold on every turn')
  }
  if (content.standingFacts.length > MAX_STANDING_FACTS) {
    issues.push(
      `standingFacts has ${content.standingFacts.length} entries, at most ${MAX_STANDING_FACTS} are allowed`,
    )
  }
  for (const fact of content.standingFacts) {
    if (fact.trim().length === 0 || hasPlaceholder(fact)) {
      issues.push(`standingFacts contains an empty or placeholder entry: "${fact}"`)
    }
    if (fact.length > MAX_STANDING_FACT_CHARACTERS) {
      issues.push(
        `standingFacts entry exceeds ${MAX_STANDING_FACT_CHARACTERS} characters: "${fact}"`,
      )
    }
  }
  if (content.boundaries.length === 0) {
    issues.push('boundaries is empty')
  }
  for (const boundary of content.boundaries) {
    if (boundary.trim().length === 0 || hasPlaceholder(boundary)) {
      issues.push(`boundaries contains an empty or placeholder entry: "${boundary}"`)
    }
  }

  for (const intent of REPLY_INTENTS) {
    const lines = content.intentTemplates[intent]
    if (lines === undefined) {
      issues.push(`intentTemplates is missing the "${intent}" intent`)
      continue
    }
    if (lines.length === 0) {
      issues.push(`intentTemplates["${intent}"] is empty: the character would say nothing`)
      continue
    }
    for (const line of lines) {
      if (!isSubstantiveSpeech(line)) {
        issues.push(`intentTemplates["${intent}"] has a line with no speakable content: "${line}"`)
      }
      if (hasPlaceholder(line)) {
        issues.push(`intentTemplates["${intent}"] still contains a placeholder: "${line}"`)
      }
    }
  }

  return issues
}

export function personaAuthoringStatus(): 'draft' | 'ready' {
  return PERSONA_AUTHORING_STATUS
}

/** 正式角色存在的问题；编写完成并标记为 ready 后应为空。 */
export function personaAuthoringIssues(): readonly string[] {
  return collectPersonaContentIssues(CHARACTER_CONTENT)
}

/**
 * 将角色渲染为上下文区块。空章节会被省略，而不是渲染成空标题，因为这里的
 * 每一行都会在每个回合消耗上下文空间。
 */
export function renderPersonaBlock(profile: CharacterProfile): string {
  const lines: string[] = [`Persona: ${profile.personaSummary}`]

  if (profile.styleNotes.length > 0) {
    lines.push('Style:')
    for (const note of profile.styleNotes) lines.push(`- ${note}`)
  }
  const standingFacts = (profile.standingFacts ?? []).slice(0, MAX_STANDING_FACTS)
  if (standingFacts.length > 0) {
    lines.push('Always true:')
    for (const fact of standingFacts) lines.push(`- ${fact}`)
  }
  const boundaries = profile.boundaries ?? []
  if (boundaries.length > 0) {
    lines.push('Never:')
    for (const boundary of boundaries) lines.push(`- ${boundary}`)
  }

  return lines.join('\n')
}
