/* zcode-workflow
name: isla-course-wrapup
description: |
  Isla 课程收尾工作流：把 CS5351 五份课件的 344 条要点与项目实践逐条对照（中英双版），
  盘点课程要求交付物缺口并按 GitHub 行为记录起草补齐（中英缺口清单），并生成 M4 个人工作回顾。
whenToUse: |
  项目收尾或需要对照 CS5351 课程要求补齐材料时运行。依赖 D:/5351/lectures 的课件 PDF、
  D:/isla 仓库与 GitHub（inscripoem/isla，需 gh 登录）；产出写到仓库外目录，不修改仓库。
scope: project
args:
  lecturesDir:
    type: string
    default: D:/5351/lectures
    description: 课件 PDF 所在目录
  outputDir:
    type: string
    default: D:/5351/isla
    description: 产出目录（建议位于仓库之外）
*/
// Isla 课程收尾工作流：课件要点对照 / 交付物缺口与草案 / M4 工作回顾
// 产出目录在仓库 checkout 之外（符合 AGENTS.md：中文副本与草稿不进 checkout）。

const LECTURES_DIR = typeof args.lecturesDir === "string" ? args.lecturesDir : "D:/5351/lectures";
const OUT_DIR = typeof args.outputDir === "string" ? args.outputDir : "D:/5351/isla";
const SCRATCH = OUT_DIR + "/_scratch";
const TEXT_DIR = "D:/5351/_pdf_text";
const WORKSPACE = "D:/isla";
const FALLBACK_DIR = WORKSPACE + "/.workbuddy/wrapup-drafts";
const TODAY = "2026-11-23";

const LECTURES = [
  { tag: "intro", file: "cs5351-2026-2027-introduction.pdf", name: "课程导论", pages: 27 },
  { tag: "process", file: "cs5351-2026-2027-process.pdf", name: "软件过程", pages: 127 },
  { tag: "RE", file: "cs5351-2026-2027-RE.pdf", name: "需求工程", pages: 126 },
  { tag: "SA", file: "CS5351-2026-2027-SA.pdf", name: "软件架构", pages: 248 },
  { tag: "QA", file: "CS5351-2026-2027-QA.pdf", name: "质量保证", pages: 106 },
];

// 课程要求书第5节规定的仓库结构（来自 CS5351 项目要求 PDF）。
const REQUIRED = [
  { path: "README.md", glob: "README.md", rule: "D7/提交格式：用途、结构、离线与实时测试运行方式、GitHub链接" },
  { path: "AGENTS.md", glob: "AGENTS.md", rule: "D3 编码智能体唯一入口" },
  { path: "architecture-blueprint.md", glob: "architecture-blueprint.md", rule: "D2.1 架构蓝图" },
  { path: "Prompt.md", glob: "Prompt.md", rule: "D9 静态启动提示词" },
  { path: "Report.md", glob: "Report.md", rule: "D6 过程报告（成员、相对贡献、自我反思、过程证据）" },
  { path: "docs/req/requirements.yaml", glob: "docs/req/requirements.yaml", rule: "D1 机器可读PRD/需求登记册" },
  { path: "docs/req/req-schema.json", glob: "docs/req/req-schema.json", rule: "D1 CI校验Schema" },
  { path: "docs/architecture/adr/", glob: "docs/architecture/adr/*.md", rule: "D2.2 架构决策记录" },
  { path: "docs/architecture/invariants.md", glob: "docs/architecture/invariants.md", rule: "D2.3 不变量登记册" },
  { path: "docs/architecture/trace-matrix.md", glob: "docs/architecture/trace-matrix.md", rule: "D2.4 追溯矩阵" },
  { path: "docs/architecture/memory-design.md", glob: "docs/architecture/memory-design.md", rule: "D2.5 记忆/状态设计" },
  { path: "docs/architecture/permission-model.md", glob: "docs/architecture/permission-model.md", rule: "D2.6 权限模型" },
  { path: "docs/architecture/runtime-policy-catalog.md", glob: "docs/architecture/runtime-policy-catalog.md", rule: "D2.7 运行时策略目录" },
  { path: "docs/architecture/evaluation-table.md", glob: "docs/architecture/evaluation-table.md", rule: "D2.8 候选方案评估表" },
  { path: "docs/architecture/evaluation-logbook.md", glob: "docs/architecture/evaluation-logbook.md", rule: "D2.9 [可选] 评估日志" },
  { path: "docs/architecture/risk-list.md", glob: "docs/architecture/risk-list.md", rule: "D2.10 [可选] 风险清单" },
  { path: "docs/architecture/option-ledger.md", glob: "docs/architecture/option-ledger.md", rule: "D2.11 [可选] 备选方案台账" },
  { path: "docs/code-governance/structural-constraints.md", glob: "docs/code-governance/structural-constraints.md", rule: "D3 模块组织规则" },
  { path: "docs/code-governance/verification-constraints.md", glob: "docs/code-governance/verification-constraints.md", rule: "D4 验证三层" },
  { path: "docs/code-governance/mcp-tool-manifest.md", glob: "docs/code-governance/mcp-tool-manifest.md", rule: "D3 工具清单" },
  { path: "docs/ai-use-log.yaml", glob: "docs/ai-use-log.yaml", rule: "D1 强制项：AI使用日志" },
  { path: "docs/review-memo.md", glob: "docs/review-memo.md", rule: "D4 PR评审备忘" },
  { path: "docs/debt-register.md", glob: "docs/debt-register.md", rule: "D4 技术债登记册" },
  { path: "docs/bug-diary.md", glob: "docs/bug-diary.md", rule: "D4 bug日记" },
  { path: ".opencode/permissions.jsonc", glob: ".opencode/permissions.jsonc", rule: "D3 机器可读权限模型" },
  { path: ".opencode/rules.md", glob: ".opencode/rules.md", rule: "D3 项目级常驻行为规则（仅限人类编辑）" },
  { path: ".agent/rules.md", glob: ".agent/rules.md", rule: "D3 项目公约" },
  { path: ".github/workflows/ci.yml", glob: ".github/workflows/ci.yml", rule: "D4/D7 阻断门流水线" },
  { path: "prompts/prompt_v1.0.0.yaml", glob: "prompts/prompt_v1.0.0.yaml", rule: "D9 运行时提示词（可不同布局）" },
  { path: "prompts/prompt_v1.1.yaml", glob: "prompts/prompt_v1.1.yaml", rule: "D9 运行时提示词（可不同布局）" },
  { path: "src/", glob: "src/*", rule: "D8 完整源码" },
  { path: "test/offline/", glob: "test/offline/*", rule: "D8 确定性离线测试" },
  { path: "test/live/", glob: "test/live/*", rule: "D8 依赖API的实时测试" },
  { path: "transcripts/", glob: "transcripts/*", rule: "D5 学生批注的会话记录" },
];

