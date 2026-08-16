# Hook 说明书（`template/hook/`）

这一目录是“可复用锚定套壳”的全部插件。生成器
`tools/make-anchored-preset.mjs` 会把需要的文件复制进目标 preset，并把对应
行插到目标 `agent.cordis.yml` 的第一行 entry 之前。这个文件回答两个问题：

1. 这套 hook 支持哪些**模式**；
2. 每个 hook 的**职责、配置键、适用模式**。

## 模式总览

| 模式 | 生成器入口 | 钩子组合 | 首模型请求 | 晋升信号 | 子代理 |
|---|---|---|---|---|---|
| anchored（默认） | 默认 | `tool-bootstrap` + 伴生 hooks | `bash + str_replace_editor`（Minimal 真实工具对） | 首个持久 `tool/call` 或 `assistant/message`（`promoteOn` 可配） | 默认直接 resident；`--bootstrap-subagents` 反转 |
| whoami | `--whoami` | `anchor-turn` + `zero-tool-bootstrap` + 伴生 hooks | 0 工具 + `anchor-turn` 文本 `你是谁` | anchor 回复（`assistant/message`） | 继承 anchor（`includeSubagents: true`） |
| zero-anchor | 尚未暴露 CLI，同一组 hook 可用 `buildAnchorRows` 组合 | 同 whoami | 0 工具 + `anchor-turn` 默认测试句 | anchor 回复（`assistant/message`） | 默认跳过（`includeSubagents: false`） |

三种模式的共同后半段完全一样：晋升后都是 **resident 目录** = bootstrap 工具对
（或 shell 组）+ `dev_tool_search` / `skill_search` / `skill_load` + 模型显式
解锁过的工具；`compaction/end` 后按 epoch 回落到 bootstrap + `compactionTools`，
等边界之后出现新晋升信号再回到 resident。**不是**全量 Standard 目录 dump。

## 模式详解

### anchored（默认，对应上游 `preset/`）

- `tool-bootstrap.mjs` 是第一行插件：首请求只留 Minimal 工具对并剥离自动注入
  的 AGENTS.md / skill-catalog 消息；晋升后收窄到 resident；compaction 后回落。
- 伴生 hooks 全部挂上：`instruction-hint`、`dev-tool-search`、`skill-search`、
  `custom-bash`（Windows 上真实可跑的 `bash`）、`compaction-epoch`（共享状态机）。
- 适合“想要 Minimal 首链，但后续保留 Standard 能力”的常规 preset 套壳。

### whoami（对应上游 `whoami-standard/`）

- 不再挂 `tool-bootstrap.mjs`，改挂 `anchor-turn.mjs` + `zero-tool-bootstrap.mjs`：
  第一条真实用户消息被 `anchor-turn` 在 inbox 里 prepend 一条 `你是谁`，
  `zero-tool-bootstrap` 把这条 anchor 请求的工具面清成 **0 工具**；
- anchor 回复持久化后晋升，用户真实消息在下一轮用 resident 目录执行；
- 子代理继承同一 anchor 流程（两行的 `includeSubagents: true`）。

### zero-anchor（对应上游 `zero-anchored-standard/`）

- 与 whoami 完全同一组 hook；唯一区别是 `anchor-turn` 的 `text` 用插件默认的
  固定测试句，并且两行的 `includeSubagents` 为 `false`（子代理直接 resident）。
- hook 本身已支持这种组合；生成器目前没有 `--zero-anchor` 开关，如需要可用
  `buildAnchorRows({ text: <默认测试句>, includeSubagents: false })` 手工渲染。

## 每个 hook 的职责与配置

