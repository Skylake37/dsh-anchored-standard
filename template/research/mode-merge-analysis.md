# 三模式合并分析：原子机理交叉分类

> 状态：契约已定，代码已实现（`template/hook/anchor-bootstrap.mjs` +
> 生成器单 hook 输出 + 测试 148/148）。剩余：真机验证 zero/whoami 全链条、
> 重新生成全部安装态、完全重启 DSH。
>
> 基线：`upstream/main = db4527a`，本地 `agent-dev` 基线为含 persona 主动
> 解锁/工具偏好句的版本（提交 `81dcb10`，后经 `ce6fbdc` 合并）。

## 1. 命名与取值（用户已确认）

| 字段 | 取值 | 说明 |
|---|---|---|
| `mode` | `anchored` \| `zero` \| `whoami` | 命名 profile 糖，等价于下表三组白名单组合 |
| `firstTurnTools` | `empty` \| `minimal` | 首模型请求的工具面：`empty`=0 工具；`minimal`=`bash + str_replace_editor` |
| `anchorText` | `none` \| `test-notice` \| `whoami` | 是否/以何种文本注入合成 anchor turn |
| `subagents` | `resident` \| `bootstrap` \| `anchor` | 子代理起点：直接 resident / 走 minimal 受控 / 也走 anchor turn |

### `anchorText: test-notice` 的当前内容

- 定义：`template/hook/anchor-turn.mjs` 的 `ANCHOR_TEXT` 常量。
- 当前全文：

```text
This round is a test. Tools are not open yet; all tools will open next round.
```

- 语义：告诉模型“本轮是测试、工具还没开放、下一轮开放”，用来制造一个
  固定、可复现的 0 工具预热回合；用户真实消息下一轮才被处理。
- `anchorText: whoami` 的当前全文是 `你是谁`。
- 行级对应：
  - `none`：不挂 `anchor-turn` 行；
  - `test-notice`：`anchor-turn` 使用 `ANCHOR_TEXT`（zero 现状）；
  - `whoami`：`anchor-turn` 显式写 `text: 你是谁`（whoami 现状）。

## 2. 三种模式的原子取值矩阵

| 原子机理 | anchored | zero | whoami |
|---|---|---|---|
| `firstTurnTools` | `minimal` | `empty` | `empty` |
| `anchorText` | `none` | `test-notice` | `whoami` |
| 晋升信号 | `either` / `tool-call` / `assistant-message` | 固定 `assistant-message` | 固定 `assistant-message` |
| 晋升后 resident 基集 | `bootstrapTools` | `shells + str_replace_editor` | 同 zero |
| `compactionTools` 回落 | 相同（基集不同） | 相同 | 相同 |
| `subagents` | `resident`（默认），可选 `bootstrap` | `resident`（默认） | `anchor` |
| persona | 见第 5 节（阶段感知） | 同左 | 同左 |
| context 过滤 | 共享 | 共享 | 共享 |
| 发现/技能/提示 hooks | 共享 | 共享 | 共享 |
| Windows bash / cordis 守卫 | 共享 | 共享 | 共享 |

### 合法 profile 汇总

```text
anchored = { firstTurnTools: minimal, anchorText: none,        subagents: resident | bootstrap }
zero     = { firstTurnTools: empty,   anchorText: test-notice, subagents: resident }
whoami   = { firstTurnTools: empty,   anchorText: whoami,      subagents: anchor }
```

其余自由组合目前**没有实证**，合并后应 fail-loud，或只作为白名单内的命名
profile 暴露。

## 3. 原子机理清单

1. **首请求表面 gate** — 按 `firstTurnTools` 决定请求 #1 的工具面。
2. **anchor turn 注入** — 按 `anchorText` 决定是否 prepend 合成 user 消息。
3. **晋升触发器** — `anchorText != none` 时固定 `assistant-message`；否则可配。
4. **resident 目录构造** — 基集 + 三个发现工具 + 已解锁工具。
5. **compaction epoch** — `compaction/end` 后回落到基集 + `compactionTools`，
   只认边界后的新晋升信号（`compaction-epoch.mjs` 已共享）。
6. **context 过滤** — `suppressedContextSources`（受控期）+ `suppressedContextPlugins`
   （逐请求，本地扩展）。
7. **persona 阶段收敛** — 见第 5 节；用户已选 A（锚定回合/受控期先不带工具
   指导句，晋升后再带全量工具指导）。
8. **子代理策略** — `subagents: resident | bootstrap | anchor`。
9. **注入替代与发现工具** — `instruction-hint` / `skill-search` /
   `dev-tool-search`（模式无关）。