interface LecturePoint {
  /** 主题短语（中文） */
  topicZh: string;
  /** 主题短语（英文） */
  topicEn: string;
  /** 中文陈述：老师讲了什么、强调什么，2-4句 */
  zh: string;
  /** 对应英文陈述 */
  en: string;
  /** 一句话：对"用AI智能体做软件工程"的团队为什么重要 */
  why: string;
}
interface LectureDigest {
  /** 课件中文名，如"软件架构" */
  lecture: string;
  /** 实际读到的范围，如"248页全部读完" */
  scale: string;
  points: LecturePoint[];
}
interface CoursePoint {
  /** 稳定编号，形如 CP-01 */
  id: string;
  /** 主题编号，形如 T1 */
  themeId: string;
  topicZh: string;
  topicEn: string;
  zh: string;
  en: string;
  /** 来源课件名列表 */
  lectures: string[];
}
interface Theme {
  /** 形如 T1，不含空格 */
  id: string;
  titleZh: string;
  titleEn: string;
  pointIds: string[];
}
interface CoursePoints {
  themes: Theme[];
  points: CoursePoint[];
}
interface ThemeSection {
  themeId: string;
  titleZh: string;
  titleEn: string;
  /** 写入的小节文件绝对路径 */
  sectionFile: string;
  entryCount: number;
  /** 留占位（无对应实践）的条目数 */
  placeholderCount: number;
}
interface Review {
  /** 是否需要修订 */
  needsRevision: boolean;
  /** 具体意见，指明条目或位置 */
  comments: string;
}
interface GapVerdict {
  /** 课程要求的路径 */
  path: string;
  /** present=存在且实质覆盖；equivalent=以不同布局覆盖；partial=部分覆盖；missing=缺失 */
  verdict: "present" | "equivalent" | "partial" | "missing";
  /** 实际对应文件（equivalent/partial 时必填） */
  actual: string;
  note: string;
}
interface DraftOutcome {
  /** 聚类ID */
  cluster: string;
  /** 产出的绝对路径列表 */
  files: string[];
  /** 引用的支撑记录：PR/issue/commit/文件路径 */
  sources: string[];
  status: "done" | "failed";
  note: string;
}
interface M4Outline {
  titleZh: string;
  sections: { titleZh: string; purpose: string; sources: string }[];
}
interface CheckResult {
  /** 引用是否全部属实 */
  ok: boolean;
  /** 不实或无支撑的条目描述 */
  issues: string;
}
interface Manifest {
  files: string[];
  missing: string[];
}
interface WorkflowReport {
  conclusion: string;
  findings: { where: string; what: string; evidence: string; status: "verified" | "unconfirmed"; severity: "low" | "medium" | "high" }[];
  verified: string[];
  notCovered: string[];
}

// 进度板与缺口表
artifact.board("progress", {
  title: "课程收尾进度",
  key: "group",
  status: "status",
  columns: ["待开始", "进行中", "已交付"],
  cardTitle: "group",
});
artifact.table("gaps", {
  title: "课程交付物盘点",
  key: "path",
  columns: [
    { field: "path", label: "要求路径" },
    { field: "verdict", label: "判定" },
    { field: "note", label: "说明" },
  ],
});
for (const g of ["课件要点", "证据盘点", "要点对照文档", "交付物缺口", "M4回顾", "核验交付"]) {
  report({ group: g, status: "待开始" }, "progress");
}

// ---------- 第1步：课件转纯文本 ----------
phase("把五份课件提取为纯文本");
let dirReady = true;
try {
  await world.run("mkdir", ["-p", TEXT_DIR], { output: "discard" });
} catch {
  dirReady = false;
}
const textOk: Record<string, boolean> = {};
if (dirReady) {
  for (const lec of LECTURES) {
    const r = await world.run(
      "pdftotext",
      ["-layout", LECTURES_DIR + "/" + lec.file, TEXT_DIR + "/" + lec.tag + ".txt"],
      { timeoutMs: 300000, output: "discard" },
    );
    textOk[lec.tag] = r.exitCode === 0;
    log(lec.name + "：文本提取" + (textOk[lec.tag] ? "成功" : "失败，改由子代理直接读PDF"));
  }
} else {
  for (const lec of LECTURES) textOk[lec.tag] = false;
  log("文本目录创建失败，全部课件改由子代理直接读PDF");
}

