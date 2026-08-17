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

## Patch 语义（后续 contract）

这里的 hook 不是新的完整 preset，而是对已有 source preset 的受控 patch：
source 的 persona、工具、MCP、Cordis、权限、compaction 和领域配置默认全部保留；
hook 只增加或替换明确声明的机制层。`anchored`、`zero`、`whoami`、`think`、
`wire-think`、`combo`、`eternal-minimal` 与 `prefab` 是不同层 hook 的合法组合，
不是互相覆盖的完整 preset。

未来 patch 输入的概念形态：

```yaml
patch:
  from: standard
  mode: zero
  preserve: [persona, tools, mcp, permissions, compaction]
  hooks:
    contextGate: ...
    toolBootstrap: ...
    anchor: ...
    instructionHint: ...
    turnOpening: ...
    toolExecution: ...
    sessionSeed: ...
```

生成器负责编译 canonical row 顺序并做组合校验；用户不应手工排列 waterfall。

当前第一版可执行入口：

```pwsh
node tools/patch-from-spec.mjs `
  --target <existing-preset-dir> `
  --patch <patch.json> `
  --dry-run
```

`patch.backend` 默认为 `legacy`，继续编译到兼容旧安装态的
`anchor-bootstrap`；设置 `backend: layered` 时，当前已真正生成独立的
`context-gate`、`tool-bootstrap`/`zero-tool-bootstrap`、`anchor-turn`、
`instruction-hint`、`dev-tool-search`、`skill-search` rows，并复制对应的
shared hook 文件。`turnOpening` 现在也是 layered 后端支持的一层，当前只允许
`mode: anchored`：`kind: think` 渲染/复制 `think-phase.mjs`；`kind: wire-think`
渲染/复制 `toolchoice-adapter.mjs`（必须排在 `wire-think.mjs` 之前，且该行的
`provider` 与 `wire-think` 行使用同一个 sibling provider）和 `wire-think.mjs`，
并要求 `wire-think` 的 `provider` 与 `defaultProvider` 不同；`mode: zero` /
`whoami` 与 `turnOpening` 组合会 fail-loud。`toolExecution`、`sessionSeed`、
`gateway`
仍会明确 fail-loud，暂不假装支持。旧的 `make-anchored-preset.mjs` 与
`patch-preset-in-place.mjs` 默认行为保持不变。
重复 gate/persona/anchor/instruction 或同名工具必须 fail-loud。默认不允许
`sessionSeed` 与 live zero/whoami anchor 混用；`think` 与 `wire-think` 互斥，
二者属于同一个 `turnOpening` union；`eternal-minimal` 不进入普通 promotion
phase。当前 `anchor-bootstrap.mjs` 是兼容旧生成器的过渡合并实现，后续会按
生命周期拆成多个可组合 patch rows。

| mode | `firstTurnTools` | `anchorText` | `subagents` | 首模型请求 | 晋升信号 |
|---|---|---|---|---|---|
| `anchored` | `minimal` | `none` | `resident`（或 `bootstrap`） | `bash + str_replace_editor` | 首个持久 `tool/call` 或 `assistant/message`（`promoteOn` 可配） |
| `zero` | `empty` | `test-notice` | `anchor`（或 `resident`） | 0 工具 + 固定测试句 | anchor 回复（`assistant/message`） |
| `whoami` | `empty` | `whoami` | `anchor` | 0 工具 + `你是谁` | anchor 回复（`assistant/message`） |

共同后半段：晋升后都是 **resident 目录** = 模式基集 + `dev_tool_search` /
`skill_search` / `skill_load` + 模型显式解锁的工具；其中 `whoami` 的首次晋升请求刻意只保留
三个发现工具，先让模型发现并解锁任务工具，再获得所解锁的工具。`compaction/end` 后按
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
- resident 目录：`minimal` 基集 = `bootstrapTools`；普通 `empty` 基集 = shells +
  `str_replace_editor`；`whoami` 首次晋升基集仅为三个发现工具；所有模式再加模型显式解锁的工具；
- persona：阶段感知替换 `deployment:persona`，受控期用
  `controlledPersonaText`、晋升后用 `personaText`（当前 defaults 两者都带
  We-need opener，工具指引不进 persona）。目标 preset 没有 persona section
  时会自动合成一个；生成器还会剥掉源 persona 行的 `complete: true`，否则
  DSH 在 waterfall 之后恢复该 complete section，会压过这里的选择；
- context 过滤：受控期剥 `suppressedContextSources`；每请求剥
  `suppressedContextPlugins`；
- 可选 cap：受控期注入 `bootstrapMaxTokens`，晋升后显式剥掉；
- 子代理策略：`subagents: resident | bootstrap | anchor`（zero/whoami 默认
  `anchor`，子代理同走 anchor turn）。

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
personaText: "base + We-need opener"   # 当前 defaults 同 controlled；工具指引在 instruction-hint
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

- 晋升后一次性注入 user 消息：instruction 文件存在提示（若有）+ 工具指引。
- **措辞契约（上游 issue #49 实测）**：必须是中性/建议式，不能是命令式；
  “read first and follow them” 一类命令会在晋升后把思维链从 `we` 打回
  `let me`。当前文本用 “Reference documents exist… Reading … is
  recommended… consult only when needed”，工具指引同样是
  “Purpose-built tools are often available…” 而不是 “before doing work… check”。
- 配置 `promoteOn`：anchored 与 gate 的 `promoteOn` 一致；zero/whoami 为
  `assistant-message`。
- 配置 `includeSubagents: true`：`subagents: anchor` / `bootstrap` 模式由生成器
  自动写入，让子代理也等自己的晋升信号；否则子代理在锚定回合就会收到
  晋升后 hint。

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
  `zero-tool-bootstrap` 时 fail loud，拒绝二次套壳；
- 源 persona 行若有 `complete: true`，生成器会剥掉（否则 DSH 的 complete
  section 会在 waterfall 后恢复，覆盖 anchor-bootstrap 的 persona 替换）。

## 验证要点

- `zero` / `whoami`：首个 `request/header` 工具面为空，消息面只有合成 anchor；
  anchor 回复后下一个 header 已 promoted，resident 基集 = shells +
  `str_replace_editor` + 三个发现工具 + 已解锁工具；子代理同样先 anchor
  （`delegationDepth > 0` 也如此），且 anchor 回合不应有 `instruction-hint`。
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
