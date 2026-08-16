# 三模式合并分析：原子机理交叉分类

> 状态：分析稿，未实现。目标是把 `anchored` / `zero-anchor` / `whoami` 三种
> 模式从“三个 preset 目录 + 两个 gate 插件”收敛为一个可配置的 gate 插件。
>
> 基线：`upstream/main = db4527a`，本地 `agent-dev = ce6fbdc`（含 persona 主动
> 解锁/工具偏好句，见文末“persona 影响”）。

## 1. 命名与取值（用户已确认）

| 字段 | 取值 | 说明 |
|---|---|---|
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
- 三者的行级对应：
  - `none`：不挂 `anchor-turn` 行；
  - `test-notice`：`anchor-turn` 使用 `ANCHOR_TEXT`（zero-anchored 现状）；
  - `whoami`：`anchor-turn` 显式写 `text: 你是谁`（whoami 现状）。

## 2. 三种模式的原子取值矩阵

| 原子机理 | anchored | zero-anchor | whoami |
|---|---|---|---|
| `firstTurnTools` | `minimal` | `empty` | `empty` |
| `anchorText` | `none` | `test-notice` | `whoami` |
| 晋升信号 | `either` / `tool-call` / `assistant-message` | 固定 `assistant-message` | 固定 `assistant-message` |
| 晋升后 resident 基集 | `bootstrapTools` | `shells + str_replace_editor` | 同 zero |
| `compactionTools` 回落 | 相同（基集不同） | 相同 | 相同 |
| `subagents` | `resident`（默认），可选 `bootstrap` | `resident`（默认） | `anchor` |
| persona | 共享 `bootstrapPersonaText` | 共享 | 共享 |
| context 过滤 | 共享 | 共享 | 共享 |
| 发现/技能/提示 hooks | 共享 | 共享 | 共享 |
| Windows bash / cordis 守卫 | 共享 | 共享 | 共享 |

### 合法 profile 汇总

```text
anchored    = { firstTurnTools: minimal, anchorText: none,        subagents: resident | bootstrap }
zero-anchor = { firstTurnTools: empty,   anchorText: test-notice, subagents: resident }
whoami      = { firstTurnTools: empty,   anchorText: whoami,      subagents: anchor }
```

其余自由组合目前**没有实证**，合并后应 fail-loud，或只作为白名单内的
命名 profile 暴露。

## 3. 原子机理清单

1. **首请求表面 gate** — 按 `firstTurnTools` 决定请求 #1 的工具面。
2. **anchor turn 注入** — 按 `anchorText` 决定是否 prepend 合成 user 消息。
3. **晋升触发器** — `anchorText != none` 时固定 `assistant-message`；否则可配。
4. **resident 目录构造** — 基集 + 三个发现工具 + 已解锁工具。
5. **compaction epoch** — `compaction/end` 后回落到基集 + `compactionTools`，
   只认边界后的新晋升信号（`compaction-epoch.mjs` 已共享）。
6. **context 过滤** — `suppressedContextSources`（受控期）+ `suppressedContextPlugins`
   （逐请求，本地扩展）。
7. **persona 收敛** — `bootstrapPersonaText`（本地扩展；见文末）。
8. **子代理策略** — `subagents: resident | bootstrap | anchor`。
9. **注入替代与发现工具** — `instruction-hint` / `skill-search` /
   `dev-tool-search`（模式无关）。
10. **平台 bash** — `custom-bash`（模式无关）。
11. **cordis 守卫** — `tool-cordis-guarded`（源 preset 相关，模式无关）。
12. **首请求 cap** — `bootstrapMaxTokens`（当前只有 anchored 支持，合并后可统一）。

## 4. 合并蓝图

目标是把 `tool-bootstrap.mjs` 与 `zero-tool-bootstrap.mjs` 合并为一个
gate 插件，`anchor-turn` 逻辑并入同一行配置：