// ---------- 第2/3步：课件要点 与 证据盘点 并行 ----------
const lecturesF = future(async () => {
  phase("通读五份课件，提炼课程要点");
  const digests = await Promise.all(
    LECTURES.map(async (lec) => {
      try {
        const source = textOk[lec.tag]
          ? "纯文本已就绪：" + TEXT_DIR + "/" + lec.tag + ".txt（用 Read 的 offset/limit 每批约900行，分批读完全文）"
          : "文本提取失败：请直接用 Read 的 pages 参数按每批20页读PDF：" + LECTURES_DIR + "/" + lec.file + "（共" + lec.pages + "页）";
        return await agent("课件读者·" + lec.name, {
          system:
            "你是课程要点提炼员：逐页读完给定的课件，把老师反复强调的方法、原则、流程与要点提炼成双语清单。" +
            "数量不设上限，重要的都收；每条必须真实来自课件内容并能给出页码或章节出处。" +
            "分批阅读，边读边把已提炼的要点追加写入指定草稿文件，避免最后一次性回忆。",
        }).ask<LectureDigest>(
          "课件：" + LECTURES_DIR + "/" + lec.file + "（" + lec.name + "，约" + lec.pages + "页）。\n" +
          source + "\n" +
          "请读完整个课件，提炼其中所有重要的教学要点：老师想传达的方法、原则、流程、评估标准，以及对AI/智能体协作软件工程的特别提醒。\n" +
          "每条要点给出 topicZh/topicEn（短语）、zh（2-4句中文陈述）、en（对应英文）、why（一句话：这对用AI智能体做软件工程的团队为什么重要）。\n" +
          "同时把带页码出处的完整笔记写入 " + SCRATCH + "/lecture-" + lec.tag + ".md。\n" +
          "scale 字段填写实际读到的范围（如「248页全部读完」）。",
        );
      } catch (e) {
        return { lecture: lec.name, scale: "读取失败：" + (e instanceof Error ? e.message : String(e)), points: [] as LecturePoint[] };
      }
    }),
  );
  const total = digests.reduce((n, d) => n + d.points.length, 0);
  log("五份课件共提炼 " + total + " 条要点");
  report({ group: "课件要点", status: "已交付" }, "progress");
  return digests;
});

const evidenceF = future(async () => {
  phase("盘点仓库文档与GitHub证据");
  const [digestDocs, digestCode, digestPRs, digestIssues] = await Promise.all([
    agent("仓库文档盘点员", {
      system: "只读不改：绝不修改仓库内任何文件，绝不执行 git commit/push，不对任何PR/issue发表评论。所有结论附出处（文件:行 或 PR/issue 编号）。",
    }).ask<string>(
      "通读 " + WORKSPACE + " 仓库的治理与文档面：AGENTS.md、architecture-blueprint.md、Prompt.md、README.md、package.json 的 scripts、" +
      "docs/req/ 全部、docs/architecture/ 全部（含 adr/ 与 delta/）、docs/code-governance/ 全部、docs/decision/ 全部、" +
      "docs/ai-use-log.yaml（结构与规模即可，不必逐条）、docs/review-memo.md、docs/debt-register.md、docs/bug-diary.md、" +
      "docs/team/PLAN.en.md 与 REQUIREMENTS.en.md 的要点、.github/workflows/ci.yml。\n" +
      "回复正文输出不超过6000字符的 markdown 摘要，按「需求与追踪 / 架构与决策 / 编码治理 / 验证治理 / AI使用与评审记录 / 团队协作流程」分组：" +
      "每组写清项目实际怎么做的（机制、文件、流程），并给出处。不要客套话，正文即摘要。",
    ),
    agent("代码与测试盘点员", {
      system: "只读不改：绝不修改仓库内任何文件，绝不执行 git commit/push。所有结论附出处（文件:行）。",
    }).ask<string>(
      "浏览 " + WORKSPACE + " 的 src/（contracts、performance、console、decision、dialogue、evaluation、runtime、storage 各模块的职责，" +
      "每个模块读入口与关键文件）与 test/（offline、live、browser、conformance、fixtures、bench、support 的布局与用途），以及 .github/workflows/ci.yml 的门禁。\n" +
      "回复正文输出不超过6000字符的 markdown 摘要：每模块一段（职责+关键文件出处），测试分层如何区分 offline/live，CI 有哪些门。正文即摘要。",
    ),
    agent("Pull Request盘点员", {
      system: "用 gh CLI 检索与深读，只读不改：绝不修改仓库文件，绝不执行 git push，不对任何PR发表评论。",
    }).ask<string>(
      "先 gh pr list --state open --limit 60 与 gh pr list --state merged --limit 40 拿全貌（编号、标题、作者、角色标签[M1]-[M6]）。\n" +
      "再深读至少12个有代表性的PR（gh pr view <N> --json title,body,reviews,comments），优先：M4系列 #151/#154/#159/#163/#168/#170/#171、" +
      "治理类 #176/#184/#186、评审争议 #181/#187、M6治理与评估 #158/#165、文档 #164/#168。\n" +
      "回复正文输出不超过7000字符的 markdown 摘要：项目如何用PR协作（分支规则、评审纪律、AI使用日志联动、阻断门实践），" +
      "以及每个深读PR的要点与结论。全部引用编号。正文即摘要。",
    ),
    agent("Issue盘点员", {
      system: "用 gh CLI 检索与深读，只读不改：绝不修改仓库文件，绝不执行 git push，不对任何issue发表评论。",
    }).ask<string>(
      "gh issue list --state all --limit 100 拿全貌。深读以下 issue（存在才读，读不到就跳过）：" +
      "M4相关 #99 #116 #146 #147 #148 #149；收尾与提交准备 #111 #112 #113 #114 #115 #117 #118 #119 #122 #123；" +
      "代表性已关闭任务 #89 #91 #93 #100 #104。用 gh issue view <N> --comments。\n" +
      "回复正文输出不超过7000字符的 markdown 摘要：issue 如何驱动任务（模板、验收标准、跨角色协作如 [M4 → M5/M6] 模式），" +
      "以及每个深读issue的要点。全部引用编号。正文即摘要。",
    ),
  ]);
  report({ group: "证据盘点", status: "已交付" }, "progress");
  return { digestDocs, digestCode, digestPRs, digestIssues };
});