10. **平台 bash** — `custom-bash`（模式无关）。
11. **cordis 守卫** — `tool-cordis-guarded`（源 preset 相关，模式无关）。
12. **首请求 cap** — `bootstrapMaxTokens`（当前只有 anchored 支持，合并后是否
    统一见第 7 节待决项）。

### 晋升到底发生在什么时候（用户澄清项）

机制：`compaction-epoch.mjs` 维护 `(boundary, promoted)`，由
`ctx.on('session/event', …)` 增量观察持久事件；每次
`system-prompt/assemble` 时调用 `promotion.status(agent)` 重新判定。所以
**晋升信号一落盘，下一次组装立刻看到 `promoted=true`**，不会额外等一轮。

- `anchored`：
  1. 请求 #1 组装时受控 → 只有 `bootstrapTools`；
  2. 模型首个 `tool/call`（或首条 `assistant/message`，取决于 `promoteOn`）
     落盘 → 立即 promoted；
  3. 工具结果续传、或下一条用户消息的组装 → 直接 resident。
  若首轮只说话不调工具，`promoteOn: either` 保证“下一条用户消息”即为
  promoted，不会出现“第二轮才晋升”。
- `zero` / `whoami`：
  1. 用户首消息到达，`anchor-turn` 在 inbox 里 prepend 合成 anchor；
  2. 请求 #1 只消费 anchor → `empty` 工具，模型回复 anchor；
  3. 该 `assistant/message` 落盘 → 立即 promoted；
  4. 用户真实消息是**下一轮**被消费，组装时已 promoted → resident。
  也就是说：真实任务**不会在无工具状态下跑**；它从第一次被模型看到起就
  有 resident 工具。代价是额外一次 anchor 模型调用，这是模式设计成本。

## 4. 合并蓝图

目标是把 `tool-bootstrap.mjs` 与 `zero-tool-bootstrap.mjs` 合并为一个 gate
插件，`anchor-turn` 逻辑并入同一行配置：

```yaml
- id: anchor-bootstrap
  name: ./anchor-bootstrap.mjs
  config:
    mode: anchored                   # anchored | zero | whoami（profile 糖）
    firstTurnTools: minimal          # empty | minimal
    anchorText: none                 # none | test-notice | whoami
    subagents: resident              # resident | bootstrap | anchor

    # firstTurnTools=minimal 时用：
    bootstrapTools: [bash, str_replace_editor]
    promoteOn: either                # anchorText != none 时强制 assistant-message

    # persona（阶段感知，A'）：受控/锚定回合用 controlledPersonaText，
    # 晋升后用 personaText（= controlledPersonaText + 工具解锁/偏好句）。
    controlledPersonaText: "You are a helpful software engineer assistant. When working on a task, always open your reasoning with We need."
    personaText: "You are a helpful software engineer assistant. When working on a task, always open your reasoning with We need. If a tool you need is not in your current tool list, do not conclude it is unavailable: after your first tool call, call dev_tool_search with no query to list every unlockable tool, then unlock the exact names. Before doing work with bash or str_replace_editor, check dev_tool_search for a purpose-built tool and prefer it whenever one exists."

    # 共享参数
    suppressedContextSources: [agent-instructions, skill-catalog]
    suppressedContextPlugins: ['@deepseek-ai/dsh-system-prompt']
    bootstrapMaxTokens:              # opt-in；全模式可用（用户已确认）
    compactionTools: [read, write, edit, glob, grep, todo_write, ask_user_question]
```

派生规则：

- `anchorText == none` → `firstTurnTools` 必须为 `minimal`；
- `anchorText != none` → `firstTurnTools` 必须为 `empty`，`promoteOn` 强制
  `assistant-message`；
- resident 基集：`minimal` → `bootstrapTools`；`empty` → shells +
  `str_replace_editor`；
- `subagents: bootstrap` 目前只对 `anchored` 合法；`anchor` 目前只对
  `whoami` 合法；`resident` 全模式合法。

生成器变化：从“按模式选择复制哪些 hook 文件”退化为“只写一行
`anchor-bootstrap` 配置 + 伴生 hooks”；`--mode zero` / `--mode whoami`
为 profile 别名。

## 5. persona 阶段拆分（用户已选 A，建议细化为 A'）

当前完整 `bootstrapPersonaText` 实际包含四段：

1. **base**：`You are a helpful software engineer assistant.`
2. **opener**：`When working on a task, always open your reasoning with We need.`
3. **unlock 指引**：找不到工具先 `dev_tool_search` 列出并解锁。
4. **工具偏好**：动 bash / str_replace_editor 前先查专用工具并优先使用。

