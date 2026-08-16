# Hook 说明书（`template/hook/`）

这一目录是“可复用锚定套壳”的全部插件。生成器
`tools/make-anchored-preset.mjs` 会把需要的文件复制进目标 preset，并把
`anchor-bootstrap` 行插到目标 `agent.cordis.yml` 的第一行 entry 之前。

当前版本是**合并后单 gate 形态**：旧的 `tool-bootstrap.mjs`、
`zero-tool-bootstrap.mjs`、`anchor-turn.mjs` 三个下游 hook 已被删除，统一为
`anchor-bootstrap.mjs`。上游自有副本（`shared/`、三个上游 mode 目录）仍按
上游同步管理，不在这里维护。

## 安装方式

```pwsh
# 新 id：从源 preset 复制并套壳
node tools/make-anchored-preset.mjs --from <source> --to <new-id> --mode zero

# 原位 patch：保留当前 id，直接改 agent.cordis.yml 并写 HOOK-INSTALL.md
node tools/patch-preset-in-place.mjs --target <preset-dir> --mode zero --name '<display-name>'
```

装完后**完全重启 DSH**；standing mount 不会回收旧代际。

## 模式总览

| mode | `firstTurnTools` | `anchorText` | `subagents` | 首模型请求 | 晋升信号 |
|---|---|---|---|---|---|
| `anchored` | `minimal` | `none` | `resident`（或 `bootstrap`） | `bash + str_replace_editor` | 首个持久 `tool/call` 或 `assistant/message`（`promoteOn` 可配） |
| `zero` | `empty` | `test-notice` | `resident` | 0 工具 + 固定测试句 | anchor 回复（`assistant/message`） |
| `whoami` | `empty` | `whoami` | `anchor` | 0 工具 + `你是谁` | anchor 回复（`assistant/message`） |

共同后半段：晋升后都是 **resident 目录** = 模式基集 + `dev_tool_search` /
`skill_search` / `skill_load` + 模型显式解锁的工具；`compaction/end` 后按
epoch 回落到模式基集 + `compactionTools`，等边界之后的新晋升信号。

## 每个 hook 的职责与配置

### `anchor-bootstrap.mjs`（唯一 gate，所有模式）

职责：

- 模式 profile 校验（`mode` 与 `firstTurnTools` / `anchorText` /
  `subagents` 冲突 fail loud）；
- 首请求工具门：`minimal` → `bootstrapTools`；`empty` → `[]`；
- anchor turn 注入：`anchorText != none` 时在用户第一条真实消息前 prepend
  合成 user 消息；
- 晋升状态机：`compaction-epoch` 的事件驱动 `(boundary, promoted)`；
- resident 目录：`minimal` 基集 = `bootstrapTools`；`empty` 基集 = shells +
  `str_replace_editor`；再加三个发现工具与已解锁工具；
- persona：**永久 Minimal 原句**（`You are a helpful software engineer assistant.`），
  不写任何 reasoning 风格指令——轨迹由条件间接选择（干净 persona + 首请求工具面 +
  无注入 context），而不是让模型照着说；工具解锁/专用工具指引由
  `instruction-hint.mjs` 在晋升后以 user 消息注入，不进 system persona；
- context 过滤：受控期剥 `suppressedContextSources`；每请求剥
  `suppressedContextPlugins`；
- 可选 cap：受控期注入 `bootstrapMaxTokens`，晋升后显式剥掉；
- 子代理策略：`subagents: resident | bootstrap | anchor`。

配置键：

```yaml
mode: anchored | zero | whoami          # 默认 anchored
firstTurnTools: empty | minimal
anchorText: none | test-notice | whoami
subagents: resident | bootstrap | anchor
bootstrapTools: [bash, str_replace_editor]  # 仅 minimal
promoteOn: either | tool-call | assistant-message  # anchor 模式固定 assistant-message
bootstrapMaxTokens: <positive int | 省略>      # 全模式 opt-in
suppressedContextSources: [agent-instructions, skill-catalog]
suppressedContextPlugins: ['@deepseek-ai/dsh-system-prompt']
controlledPersonaText: "base + We-need opener"
personaText: "base + opener + unlock 指引 + 工具偏好"
compactionTools: [read, write, edit, glob, grep, todo_write, ask_user_question]
```