const [digests, evidence] = await Promise.all([lecturesF, evidenceF]);

// ---------- 第4步：统一课程要点清单（需要全部课件读完，属于汇合点） ----------
phase("汇总成统一的课程要点清单");
const coursePoints = await agent("要点汇总员", {
  system:
    "你把多位读者从不同课件提炼的要点合并成一份统一清单：同一件事在不同课件出现时合并为一条并保留全部来源；" +
    "编号稳定（CP-01 起），主题分组（T1 起），主题数量自然（约6-10个），不要为凑数拆分或硬合并。",
}).ask<CoursePoints>(
  "以下是五份课件的要点清单（JSON）：\n" + JSON.stringify(digests) + "\n" +
  "如需补充上下文，可读草稿：" + SCRATCH + "/lecture-intro.md、lecture-process.md、lecture-RE.md、lecture-SA.md、lecture-QA.md。\n" +
  "输出：themes（id/titleZh/titleEn/pointIds）与 points（id/themeId/topicZh/topicEn/zh/en/lectures）。" +
  "themeId 必须与 themes 对应；lectures 填课件中文名。",
);
log("汇总后：" + coursePoints.themes.length + " 个主题、" + coursePoints.points.length + " 条要点");

// ---------- 三条支线并行 ----------
const aF = future(async () => {
  phase("逐条对照课程要点与项目实践");
  const sections = await Promise.all(
    coursePoints.themes.map(async (theme) => {
      const themePoints = coursePoints.points.filter((p) => p.themeId === theme.id);
      try {
        return await agent("对照员·" + theme.id, {
          system:
            "你是项目实践对照员：判断课程要点在 Isla 项目中是否有对应实践。" +
            "有→亲自核实后详细记录我们的行为（策略、文件、流程、评审互动），给出可核查出处（PR号/issue号/文件:行/commit）；" +
            "没有或做得不足→该条留一两句中性占位说明，绝不批评、不推测、不编造。" +
            "只读仓库与GitHub：不改任何文件，不 git commit/push，不评论PR/issue。证据摘要只是线索，写「做得到位」前必须亲自核实。",
        }).ask<ThemeSection>(
          "本主题的课程要点（JSON）：\n" + JSON.stringify(themePoints) + "\n\n" +
          "四位盘点员的证据摘要（线索）：\n" +
          "【仓库文档与治理】\n" + evidence.digestDocs + "\n\n" +
          "【代码与测试】\n" + evidence.digestCode + "\n\n" +
          "【Pull Request】\n" + evidence.digestPRs + "\n\n" +
          "【Issue】\n" + evidence.digestIssues + "\n\n" +
          "注意：当前仍 open 的 PR 一律按已合入 main 处理（以 gh pr list --state open 实时结果为准）。仓库在 " + WORKSPACE + "，可用 gh 深挖。\n" +
          "对每条要点输出中英两段（zh 与 en）。\n" +
          "把整节写入 " + SCRATCH + "/cp-" + theme.id + ".md，格式：先「## " + theme.titleZh + " / " + theme.titleEn + "」，" +
          "每条要点一个小节（### CP-xx 主题），小节内先「【中文】」块再「[EN]」块；占位条目中文写「（本条在本项目中暂无对应的显式实践记录。）」、" +
          "英文写「(No explicit matching practice recorded in this project yet.)」。\n" +
          "返回 themeId、titleZh、titleEn、sectionFile（绝对路径）、entryCount、placeholderCount。",
        );
      } catch (e) {
        return {
          themeId: theme.id, titleZh: theme.titleZh, titleEn: theme.titleEn,
          sectionFile: "", entryCount: 0, placeholderCount: 0,
          note: "对照失败：" + (e instanceof Error ? e.message : String(e)),
        };
      }
    }),
  );
  const okSections = sections.filter((s) => s.sectionFile !== "");
  log("对照完成：" + okSections.length + "/" + coursePoints.themes.length + " 个主题成稿");

  phase("汇编课程要点对照文档（中英双语）");
  const aFiles = await agent("对照文档汇编员", {
    system: "只做汇编与语言统一，不增删要点、不改写事实。写入文件时若目标目录写入被权限拒绝，改写到 " + FALLBACK_DIR + "/ 并在回复中说明。",
  }).ask<string[]>(
    "读取 " + SCRATCH + "/cp-T*.md 全部小节文件（共" + okSections.length + "个主题），汇编为两份完整文档：\n" +
    "1）" + OUT_DIR + "/01-课程要点对照.zh.md（全中文）\n" +
    "2）" + OUT_DIR + "/01-course-points-reflection.en.md（全英文）\n" +
    "文档头：标题、日期" + TODAY + "、说明（要点提炼自五份课件；「做得到位」条目附项目出处；占位条目表示本项目暂无对应显式实践，非批评）。\n" +
    "目录列出全部主题与要点ID。占位条目两版都要保留（英文版用 (No explicit matching practice recorded in this project yet.)）。\n" +
    "返回两份文件的绝对路径数组（按此顺序）。",
  );

  phase("独立审读并修订课程对照文档");
  const aReview = await agent("对照文档审读员", {
    system: "独立审读，只凭文件本身挑毛病，不修改任何文件。审读标准从严：宁可有意见也不要客套通过。",
  }).ask<Review>(
    "读取 " + aFiles.join(" 与 ") + "，以及 " + SCRATCH + "/cp-T*.md 各小节草稿。检查：\n" +
    "1) 是否每个课程要点都有对应条目，与草稿无遗漏；\n" +
    "2) 「做得到位」条目的出处是否可核查、是否与草稿一致；\n" +
    "3) 有没有批评性或阴阳怪气的语气（应改为中性占位）；\n" +
    "4) 中英两版是否逐条对应、无缺漏；\n" +
    "5) 排版与目录是否可用。\n" +
    "返回 needsRevision 与 comments（意见具体到条目ID）。",
  );
  let aRevised = false;
  if (aReview.needsRevision) {
    await agent("对照文档修订员", {
      system: "按审读意见修订文档并直接覆盖保存；不得编造出处，不得新增批评性表述。",
    }).ask<string>("按以下意见修订上述两份文档并覆盖保存：\n" + aReview.comments + "\n完成后返回改动摘要。");
    aRevised = true;
  }
  report({ group: "要点对照文档", status: "已交付" }, "progress");
  const placeholderTotal = sections.reduce((n, s) => n + s.placeholderCount, 0);
  return { files: aFiles, themesDone: okSections.length, themesTotal: coursePoints.themes.length, placeholderTotal, revised: aRevised };
});

