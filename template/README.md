# Anchor Hook Template

把上游 anchored 机制做成**可复用的模板**：不修改任何上游文件，只向现有
preset 上“套壳”，生成 `<preset>-anchored` 变体。所有下游自有文件集中在
`template/` 和 `tools/` 两个目录，上游合并不会碰它们。

当前下游 hook 已合并为**一个 gate 插件** `anchor-bootstrap.mjs`，取代旧的
`tool-bootstrap` / `zero-tool-bootstrap` / `anchor-turn` 三件套。三种模式只是
同一个 hook 的三种 profile。

## 支持哪些模式

| mode | `firstTurnTools` | `anchorText` | `subagents` | 首模型请求 | 晋升信号 |
|---|---|---|---|---|---|
| `anchored`（默认） | `minimal` | `none` | `resident`（可 `bootstrap`） | `bash + str_replace_editor` | 首个持久 `tool/call` 或 `assistant/message`（`promoteOn` 可配） |
| `zero` | `empty` | `test-notice` | `resident` | 0 工具 + 固定测试句 | anchor 回复（`assistant/message`） |
| `whoami` | `empty` | `whoami` | `anchor` | 0 工具 + `你是谁` | anchor 回复（`assistant/message`） |

三种模式的后半段完全一致：晋升后都是 **resident 目录**（模式基集 +
`dev_tool_search` / `skill_search` / `skill_load` + 已解锁工具），
`compaction/end` 后按 epoch 回落，绝不是全量目录 dump。原子机理交叉分类见
[`research/mode-merge-analysis.md`](./research/mode-merge-analysis.md)，逐
hook 职责与配置键见 [`hook/README.md`](./hook/README.md)。

## 文件布局

```
template/
  hook/anchor-bootstrap.mjs  # 唯一 gate：模式 profile + 工具门 + anchor 注入 + persona + cap
  hook/compaction-epoch.mjs  # epoch-aware 晋升状态机（anchor-bootstrap/instruction-hint 共用）
  hook/instruction-hint.mjs  # 晋升后一次性 AGENTS.md 存在性提示
  hook/dev-tool-search.mjs   # 按需工具发现/解锁（本地增强版）
  hook/skill-search.mjs      # skill_search / skill_load
  hook/custom-bash.mjs       # Windows Git Bash（普通子进程 seam，无 PTY）
  hook/README.md             # 每个 hook 的职责、配置键、适用模式
  defaults.json              # 下游自有参数，合并上游后在这里同步
  README.md                  # 本说明
tools/
  make-anchored-preset.mjs   # 一键套壳生成器（零依赖 Node ESM）
```

生成器会：

1. 把源 preset 目录整体复制到 `$DSH_HOME/.agent-presets/<to>`；
2. 把 `anchor-bootstrap.mjs` 及伴生 hooks 复制进目标；
3. 在目标 `agent.cordis.yml` 第一行 entry 之前插入 `anchor-bootstrap` 行
   （保持“先注册 → pre-step 剥离是最后一层 waterfall 变换”的顺序契约），
   以及 `instruction-hint` + `dev-tool-search` + `skill-search` 伴生行；
4. 若源 preset 没有 Minimal 工具对，追加 `persistent-shell` 和
   `bootstrap-filesystem` 两个 group；同时禁用标准 `tool-bash` 行，避免
   `bash` 工具名注册两次；
5. **Windows 上**：`persistent-shell` 组禁用，改为 `custom-bash` 行；
6. 禁用源 preset 的 `agent-instructions` / `tool-skill` 行；
7. 改写目标的 `preset.yml`（name/description/order）。

## 统一 gate 的关键参数

- `mode: anchored | zero | whoami`：命名 profile 糖；显式
  `firstTurnTools` / `anchorText` / `subagents` 必须与 mode 匹配，冲突 fail
  loud。
- `firstTurnTools: empty | minimal`：请求 #1 工具面。
- `anchorText: none | test-notice | whoami`：合成 anchor turn 文本。
  - `test-notice` 当前文本：`This round is a test. Tools are not open yet; all tools will open next round.`
  - `whoami` 当前文本：`你是谁`
- `subagents: resident | bootstrap | anchor`：
  - `resident`：子代理直接进 resident；
  - `bootstrap`：仅 anchored，子代理也走 minimal 受控期（`--bootstrap-subagents`）；
  - `anchor`：仅 whoami，子代理也走 anchor turn。
- `bootstrapTools`：仅 `firstTurnTools: minimal` 使用，默认 Minimal 真实对
  `bash + str_replace_editor`。
- `promoteOn`：anchored 可配 `either` / `tool-call` / `assistant-message`；
  zero / whoami 固定 `assistant-message`（anchor 回复）。
- `bootstrapMaxTokens`：**全模式 opt-in**。受控请求注入 cap，晋升后显式剥离，
  防止 seed proposal 继承。