| Hook | 职责 | 适用模式 | 配置键 |
|---|---|---|---|
| `tool-bootstrap.mjs` | 主门控：首请求 Minimal 工具对、晋升到 resident、compaction epoch、上下文剥离、可选首请求 cap | anchored | `bootstrapTools`（必填非空）、`promoteOn`（`either`/`tool-call`/`assistant-message`）、`bootstrapMaxTokens`（可选）、`suppressedContextSources`、`compactionTools`、本地扩展：`suppressedContextPlugins`、`bootstrapPersonaText`、`delegationDepthExempt` |
| `zero-tool-bootstrap.mjs` | 零工具版门控：anchor 回合清空工具面，anchor 回复晋升到 resident，compaction epoch | whoami / zero-anchor | `suppressedContextSources`、`compactionTools`、`includeSubagents`；本地扩展：`suppressedContextPlugins`、`bootstrapPersonaText` |
| `anchor-turn.mjs` | 在第一条用户消息前 prepend 一条 anchor；文本可配置，决定 whoami / zero 口味 | whoami / zero-anchor | `text`（默认：zero-anchor 固定测试句）、`includeSubagents` |
| `compaction-epoch.mjs` | epoch-aware 晋升状态机：`compaction/end` 后只认边界之后的新晋升信号；session 级 memo 化，重载安全 | 所有模式（被上面两个门控 import） | 无（通过 `createEpochPromotion(events, options)` 使用） |
| `instruction-hint.mjs` | 晋升后一次性注入“这些 instruction 文件存在，先读再动手”的短提示，替代全量 AGENTS.md 摘要 | 所有模式 | `promoteOn`（必须与所在模式的晋升语义一致：anchored=`either`，whoami/zero=`assistant-message`） |
| `dev-tool-search.mjs` | `dev_tool_search` 工具：列出/搜索完整可解锁目录，按精确名解锁；解锁名从持久 `tool/call` 推导，重载安全 | 所有模式 | 无（模型侧参数：`query` 可选，`toolNames` 可选） |
| `skill-search.mjs` | `skill_search` / `skill_load` 两个工具，替代完整技能目录注入 | 所有模式 | 无 |
| `custom-bash.mjs` | Windows 可用的 `bash` 工具：与官方持久 bash 同名同描述风格，但走普通子进程 seam 而非 PTY | 所有模式（Windows 专用，非 win32 应 disabled） | `bashPath`（默认 `bash`；生成器默认写 Git Bash 路径）、`timeoutMs`、`maxOutputBytes` |

## 生成器的组合规则

- anchored：复制 `tool-bootstrap` + 全部伴生 hooks，插入 `tool-bootstrap` 行。
- `--whoami`：不复制 `tool-bootstrap`，改复制 `anchor-turn` + `zero-tool-bootstrap`
  以及伴生 hooks，插入 `zero-tool-bootstrap` + `anchor-turn` 两行。
- 无论哪种模式，`agent.cordis.yml` 里这些行都保持在**第一行 entry 之前**（顺序
  契约决定 pre-step 剥离是 waterfall 的最后一层）。
- 源 preset 已挂 `tool-bootstrap` / `zero-tool-bootstrap` 时生成器 fail loud，
  拒绝二次套壳。

## 与上游的同步映射

| 上游位置 | 这里的 hook |
|---|---|
| `preset/tool-bootstrap.mjs` | `tool-bootstrap.mjs`（本地为超集：persona 永久收敛 + 逐请求插件剥离 + 子代理豁免开关） |
| `preset/{compaction-epoch,custom-bash,dev-tool-search,instruction-hint,skill-search}.mjs` | 同名文件（`dev-tool-search` 本地为增强版：全目录列表、多词 OR 评分、unknown 名回显） |
| `shared/anchor-turn.mjs` | `anchor-turn.mjs`（与上游逐字节一致） |
| `shared/zero-tool-bootstrap.mjs` | `zero-tool-bootstrap.mjs`（本地为超集，import 已改 `./compaction-epoch.mjs`） |

> 上游把 `whoami-turn` 改名为通用 `anchor-turn` 后，本目录已同步跟进；模板里不再有
> `whoami-turn` 这个插件名。生成器层面 whoami 仍是一个**模式名**，但它现在由
> `anchor-turn(text: 你是谁)` 实现。