```yaml
- id: anchor-bootstrap
  name: ./anchor-bootstrap.mjs
  config:
    # 三个原子维度（白名单组合见第 2 节）
    firstTurnTools: empty            # empty | minimal
    anchorText: test-notice          # none | test-notice | whoami
    subagents: resident              # resident | bootstrap | anchor

    # anchored 模式（firstTurnTools=minimal）用：
    bootstrapTools: [bash, str_replace_editor]
    promoteOn: either                # anchorText != none 时强制 assistant-message

    # 共享参数
    suppressedContextSources: [agent-instructions, skill-catalog]
    suppressedContextPlugins: ['@deepseek-ai/dsh-system-prompt']
    bootstrapPersonaText: "..."      # 当前 defaults.json 全文
    bootstrapMaxTokens:              # opt-in；是否覆盖 anchor 模式待定
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
`anchor-bootstrap` 配置 + 伴生 hooks”，`--whoami` 变成
`--first-turn-tools empty --anchor-text whoami --subagents anchor` 的 profile
别名（或直接保留 `--mode whoami` 作为 sugar）。

## 5. persona 主动解锁/工具偏好句的影响

当前 `template/defaults.json` 的 `bootstrapPersonaText` 为：

```text
You are a helpful software engineer assistant. When working on a task, always
open your reasoning with We need. If a tool you need is not in your current tool
list, do not conclude it is unavailable: after your first tool call, call
dev_tool_search with no query to list every unlockable tool, then unlock the
exact names. Before doing work with bash or str_replace_editor, check
dev_tool_search for a purpose-built tool and prefer it whenever one exists.
```

对合并的影响：

1. **这是共享原子块，不是某个模式独有。** 本地 `tool-bootstrap` 与
   `zero-tool-bootstrap` 都已支持 `bootstrapPersonaText`，合并后的
   `anchor-bootstrap` 必须保留它作为公共参数。
2. **语义上依赖 resident 阶段的 `dev_tool_search`。** 三模式晋升后都暴露
   `dev_tool_search`，所以“优先用专门工具”句在晋升后对三模式都成立。
3. **开放问题：anchor turn 本身是否也用这段 persona。** 当前
   `zero-tool-bootstrap` 在 0 工具 anchor 请求上同样注入这段 persona；但该
   请求上连 `dev_tool_search` 都没有，句中的工具指导会被悬空。合并时建议
   二选一：
   - A. anchor turn 用裸 Minimal persona（`You are a helpful software
     engineer assistant.`），晋升后再恢复完整 `bootstrapPersonaText`；
   - B. 保持现状（同一段 persona 贯穿全程），并真机验一次 whoami/zero
     anchor 首链是否仍稳定。
4. **安装态已有新旧混合。** 另一个 session 已把
   `anchored-standard` / `anchored-creative` 重新生成（含新句），但
   `matlab-agentic-preset-anchored` 仍是旧 persona（缺新句）。合并实现并
   重新生成时，需要顺带把该安装态也升级，否则行为不一致。

## 6. 待决问题

1. anchor turn 的 persona 采用第 5 节 A 还是 B？
2. 是否保留 `mode: anchored | zero-anchor | whoami` 作为 profile sugar，还是
   只暴露三个原子字段？
3. `subagents: bootstrap` 是否只保留给 anchored（当前实证范围）？
4. `bootstrapMaxTokens` 是否扩展到 `firstTurnTools: empty` 模式？
5. 合并后旧文件 `zero-tool-bootstrap.mjs` 是否删除，还是留一层兼容别名？

## 7. 建议实施顺序

1. 定 config 契约（待决问题 1–4）；
2. 写 `anchor-bootstrap.mjs`，用三个 profile 的单元测试对齐现有行为；
3. 生成器改为单 hook 输出 + profile 别名；
4. `npm test` / `npm run check`；
5. 真机验证 `empty + test-notice`（当前没有 CLI 入口的组合）与
   `empty + whoami`；
6. 重新生成受影响安装态 preset，完全重启 DSH。