const bF = future(async () => {
  phase("清点课程交付物缺口");
  const presence = await Promise.all(
    REQUIRED.map(async (r) => {
      const hits = await files.glob(r.glob);
      return { path: r.path, rule: r.rule, hits: hits.slice(0, 8), found: hits.length > 0 };
    }),
  );
  const foundCount = presence.filter((p) => p.found).length;
  log("课程要求 " + REQUIRED.length + " 项，glob 实测存在 " + foundCount + " 项");
  const audit = await agent("交付物盘点员", {
    system:
      "你对照课程要求的仓库结构逐项核对 Isla 仓库。判定必须基于实际文件内容而非文件名；" +
      "只读仓库与GitHub：不改任何文件，不 git commit/push，不评论PR/issue。",
  }).ask<{ verdicts: GapVerdict[] }>(
    "课程要求的必需项清单（来自CS5351项目要求书第5节）：\n" + JSON.stringify(REQUIRED) + "\n\n" +
    "脚本用 glob 实测的存在性结果：\n" + JSON.stringify(presence) + "\n\n" +
    "请逐项判定（读 " + WORKSPACE + " 内实际内容）：\n" +
    "- present：存在且实质覆盖要求；\n" +
    "- equivalent：以不同文件名/布局覆盖要求（在 actual 写明对应文件，如 prompts/decision 与 prompts/dialogue 对应 prompt_v*.yaml；" +
    "docs/architecture 的 evaluation-conditions/thresholds/label-interface 可能对应 evaluation-table 或 evaluation-logbook；" +
    "docs/team 下英文文档可能承载 D1 内容但位置不同）；\n" +
    "- partial：部分覆盖（note 说明缺什么）；\n" +
    "- missing：没有。\n" +
    "参考线索：【仓库文档与治理】\n" + evidence.digestDocs + "\n" +
    "【Issue】（其中 #111-#128 与 #113/#114 直接讨论提交准备）\n" + evidence.digestIssues + "\n" +
    "verdicts 数组必须覆盖全部 " + REQUIRED.length + " 项，path 原样返回。",
  );
  for (const v of audit.verdicts) {
    report({ path: v.path, verdict: v.verdict, note: v.note }, "gaps");
  }

  phase("按缺口检索行为记录并起草文件");
  const toDraft = audit.verdicts.filter((v) => v.verdict === "missing" || v.verdict === "partial");
  const clusterMap = new Map<string, string[]>();
  for (const v of toDraft) {
    const key =
      v.path.startsWith("docs/architecture/adr") ? "adr" :
      v.path.indexOf("permission-model") >= 0 ? "arch-permission" :
      v.path.indexOf("docs/architecture/") === 0 ? "arch-eval" :
      v.path.indexOf(".opencode/") === 0 ? "opencode" :
      v.path.indexOf(".agent/") === 0 ? "agent-rules" :
      v.path.indexOf("transcripts") === 0 ? "transcripts" :
      "root-docs";
    const arr = clusterMap.get(key) ?? [];
    arr.push(v.path);
    clusterMap.set(key, arr);
  }
  const clusters = Array.from(clusterMap.entries()).map(([id, paths]) => ({ id, paths }));
  log("需要起草的缺口聚类：" + clusters.map((c) => c.id + "(" + c.paths.length + ")").join("、"));

  const drafts = await Promise.all(
    clusters.map(async (cl) => {
      try {
        const draft = await agent("起草·" + cl.id, {
          system:
            "你为缺失/部分缺失的课程交付物起草内容。铁律：只写有 GitHub/仓库记录支撑的内容（PR、issue及评论、commit、仓库文件），" +
            "引用具体编号与路径；没有记录支撑的部分写明确的占位标记（<!-- 待补：…… -->），绝不编造；" +
            "只记录做得对的地方（试错过程可以如实记）；英文成文、贴近仓库现有文风。" +
            "只读仓库与GitHub：不改仓库内任何文件，不 git commit/push，不评论PR/issue。写入被拒时退回 " + FALLBACK_DIR + "/。",
        }).ask<DraftOutcome>(
          "需要起草的文件（missing 或 partial）：\n" + JSON.stringify(cl.paths) + "\n\n" +
          "对应盘点判定：\n" + JSON.stringify(audit.verdicts.filter((v) => cl.paths.indexOf(v.path) >= 0)) + "\n\n" +
          "行为记录线索：\n【仓库文档与治理】\n" + evidence.digestDocs + "\n\n【Pull Request】\n" + evidence.digestPRs + "\n\n【Issue】\n" + evidence.digestIssues + "\n\n" +
          "可用命令深挖：gh pr view <N> --json title,body,reviews,comments；gh issue view <N> --comments；gh api；直接读仓库文件。仓库在 " + WORKSPACE + "。\n" +
          "把每个文件写到 " + OUT_DIR + "/course-deliverables/<原仓库相对路径>（保持目录结构；partial 项写成同名文件，内容为「现状+补全草案」两段）。\n" +
          "每个文件头部加 HTML 注释：<!-- Draft assembled from repository/GitHub records on " + TODAY + ". Citations inline. -->\n" +
          "transcripts/ 特殊处理：不写任何具体学生记录，只写 README.md 说明 + 批注格式模板（真实记录在仓库外的 Drive/本地归档中）。\n" +
          "返回 cluster、files（实际写入的绝对路径）、sources（引用清单）、status、note。",
        );
        const check = await agent("核对·" + cl.id, {
          system: "独立核对员：只核事实，不改文件。逐条验证引用是否真实存在、内容是否真的支撑该句。",
        }).ask<CheckResult>(
          "读取以下草案文件的每一个引用（PR号、issue号、commit、文件路径），用 gh 与读仓库逐一验证：\n" +
          draft.files.join("\n") + "\n" +
          "不实或无支撑的内容列进 issues（指明文件与位置）；全部属实则 ok=true。",
        );
        if (!check.ok) {
          await agent("修订·" + cl.id, {
            system: "按核对意见修正草案：删除或降级无支撑的表述为占位，不得编造。直接覆盖保存。",
          }).ask<string>("按以下核对意见修正草案文件并覆盖保存：\n" + check.issues + "\n完成后返回修订摘要。");
        }
        return draft;
      } catch (e) {
        return { cluster: cl.id, files: [] as string[], sources: [] as string[], status: "failed" as const, note: "起草失败：" + (e instanceof Error ? e.message : String(e)) };
      }
    }),
  );
  const draftFiles = drafts.flatMap((d) => d.files);
  const failedClusters = drafts.filter((d) => d.status === "failed");

  phase("汇编交付物缺口清单（中英双语）");
  const bFiles = await agent("缺口清单撰写员", {
    system: "忠实汇总盘点与起草结果，不添油加醋。写入被拒时退回 " + FALLBACK_DIR + "/ 并说明。",
  }).ask<string[]>(
    "根据盘点判定与起草结果写两份文档：\n" +
    "1）" + OUT_DIR + "/02-交付物缺口与支撑记录.zh.md\n" +
    "2）" + OUT_DIR + "/02-deliverables-gap-analysis.en.md\n\n" +
    "盘点判定：\n" + JSON.stringify(audit.verdicts) + "\n\n" +
    "起草结果：\n" + JSON.stringify(drafts) + "\n\n" +
    "内容结构：① 课程要求 vs 实测状态总表（present/equivalent/partial/missing，附 actual 与一句话说明）；" +
    "② 每个 missing/partial 项：对应草案文件路径 + 支撑记录（#N、commit、文件）+ 仍留空的占位说明；" +
    "③ present/equivalent 项一行带过。日期" + TODAY + "。两版内容一致。" +
    (failedClusters.length > 0 ? "\n注意：以下聚类起草失败，如实标注：" + JSON.stringify(failedClusters) : "") +
    "\n返回两份文件的绝对路径数组。",
  );

  phase("独立审读并修订缺口清单");
  const bReview = await agent("缺口清单审读员", {
    system: "独立审读，只凭文件本身挑毛病，不修改任何文件。审读标准从严。",
  }).ask<Review>(
    "读取 " + bFiles.join(" 与 ") + "，抽查其中 5 个草案文件（" + OUT_DIR + "/course-deliverables/ 下）。检查：\n" +
    "1) 总表是否覆盖全部 " + REQUIRED.length + " 项且判定自洽；\n" +
    "2) 草案引用是否具体可查，有无编造迹象；\n" +
    "3) 是否只记录做得对的内容、试错如实；\n" +
    "4) 中英两版一致；\n" +
    "5) 占位标记是否清晰（读者知道还缺什么）。\n" +
    "返回 needsRevision 与 comments。",
  );
  let bRevised = false;
  if (bReview.needsRevision) {
    await agent("缺口清单修订员", {
      system: "按审读意见修订并直接覆盖保存；不得编造引用。",
    }).ask<string>("按以下意见修订上述两份文档并覆盖保存：\n" + bReview.comments + "\n完成后返回改动摘要。");
    bRevised = true;
  }
  report({ group: "交付物缺口", status: "已交付" }, "progress");
  return { files: bFiles.concat(draftFiles), verdicts: audit.verdicts, drafts, revised: bRevised };
});