`anchorText` 当前文本：

- `test-notice`：`This round is a test. Tools are not open yet; all tools will open next round.`
- `whoami`：`你是谁`
- `none`：不挂 anchor 注入。

### `compaction-epoch.mjs`

- epoch-aware 晋升跟踪器：`compaction/end` 后只认边界之后的新晋升信号；
- session 级 memo 化，重载安全；
- 被 `anchor-bootstrap.mjs` 与 `instruction-hint.mjs` 共用；
- 无直接配置；由 `createEpochPromotion(promoteEvents, { includeSubagents })`
  使用。

### `instruction-hint.mjs`

- 晋升后一次性注入 user 消息：instruction 文件存在提示（若有）+ **工具指引**
  （动 bash / str_replace_editor 前先 `dev_tool_search` 找专用工具并优先使用；
  找不到工具时先解锁）；
- 配置 `promoteOn`：anchored 与 gate 的 `promoteOn` 一致；zero/whoami 为
  `assistant-message`。

### `dev-tool-search.mjs`（本地增强版）

- `dev_tool_search`：列出/搜索完整目录，按精确名解锁；
- 本地增强：无 query / `query:"*"` 列出全部；多词 OR 评分；unknown name 回显；
- 解锁名从持久 `tool/call` 推导，重载安全。

### `skill-search.mjs`

- `skill_search` / `skill_load`，替代完整技能目录注入。

### `custom-bash.mjs`

- Windows 可用的 `bash` 工具：同官方持久 bash 的工具名与 Minimal 风格描述，
  走普通子进程 seam 而非 PTY；
- 配置：`bashPath`（默认 `bash`，生成器写 Git Bash 路径）、`timeoutMs`、
  `maxOutputBytes`。

## 生成器的组合规则

- 所有模式只复制 `anchor-bootstrap.mjs` + 五个伴生 hooks；
- 插入顺序：`anchor-bootstrap` 必须在第一行 entry 之前（pre-step 剥离是
  waterfall 最后一层）；伴生 `instruction-hint` / `dev-tool-search` /
  `skill-search` 跟随其后；
- 源 preset 已挂 `anchor-bootstrap` / `tool-bootstrap` /
  `zero-tool-bootstrap` 时 fail loud，拒绝二次套壳。

## 验证要点

- `zero` / `whoami`：首个 `request/header` 工具面为空，消息面只有合成 anchor；
  anchor 回复后下一个 header 已 promoted，resident 基集 = shells +
  `str_replace_editor` + 三个发现工具 + 已解锁工具。
- `anchored`：首个 header 只有 `bootstrapTools`。
- 看完整链条，不只首条回复：全程应保持 `We need / We have / We …`，不回落
  `Let me` / `The user asks`。
- `compaction/end` 后回落到模式基集 + `compactionTools`，直到新晋升信号。
- Windows 上确认 `bash` 来自 `custom-bash` 且真实可执行。

## 与上游的同步映射

| 上游位置 | 这里的 hook |
|---|---|
| `preset/tool-bootstrap.mjs` | 并入 `anchor-bootstrap.mjs`（本地为超集：persona 阶段拆分、逐请求插件剥离、全模式 cap） |
| `shared/zero-tool-bootstrap.mjs` + `shared/anchor-turn.mjs` | 并入 `anchor-bootstrap.mjs`（两行旧契约变一行） |
| `shared/{compaction-epoch,custom-bash,instruction-hint,skill-search}.mjs` | 同名文件 |
| `shared/dev-tool-search.mjs` | `dev-tool-search.mjs`（本地增强版，勿回退上游旧版） |

> 上游把 `whoami-turn` 改名为通用 `anchor-turn` 后，本目录先做了改名跟随；
> 现在进一步把三个下游 gate/anchor 文件合并成 `anchor-bootstrap.mjs`。
> 模板里不再有 `whoami-turn` / `zero-tool-bootstrap` / `tool-bootstrap`
> 这些下游插件名。
