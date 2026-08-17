# 三模式合并分析：原子机理交叉分类

> 状态：契约已定，代码已实现（`template/hook/anchor-bootstrap.mjs` +
> 生成器单 hook 输出 + 测试）。zero/whoami 链修复已落地并真机复测：
> ① 生成器剥掉源 persona 的 `complete: true`（DSH complete section 会在
> waterfall 后恢复，覆盖 persona 替换）；② `instruction-hint` 改中性/建议式
> 措辞（上游 issue #49：命令式 hint 在晋升后把 `we` 打回 `let me`）；
> ③ zero/whoami 子代理默认 `anchor`，且 `instruction-hint` 带
> `includeSubagents: true`，子代理锚定回合不再提前收到晋升后 hint。
> 剩余：重新生成全部安装态、完全重启 DSH。
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
| `subagents` | `resident`（默认），可选 `bootstrap` | `anchor`（默认，可选 `resident`） | `anchor` |
| persona | 见第 5 节（阶段感知） | 同左 | 同左 |
| context 过滤 | 共享 | 共享 | 共享 |
| 发现/技能/提示 hooks | 共享 | 共享 | 共享 |
| Windows bash / cordis 守卫 | 共享 | 共享 | 共享 |

### 合法 profile 汇总

```text
anchored = { firstTurnTools: minimal, anchorText: none,        subagents: resident | bootstrap }
zero     = { firstTurnTools: empty,   anchorText: test-notice, subagents: anchor | resident }
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
- `subagents: bootstrap` 目前只对 `anchored` 合法；`anchor` 对 zero/whoami
  合法（且本地默认值就是 `anchor`，确保子代理也拿到 anchor turn）；

生成器变化：从“按模式选择复制哪些 hook 文件”退化为“只写一行
`anchor-bootstrap` 配置 + 伴生 hooks”；`--mode zero` / `--mode whoami`
为 profile 别名。

## 5. persona 最终决定：短 persona + We-need opener，不写工具指引

**Voice ≠ chain。** 模型可以把每句 reasoning 都写成 "We …"，但走的仍可能是
standard 轨迹；反过来也成立。显式指令 `always open your reasoning with We
need` 属于表面 voice 引导，不能作为轨迹选择手段。

最终 persona 策略（已实施并真机复测）：

- system persona 全程保持短句：`You are a helpful software engineer
  assistant. When working on a task, always open your reasoning with We
  need.`（受控/晋升同一文本，工具指引不进 persona）；
- 轨迹同时由**条件**间接选择：干净 persona + 首请求工具面（minimal pair 或
  empty）+ 无自动注入 context；晋升后 resident 目录 ≤7 工具、`instruction-hint`
  只使用中性/建议式措辞（上游 issue #49 实测命令式会把链打回 Let me）；
- 工具解锁/专用工具偏好由 `instruction-hint.mjs` 在晋升后以 user 消息一次性
  注入，措辞为建议式。

历史教训（已实测 A/B）：

- persona 带 opener + 命令式工具句（长 persona）→ 晋升后链漂到 Let me；
- persona 只有 opener（短）→ 链基本 We 系，但偶尔 Let me 且工具引导弱；
- persona 只有 Minimal 原句 + 晋升后 user 消息注入命令式工具引导 → zero/whoami
  的晋升后真实任务回合仍漂到 Let me；
- 短 persona 带 We-need opener + 晋升后中性/建议式工具引导 → zero/whoami
  顶层工具回合实测 We 系、let me 0（session-9d09f7f0 / session-5003f061），
  子代理需再走 anchor turn 且 hint 不得提前注入。

### 安装态更新（用户已确认）

- 内置 zero preset 显示名：`标准模式-梁圣版` / `PTC模式-梁圣版` /
  `创造模式-梁圣版`；`minimal-zero` 显示名 `极简模式`（不带梁圣版）。
- `matlab-agentic-preset` 原位 patch（显示名保持 `Matlab Agentic Preset`）。
- 所有安装态生成后无需重启即可出现在列表，但**选中/挂载需完全重启 DSH**；
  headless 新进程可正常挂载（`verify/run-verify.mjs`）。

## 6. 验证要求（用户已确认）

- 不能只看首条回复的措辞：voice 会被鹦鹉学舌，不代表轨迹。看**完整链条的
  行为分布**（session-metrics 分桶）与真实工具路径（是否走 pwsh、是否先
  dev_tool_search 解锁专用工具再动手）。
- 期望：整条链以 we-family 为主、let me 显著回落；行为上优先专用工具。

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
- `subagents`：`bootstrap` 只允许 anchored；`anchor` 允许 zero/whoami；
  `resident` 全模式合法。

## 8. 实施顺序（已确认）

1. ~~拍板待决项~~ ✅（7.1 / 7.2）
2. ~~写 `anchor-bootstrap.mjs` + profile 单元测试~~ ✅
3. ~~生成器改为单 hook 输出 + `--mode anchored|zero|whoami`~~ ✅
   （`--whoami` 作为 `--mode whoami` 兼容别名保留）
4. ~~删除旧下游 hook 与旧测试~~ ✅（clean cut）
5. ~~`npm test` / `npm run check`~~ ✅（148/148）
6. ~~真机验证 `zero` 与 `whoami` 全链条（含子代理）~~ ✅
   （session-9d09f7f0 / session-5003f061 顶层；子代理 anchor 已随本次修复
   走同一路径，安装态需重新生成后复测）；
7. 重新生成全部安装态（含 matlab-anchored），完全重启 DSH。

## 9. 后续架构决策：hook 是对既有 preset 的 patch 组合

这条决策取代“生成器复制一份完整 preset 再修改”的默认思路：下游 hook
不是新的 preset 实现，而是对已有 source preset 的**受控 patch**。source preset
仍然拥有自己的 persona、工具、MCP、Cordis、权限、compaction 与领域配置；
template hook 只声明并挂载选定的机制层，不得静默替换 source rows。

### 9.1 机制层与生命周期

| 层 | 生命周期 | 典型 hook | 负责内容 |
|---|---|---|---|
| session phase | 会话/epoch | `context-gate`、`tool-bootstrap`、`anchor-turn`、`instruction-hint` | 首轮、晋升、compaction、runtime context、工具目录 |
| turn opening | 每轮开场 | `think-phase`、`wire-think` | think/execute 分离、steering、wire provider |
| tool execution | 工具调用前后 | `deliberation-gate`、`cot-drip`、gateway | 首次工具调用深度、长循环维护、工具代理 |
| session history | preset 选择/历史 | `session-seed` / prefab | 预录制轨迹、cwd/AGENTS/skill 重写、session cursor |
| composition | profile | `anchored`、`zero`、`whoami`、`combo` | 以上各层的合法组合，不是单一 hook 算法 |

### 9.2 Patch contract

未来生成器的输入应表达为：

```yaml
patch:
  from: standard
  mode: zero
  preserve:
    - persona
    - tools
    - mcp
    - permissions
    - compaction
  hooks:
    sessionPhase: ...
    contextGate: ...
    toolBootstrap: ...
    anchor: ...
    instructionHint: ...
    turnOpening: ...
    toolExecution: ...
    sessionSeed: ...