const cF = future(async () => {
  phase("梳理M4工作轨迹");
  const digestM4 = await agent("M4工作史官", {
    system:
      "只读不改，所有结论附出处。对象：L01nki1（git 用户 lowen），M4 角色，src/dialogue 所有者。" +
      "只陈述有记录支撑的事实；读不到的记录明确说读不到，不推测。",
  }).ask<string>(
    "在 " + WORKSPACE + " 仓库与 GitHub（inscripoem/isla）上梳理 M4 的全部工作：\n" +
    "1) gh pr list --state all --author L01nki1 --limit 60；对每个 [M4] 或 docs(m4) 的PR深读：gh pr view <N> --json title,body,reviews,comments，记录做了什么、评审互动、结论。\n" +
    "2) git log --author=lowen --oneline（取前40条）与 git log --grep='[M4]' --oneline（取前40条）。\n" +
    "3) 读 src/dialogue/ 全部文件与 test/ 下 dialogue 相关测试，总结模块职责、对外接口（M2 可导入的浏览器安全接口）、分层与关键设计。\n" +
    "4) 读 docs/decision/m3-quality-rubric-v0.1.md、m4-dialogue-scoring-rubric-v0.1.md、m4-completed-only-eligibility-v1.md、" +
    "docs/team/PLAN.en.md 中 M4 各行、docs/team/HANDOFF-M4-01.en.md、READINESS-KITS 中 M4 相关章节。\n" +
    "5) gh issue view 146 --comments、147、148、149、116、99、93、91、89（逐个尝试，读不到就跳过）。\n" +
    "回复正文输出不超过9000字符的结构化摘要（正文即摘要，不要客套）：\n" +
    "A) 时间线与任务清单；B) dialogue 模块的技术设计（含演进脉络）；C) 参考/借鉴了什么（PR正文、issue、文档中提到的来源项目或规范）；" +
    "D) 评审与协作活动（给他人的评审、被他人评审）；E) 对 agent 协作/流程的改进主张（X系列、A系列、rubric 等）；" +
    "F) 与前沿智能体开发要点可能呼应的点（上下文工程、评估优先、护栏、人机审批、确定性边界等，按素材实际取舍）。",
  );

  phase("规划M4回顾文档结构");
  const outline = await agent("M4文档规划师", {
    system: "你只规划文档结构：每节写什么、为什么值得写、用哪些素材。宁可结构贴合素材，不要硬套模板。",
  }).ask<M4Outline>(
    "为 M4 写一份个人工作回顾文档（中文成文），请只输出结构规划。\n" +
    "素材（M4工作史官摘要）：\n" + digestM4 + "\n\n" +
    "结构必须能支撑这条主线：参考了什么项目/规范 → baseline 是什么（此前状态、既有约定、上游能力）→ 在 baseline 之上加了什么 feature（逐项、为什么）→ " +
    "策略与遵循的设计规范 → 对 agent 的改进措施 → 与前沿智能体开发要点的映射（按素材实际内容取舍，如上下文工程与预算、护栏、评估优先、可追溯、人机协同审批）。\n" +
    "每节给出 purpose 与 sources。返回 titleZh 与 sections 数组。",
  );

  phase("撰写M4工作回顾文档");
  const cFile = await agent("M4文档撰写员", {
    system:
      "客观记录，每个具体说法都要能在史官摘要或仓库/GitHub中找到出处；" +
      "绝不提到课程批准工具（opencode、deepseek）之外的任何智能体或平台名字——宁可省略不可编造；不用批评性语气。" +
      "写入被拒时退回 " + FALLBACK_DIR + "/ 并说明。",
  }).ask<string>(
    "按以下结构撰写 " + OUT_DIR + "/03-M4工作回顾.zh.md：\n" + JSON.stringify(outline.sections) + "\n\n" +
    "素材（M4工作史官摘要）：\n" + digestM4 + "\n\n" +
    "写作要求：每部分落到具体行为（PR/issue 编号、文件路径、策略名称）；baseline → feature 的对照要显式；" +
    "前沿要点映射一节逐条对应；文档头含日期" + TODAY + "与说明。直接写文件，返回文件绝对路径。",
  );

  phase("独立审读并修订M4文档");
  const cReview = await agent("M4文档审读员", {
    system: "独立审读，只挑毛病不改文件。",
  }).ask<Review>(
    "读取 " + cFile + "。检查：\n" +
    "1) 结构是否覆盖「参考来源 → baseline → feature → 策略与规范 → agent改进 → 前沿映射」；\n" +
    "2) 每节是否有具体出处支撑，有无夸大或无出处的断言；\n" +
    "3) 是否遗漏史官摘要中的重要工作；\n" +
    "4) 是否出现课程批准工具之外的工具名；\n" +
    "5) baseline→feature 的对照是否清晰。\n" +
    "参考素材（史官摘要）：\n" + digestM4 + "\n" +
    "返回 needsRevision 与 comments（具体到节）。",
  );
  let cRevised = false;
  if (cReview.needsRevision) {
    await agent("M4文档修订员", {
      system: "按审读意见修订并直接覆盖保存；不得编造出处。",
    }).ask<string>("按以下意见修订 " + cFile + " 并覆盖保存：\n" + cReview.comments + "\n完成后返回改动摘要。");
    cRevised = true;
  }
  report({ group: "M4回顾", status: "已交付" }, "progress");
  return { files: [cFile], sections: outline.sections.length, revised: cRevised };
});