- `suppressedContextSources`：受控期剥离自动注入的 AGENTS.md / skill-catalog。
- `suppressedContextPlugins`：**每个请求**剥离指定插件消息（默认运行时快照）。
- `controlledPersonaText`：受控期 / anchor turn 的 persona（base + We-need
  opener，不提工具解锁）；`personaText`：晋升后的完整 persona（再加
  dev_tool_search 解锁指引 + 专用工具偏好句）。
- `compactionTools`：`compaction/end` 后回落的工作集。

## 快速开始

```sh
# anchored（默认）：首请求 Minimal 工具对
node tools/make-anchored-preset.mjs --from standard --to standard-anchored

# zero：首请求 0 工具 + 固定测试句
node tools/make-anchored-preset.mjs --from standard --to standard-zero --mode zero

# whoami：首请求 0 工具 + 你是谁；--whoami 是旧别名
node tools/make-anchored-preset.mjs --from standard --to standard-whoami --mode whoami
# 或
node tools/make-anchored-preset.mjs --from standard --to standard-whoami --whoami

# Cordis / 创造模式（进程级 Inspect provider，必须给守卫 bundle）：
node tools/make-anchored-preset.mjs \
  --from /path/to/dsh/apps/cli/config/agent-presets/cordis \
  --to creative-anchored \
  --guard-cordis-tools /path/to/dsh/apps/cli/node_modules/@deepseek-ai/dsh-tool-cordis/lib/index.js

# 干跑，只打印计划：
node tools/make-anchored-preset.mjs --from standard --to standard-anchored --dry-run
```

生成后：**完全重启 DeepSeek Harness → 新建空白 session → 选择新 preset**。
不要中途热切换 preset。

## 验证

导出 session JSONL，检查 `request/header`：

- `anchored`：第一个 header 只有 `bash` + `str_replace_editor`；system prompt
  只有 `controlledPersonaText`（base + We-need opener）；
- `zero` / `whoami`：第一个 header 工具为空，消息面只有合成 anchor；
- 晋升后：resident 目录出现（模式基集 + 三个发现工具 + 已解锁工具），
  **不是**完整目录，persona 切换为完整 `personaText`；
- 调一次 `dev_tool_search({"toolNames":["read"]})` 后，下一个 header 应出现
  `read` 并持续保留；
- `compaction/end` 后回落到模式基集 + `compactionTools`，直到新晋升信号；
- Windows 上 `bash` 描述来自 `custom-bash`，且真实可执行。

也可用 `node verify/run-verify.mjs --preset <id> --task "..." --stop-after-first-assistant`
做一次性真机校验。

## 与上游合并的流程

上游 `preset/`、`README*`、`test/`、`shared/` 的改动由 `Sync upstream`
workflow 自动 rebase 进 `main` 并合并进 `agent-dev`。手动同步命令同
AGENT.md。

### 合并后必做：同步参数

| 上游位置 | 下游位置 |
|---|---|
| `preset/agent.cordis.yml` 的 `bootstrapTools` / `promoteOn` / `compactionTools` | `template/defaults.json` + 生成器 `MODE_PROFILES` |
| `preset/tool-bootstrap.mjs` 的 resident / epoch / 解锁语义 | `template/hook/anchor-bootstrap.mjs`（本地为超集） |
| `shared/{compaction-epoch,custom-bash,dev-tool-search,instruction-hint,skill-search}.mjs` | `template/hook/` 同名文件（`dev-tool-search` 本地增强） |
| `shared/zero-tool-bootstrap.mjs` + `shared/anchor-turn.mjs` | 已合并进 `template/hook/anchor-bootstrap.mjs`（不再有旧三件套） |
| 插件对 `agent/pre-step` / `agent/request` 的 `prepend` 与降级语义 | `template/hook/anchor-bootstrap.mjs` |

改完重跑 `npm test` / `npm run check` 并重新生成安装态。

## 约束与取舍

- 生成器对无法确定 Minimal 工具对的源 preset **fail loud**，要求显式
  `--bootstrap-tools`。
- 源 preset 已挂 `anchor-bootstrap` / `tool-bootstrap` /
  `zero-tool-bootstrap` 时拒绝套壳。
- 晋升后不是完整目录；resident + `dev_tool_search` 按需解锁是实测结论。
- **Windows 上不要用 PTY persistent bash**，生成器自动改用 `custom-bash`。
- hook 对缺失 phase 工具 fail-open（警告后暴露完整目录），不会 brick session。
- 含 `tool-cordis` 的源 preset 必须给 `--guard-cordis-tools`，否则 fail loud。
- 生成的 preset 与 shell 同信任级；请审阅 `template/hook/anchor-bootstrap.mjs`
  后再套用。