```

默认行为是保留 source preset 的所有非 hook rows；重复的 gate、persona、
anchor、instruction 或同名工具必须 fail-loud。生成器负责把高层 patch
编译成 canonical `agent.cordis.yml` row 顺序，而不是让用户手工排列 waterfall。

### 9.3 组合约束

- `context-gate`、`tool-bootstrap`、`instruction-hint` 每个 patch 最多一份；
- `think-phase` 与 `wire-think` 互斥，二者属于同一个 `turnOpening` union；
- `session-seed` 默认不能和 live zero/whoami anchor 组合；若 seed 影响
  promotion 或 durable unlock，必须显式声明 `phaseEffect`；
- `eternal-minimal` 使用 `promotion: never`，不能偷偷进入普通 session phase；
- `includeSubagents` 必须在同一 session phase 的 context/tool/hint hooks
  之间一致，除非配置明确声明独立 phase；
- wire 模式必须有可验证的 sibling provider/adapter；deliberation gate
  必须声明 `minChars` 与 `maxGatesPerTurn`；
- patch 失败时保留用户消息，但不得退化为无界 full catalog；seed 失败不得
  写入半套 durable history。

### 9.4 当前实现与未来 patch interface 的关系

现有 `anchor-bootstrap.mjs` 是下游过渡实现：它把 session phase 的多个职责
暂时合在一行，以兼容当前生成器和安装态。未来应拆为
`context-gate`、`tool-bootstrap`、`anchor-turn`、`instruction-hint` 等独立
patch rows；上游 prefab/think/wire/combo 等机制作为可选层接入，但不改变
source preset 的主体配置。