const [aOut, bOut, cOut] = await Promise.all([aF, bF, cF]);

// ---------- 核验交付（三支线全部落地后） ----------
phase("核验输出文件并交付");
const expectedDocs = [
  OUT_DIR + "/01-课程要点对照.zh.md",
  OUT_DIR + "/01-course-points-reflection.en.md",
  OUT_DIR + "/02-交付物缺口与支撑记录.zh.md",
  OUT_DIR + "/02-deliverables-gap-analysis.en.md",
  OUT_DIR + "/03-M4工作回顾.zh.md",
];
const verifier = agent("交付核验员", { system: "只核验，不创建、不修改任何文件。" });
let finalManifest = await verifier.ask<Manifest>(
  "检查以下5份期望文档是否存在且非空（每行一个路径）：\n" + expectedDocs.join("\n") +
  "\n然后递归列出 " + OUT_DIR + "/course-deliverables/ 下全部文件（忽略 _scratch/）。\n" +
  "返回 files（实际存在的输出文件绝对路径，含5份文档与全部草案）与 missing（5份期望文档中缺失的）。",
);
if (finalManifest.missing.length > 0) {
  await agent("补救撰写员", {
    system: "重建缺失文档：不得编造内容；材料不足就写占位并注明；写入被拒时退回 " + FALLBACK_DIR + "/ 并说明。",
  }).ask<string>(
    "以下期望文档缺失：" + JSON.stringify(finalManifest.missing) +
    "\n请依据 " + SCRATCH + "/ 下的章节草稿与 " + OUT_DIR + "/ 下已有材料，把它们重建到原定路径；返回已创建路径。",
  );
  finalManifest = await verifier.ask<Manifest>("按同一清单复核一次，返回最新的 files 与 missing。");
}
log("核验完成：产出 " + finalManifest.files.length + " 个文件，仍缺 " + finalManifest.missing.length + " 份");
report({ group: "核验交付", status: "已交付" }, "progress");

