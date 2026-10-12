import type { ReplyIntent } from '../contracts'

/**
 * 由角色作者维护的角色内容。
 *
 * 这是唯一编写角色语气的文件。周围的解析、校验、上下文组装和裁剪逻辑都属于
 * 模块代码；下面的文字内容属于角色作者。
 *
 * 填写本文件：
 *   1. 编写 `personaSummary` 和 `styleNotes`。它们会原样写入每个对话上下文，
 *      因此应保持简短，因为每个回合都会消耗这些内容。
 *   2. 编写 `intentTemplates`。每种意图对应角色按说话顺序使用的台词。一个回合
 *      最多发出两个片段，因此数组最多只有前两项会被说出。
 *   3. 编写 `boundaries`，即角色绝不能说出或执行的内容。它们会作为约束渲染到
 *      上下文区块，而不是作为装饰性文本。
 *   4. 完成后，将 `PERSONA_AUTHORING_STATUS` 设为 'ready'。
 *
 * 状态为 'draft' 时：
 *   - 配置仍可解析，因此不会破坏运行，也不会使测试回合失败。
 *   - `collectPersonaContentIssues()` 会报告缺失内容，包括残留的 `TODO` 标记。
 *   - 状态变为 'ready' 后，同样的校验会强制执行：每种意图至少需要一条有效
 *     台词，且不能残留占位符。校验失败是构建错误，不会静默回退到通用措辞。
 *
 * 本文件不读取配置，也不导入提供方 SDK。
 */

export type PersonaAuthoringStatus = 'draft' | 'ready'

/**
 * 只有在下方所有章节都填写完成后才能切换为 'ready'。切换后的行为见上方说明。
 */
export const PERSONA_AUTHORING_STATUS: PersonaAuthoringStatus = 'draft'

export interface PersonaContent {
  /**
   * 角色设定集（长篇）的路径：`prompts/dialogue/character.md`。
   *
   * 它不会被渲染进上下文，存在的目的是让人（以及 NFR-03 的评分员）能读到完整
   * 人设，并让本文件可追溯到来源。测试会断言该路径仍然有效，因此重命名设定集
   * 会立刻失败，而不会让人设悄悄失去出处。
   */
  sourceDocument: string
  /** 本内容所依据的设定集版本；不是 profile 版本，两者独立演进。 */
  sourceVersion: string
  /** DialogueRequest.characterProfileId 使用的身份标识。 */
  profileId: string
  /** 角色含义变化时递增；重写时不得复用旧版本号。 */
  version: string
  /** 用一到两句话描述角色是谁，使用角色自己的表述。 */
  personaSummary: string
  /** 简短的语气规则，每项一条，使用祈使语气。 */
  styleNotes: readonly string[]
  /**
   * 每个回合都必须成立的事实：在意的人、喜欢的事物、共同的经历——忘掉任何一条
   * 都会让她在普通回复里听起来像另一个人。
   *
   * 这里刻意设了上限。本块每轮都会渲染，而且与已确认历史共用同一份字符预算：
   * 清单越长，被挤掉的历史越多，反而伤及本想支持的连续性。超出上限的内容留在
   * 设定集里，等按需召回。
   */
  standingFacts: readonly string[]
  /** 每种意图的台词，按说话顺序排列；最多说出前两条。 */
  intentTemplates: Readonly<Record<ReplyIntent, readonly string[]>>
  /** 硬性约束：角色绝不说出、声称或承诺的内容。 */
  boundaries: readonly string[]
}

export const CHARACTER_CONTENT: PersonaContent = {
  // ── 1. 出处 ────────────────────────────────────────────────────────────────
  // 完整设定集在这里，本文件只承载每轮必须生效的那部分。
  sourceDocument: 'prompts/dialogue/character.md',
  sourceVersion: 'draft',

  // ── 2. 身份 ────────────────────────────────────────────────────────────────
  profileId: 'testvtb',
  version: '1',

  // ── 2. 角色是谁 ────────────────────────────────────────────────────────────
  personaSummary: 'A witch full of love and courage, who is always charming and resilient. I am able to respond flexibly even to tricky questions.',

  // ── 3. 说话方式 ─────────────────────────────────────────────────────────────
  styleNotes: [
    'TODO: first style rule, imperative voice.',
    'TODO: second style rule.',
  ],

  // ── 4. 每轮都必须成立的事实（最多 5 条，每条一句话）───────────────────────────
  // 从设定集第 3–6 节里挑最重要的几条提升到这里，并保持两处文字一致。
  // 判据：忘掉它会在普通回复里让她像另一个人 → 值得占一个常驻位置。
  standingFacts: [
    'TODO: first standing fact, one short sentence.',
    'TODO: second standing fact.',
  ],

  // ── 5. 各种意图下说什么 ─────────────────────────────────────────────────────
  // 不要删除意图键。没有台词模板的意图表示角色无话可说，该回合以无语音结束。
  intentTemplates: {
    // 有实质内容地回答选中的消息。
    answer: ['TODO: first answer line.', 'TODO: second answer line.'],
    // 询问缺失细节，而不是进行猜测。
    clarify: ['TODO: clarification question.'],
    // 接收听众所说的内容，不额外添加未经证实的主张。
    acknowledge: ['TODO: acknowledgement line.'],
    // 回应听众正在经历的困难。
    support: ['TODO: supportive line.'],
    // 轻松俏皮的一拍；仍需符合角色且保持诚实。
    playful: ['TODO: playful line.'],
    // 请求核实，而不是直接同意对方的纠正。
    'check-correction': ['TODO: verification request.'],
  },

  // ── 6. 角色绝不做什么 ───────────────────────────────────────────────────────
  boundaries: ['TODO: first hard boundary.', 'TODO: second hard boundary.'],
}