用户选择 A 的动机是：anchor turn（`empty` 工具面）上第 3、4 段引用
`dev_tool_search`，而该请求根本没有这个工具，形成悬空指引。建议 A 细化为
**阶段感知 persona**：

- anchor turn / 受控期：`base + opener`（保住 We-need 轨迹，但不提工具解锁）；
- promoted 后：`base + opener + unlock指引 + 工具偏好`（当前完整 persona）。

这样既消除悬空，也符合“整个链条都是 We need / We have / We ……”的实测目标。
后续真机验证时，`anchored` 的首请求同样可以先按“受控期只有 base+opener”跑
一版对比（当前是 full persona），看哪个更稳。

### 安装态更新（用户已确认）

所有安装态都要重新生成到合并后的新契约：

- `anchored-standard`
- `anchored-creative`
- `matlab-agentic-preset-anchored`（当前仍缺工具偏好句，必须升级）

重新生成后**完全重启 DSH**；standing mount 会复用旧代际，只改文件不重启会
新旧混用。

## 6. 验证要求（用户已确认）

- zero / whoami 的稳定性由用户实测，但**不能只看首条回复**，要看完整链条：
  期望全程 `We need / We have / We …`，不回落 `Let me` / `The user asks`。
- 当前会话（含本 session）已观察到全程 `we …` 形态，可作为参考基线；
  anchor turn persona A' 是否影响首链，需要真机验证。

## 7. 已决项（用户最终决定）

### 7.1 `bootstrapMaxTokens` 扩展为全模式共用选项

- 合并后的单一 gate 对 `firstTurnTools: empty | minimal` **都支持**
  `bootstrapMaxTokens`（opt-in，缺省仍不 cap）。
- 语义不变：受控期注入 cap；`status.promoted` 后若当前 proposal 仍等于该
  cap，显式剥掉，防止 seed proposal 继承。
- 对 zero / whoami 而言，cap 作用于 anchor 请求；anchor 回复晋升后，用户
  真实消息的请求自动恢复无 cap。

### 7.2 旧 hook 文件 clean cut

- `template/hook/tool-bootstrap.mjs`、`zero-tool-bootstrap.mjs`、
  `anchor-turn.mjs` 三个下游文件删除，由单一 `anchor-bootstrap.mjs` 取代。
- 不留兼容 shim。依据：安装态 preset 目录自包含（旧副本继续可用），且用户
  已决定所有安装态全部重新生成。
- 上游自有副本（`shared/`、三个上游 mode 目录）不动，继续由上游 sync 管理。

### 7.3 最终 config 契约（实现目标）

```yaml
- id: anchor-bootstrap
  name: ./anchor-bootstrap.mjs
  config:
    mode: anchored | zero | whoami     # 命名 profile 糖
    firstTurnTools: empty | minimal
    anchorText: none | test-notice | whoami
    subagents: resident | bootstrap | anchor

    bootstrapTools: [bash, str_replace_editor]   # firstTurnTools=minimal 时使用
    promoteOn: either | tool-call | assistant-message  # anchorText != none 强制 assistant-message

    controlledPersonaText: "base + opener"
    personaText: "base + opener + unlock指引 + 工具偏好"

    bootstrapMaxTokens: <positive int | 省略>   # 全模式 opt-in
    suppressedContextSources: [agent-instructions, skill-catalog]
    suppressedContextPlugins: ['@deepseek-ai/dsh-system-prompt']
    compactionTools: [read, write, edit, glob, grep, todo_write, ask_user_question]
```

白名单校验：

- `mode` 提供默认值；显式 `firstTurnTools/anchorText/subagents` 与 `mode`
  冲突时 fail-loud；
- `anchorText == none` 只允许 `firstTurnTools: minimal`；
- `anchorText != none` 只允许 `firstTurnTools: empty`，且 `promoteOn` 强制
  `assistant-message`；
- `subagents`：`bootstrap` 只允许 anchored；`anchor` 只允许 whoami；
  `resident` 全模式合法。

## 8. 实施顺序（已确认）

1. ~~拍板待决项~~ ✅（7.1 / 7.2）
2. ~~写 `anchor-bootstrap.mjs` + profile 单元测试~~ ✅
3. ~~生成器改为单 hook 输出 + `--mode anchored|zero|whoami`~~ ✅
   （`--whoami` 作为 `--mode whoami` 兼容别名保留）
4. ~~删除旧下游 hook 与旧测试~~ ✅（clean cut）
5. ~~`npm test` / `npm run check`~~ ✅（148/148）
6. 真机验证 `zero` 与 `whoami` 全链条（用户侧），重点看 persona A' 与 cap；
7. 重新生成全部安装态（含 matlab-anchored），完全重启 DSH。