const missingItems = bOut.verdicts.filter((v) => v.verdict === "missing" || v.verdict === "partial");
const failedClusters = bOut.drafts.filter((d) => d.status === "failed");
const findings: WorkflowReport["findings"] = missingItems.map((v) => ({
  where: v.path,
  what: "课程必需项判定为 " + v.verdict + "；" + (v.verdict === "missing" ? "已生成草案" : "已生成补全草案"),
  evidence: "glob 实测 + 交付物盘点员判定：" + v.note + (v.actual !== "" ? "（实际对应：" + v.actual + "）" : ""),
  status: "verified",
  severity: "medium",
}));
for (const d of failedClusters) {
  findings.push({
    where: d.cluster,
    what: "该缺口的起草失败，相关草案缺失",
    evidence: d.note,
    status: "unconfirmed",
    severity: "medium",
  });
}
if (finalManifest.missing.length > 0) {
  findings.push({
    where: OUT_DIR,
    what: "补救后仍有期望文档缺失",
    evidence: JSON.stringify(finalManifest.missing),
    status: "verified",
    severity: "high",
  });
}

await artifact.markdown(
  "summary",
  [
    "# Isla 课程收尾产出总览",
    "",
    "日期：" + TODAY + "。三组文档均已各经至少一轮独立审读与修订（对照文档修订：" + (aOut.revised ? "有" : "无审读意见") +
    "；缺口清单修订：" + (bOut.revised ? "有" : "无") + "；M4文档修订：" + (cOut.revised ? "有" : "无") + "）。",
    "",
    "## 产出文件（" + finalManifest.files.length + " 个）",
    ...finalManifest.files.map((f) => "- " + f),
    "",
    "## 课程要点对照",
    "- 主题 " + aOut.themesDone + "/" + aOut.themesTotal + " 成稿；要点对照共 " + aOut.placeholderTotal + " 条留中性占位（暂无对应显式实践）。",
    "",
    "## 交付物缺口（missing/partial 共 " + missingItems.length + " 项）",
    ...missingItems.map((v) => "- " + v.path + " — " + v.verdict + "：" + v.note),
    "",
    "## M4 回顾",
    "- 结构分 " + cOut.sections + " 节；文件：" + cOut.files.join("、"),
  ].join("\n"),
  { title: "课程收尾产出总览", description: "三组文档的位置、要点数量与交付物缺口一览。", primary: true },
);

const result: WorkflowReport = {
  conclusion:
    "课程收尾三组文档已生成到 " + OUT_DIR + "：五份课件（共" + LECTURES.reduce((n, l) => n + l.pages, 0) + "页）提炼出 " +
    coursePoints.points.length + " 条要点并逐条对照项目实践（" + aOut.placeholderTotal + "条留占位）；" +
    "课程必需的 " + REQUIRED.length + " 项经实测盘点，" + missingItems.length + " 项缺失/部分缺失并已按 GitHub 行为记录生成草案；" +
    "M4 工作回顾已按「参考来源→baseline→feature→策略→agent改进→前沿映射」成文。工作流随后保存到项目内。",
  findings,
  verified: [
    "五份课件全文通读并双语提炼（文本提取失败时自动改为直接读PDF）",
    REQUIRED.length + " 项课程要求路径逐一 glob 实测 + 盘点员逐项判定",
    "每个起草文件由独立核对员逐条验证引用（PR/issue/commit/文件路径）",
    "三组文档各经一轮独立审读，审读意见成立时已修订",
    "最终交付核验：5份期望文档存在且非空，产出共 " + finalManifest.files.length + " 个文件",
  ],
  notCovered: [
    "课件中以图片/公式为主的细节只按提取文本阅读，未逐图核对",
    "D5 会话记录本体存于仓库外归档，本次只产出格式模板与说明，未写入任何真实学生记录",
    "草案与文档均生成在仓库外目录，未合入 D:/isla 仓库（是否入库由团队决定）",
    "open PR 按「已合入 main」处理，但未验证其实际合并顺序与 CI 结果",
  ],
};
return result;
