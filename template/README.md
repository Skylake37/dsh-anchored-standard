# Anchor Hook Template

把上游 `preset/` 里的 anchored 机制做成**可复用的模板**：不修改任何上游文件，
只向现有 preset 上“套壳”，生成 `<preset>-anchored` 变体。所有下游自有文件都
集中在 `template/` 和 `tools/` 两个目录，上游合并不会碰它们。

下游默认跟随**上游最新流程**（PR #14 锚定 + PR #27 晋升后 resident 目录 +
custom-bash + instruction-hint/skill-search/dev-tool-search + compaction
epoch）：请求 #1 只有 Minimal 工具对；晋升后**在正确时刻**开放 resident 目录
（bootstrap 工具对 + 三个发现工具），源 preset 的其余工具通过
`dev_tool_search` 按需解锁——既不是全程只有两个工具，也不是晋升时一次性
倾倒完整目录（那会拉回 standard 轨迹）。

## 支持哪些模式

hook 套件目前组合出三种模式，生成器 CLI 暴露前两种；第三种与上游
`zero-anchored-standard` 同构，hook 已支持，只是还没做独立开关。每个 hook
具体干什么、适用哪种模式见 [`hook/README.md`](./hook/README.md)。

| 模式 | 生成器入口 | 首模型请求 | 锚定插件 | 晋升信号 | 子代理 |
|---|---|---|---|---|---|
| anchored（默认） | 默认 | `bash + str_replace_editor` | `tool-bootstrap` | 首个持久 `tool/call` 或 `assistant/message`（`promoteOn` 可配） | 默认跳过 bootstrap（`--bootstrap-subagents` 反转） |
| whoami | `--whoami` | 0 工具 + `anchor-turn(text: 你是谁)` | `anchor-turn` + `zero-tool-bootstrap` | anchor 回复（`assistant/message`） | 继承 anchor（`includeSubagents: true`） |
| zero-anchor | 尚未暴露 CLI（同一组 hook 可用 `buildAnchorRows` 组合） | 0 工具 + `anchor-turn` 默认测试句 | `anchor-turn` + `zero-tool-bootstrap` | anchor 回复（`assistant/message`） | 默认跳过（`includeSubagents: false`） |

## 文件布局

```
template/
  hook/tool-bootstrap.mjs   # 可复用主钩子（生成时复制进每个目标 preset）
  hook/compaction-epoch.mjs # epoch-aware 晋升状态机（tool-bootstrap/instruction-hint 共用）
  hook/instruction-hint.mjs # 晋升后一次性的 AGENTS.md 存在性提示（替代全量注入）
  hook/dev-tool-search.mjs  # 按需工具发现/解锁
  hook/skill-search.mjs     # skill_search / skill_load（替代完整技能目录注入）
  hook/custom-bash.mjs      # Windows Git Bash 工具（普通子进程 seam，无 PTY）
  hook/anchor-turn.mjs      # 零工具 anchor-turn（whoami/zero 共用，text 决定口味）
  hook/zero-tool-bootstrap.mjs # anchor-turn 模式：零工具首请求 + resident 目录
  hook/README.md            # 每个 hook 的职责、配置键、适用模式
  defaults.json             # 下游自有参数，合并上游后在这里同步参数
  README.md                 # 本说明
tools/
  make-anchored-preset.mjs  # 一键套壳生成器（零依赖 Node ESM）
```

生成器会：

1. 把源 preset 目录整体复制到 `$DSH_HOME/.agent-presets/<to>`（默认
   `<source>-anchored`）；
2. 把 `template/hook/` 下的钩子插件复制进目标；
3. 在目标 `agent.cordis.yml` 的**第一行 entry 之前**插入 bootstrap 行
   （保持“先注册 → pre-step 剥离是最后一层 waterfall 变换”的顺序契约），
   以及 `instruction-hint` + `dev-tool-search` + `skill-search` 伴生行；
4. 若源 preset 没有 Minimal 工具对（persistent `bash` +
   `str_replace_editor`），追加 `persistent-shell` 和
   `bootstrap-filesystem` 两个 group；同时禁用标准 `tool-bash` 行，避免
   `bash` 工具名注册两次（上游 PR #14 的做法）；
5. **Windows 上**：`persistent-shell` 组禁用（DSH PTY 后端无 win32），改为
   `custom-bash` 行（Git Bash 普通子进程，默认
   `C:\Program Files\Git\bin\bash.exe`，`--win-bash-path` 可覆盖）——`bash`
   工具在 Windows 上真实可执行；
6. 禁用源 preset 的 `agent-instructions` / `tool-skill` 行，由
   `instruction-hint` / `skill-search` 接管（上游同款）；
7. 改写目标的 `preset.yml`（name/description/order）。

## 当前 anchor 参数（上游 PR #14 / issue #11 + 上游最新 resident 流）

- `bootstrapTools: [bash, str_replace_editor]`：**官方 Minimal preset 的真实
  工具对**。issue #11 实测该 schema 在 adapter 默认 maxTokens（256000）下
  5/5 锚定，而所有 standard 家族 schema 11/11 落入 standard 行为。
- `promoteOn: either`（默认）：首个持久 `tool/call` 或
  `assistant/message` 晋升；`tool-call` / `assistant-message` 可选。
- **晋升后 resident 目录**：`bootstrapTools` + `dev_tool_search` +
  `skill_search` + `skill_load` + 模型通过 `dev_tool_search` 显式解锁的
  工具（从持久 `tool/call` 事件推导，重载安全）。**不是**完整目录一次性
  倾倒——完整目录会把轨迹拉回 standard 风格；**也不是**永远只有两个工具。
- `compactionTools: [read, write, edit, glob, grep, todo_write,
  ask_user_question]`：`compaction/end` 之后回落到 bootstrap 对 +
  compactionTools，直到边界之后出现**新的**晋升信号（epoch-aware）。
- `bootstrapMaxTokens`：**opt-in**。默认不写这一行 → 首请求走 adapter 默认
  maxTokens，不 cap；显式 `--max-tokens` 才注入 cap（`prepend` 注册，晋升
  后显式剥离；compaction 重置后再次生效）。
- `suppressedContextSources: [agent-instructions, skill-catalog]`：受控阶段
  剥离自动注入的 AGENTS.md 摘要和技能目录；空数组关闭剥离。
- `suppressedContextPlugins: [@deepseek-ai/dsh-system-prompt]`：**每个请求**
  都剥离运行时上下文快照消息（等价上游 persona 行的
  `includeRuntimeContext: false`）。
- `bootstrapPersonaText`（下游扩展）：把 system prompt 收敛成**只有 persona
  一节**——harness 身份块、Web 朝向、工具指引、运行时快照小节全部去掉，等价于
  上游 anchored preset 的 `complete` persona 效果。默认文本在上游 Minimal
  原句后追加两句：opener 约束（`When working on a task, always open your
  reasoning with We need.`，本机实测首链稳定 "We need understand…"）和工具
  解锁指引（`If a tool you need is not in your current tool list, do not
  conclude it is unavailable: after your first tool call, call dev_tool_search
  with no query to list every unlockable tool, then unlock the exact names.`）
   和“优先专用工具”行为提示（`Before doing work with bash or
   str_replace_editor, check dev_tool_search for a purpose-built tool and
   prefer it whenever one exists.`，针对模型能解锁却死磕 shell 的问题）。
  如需恢复上游逐字节原句，生成时
  `--bootstrap-persona-text "You are a helpful software engineer assistant."`。
  该 persona 保持**整个 session**（晋升后不恢复源 persona）。
- `dev_tool_search`（本地增强）：**不传 query（或 `query:"*"`）列出全部可解锁
  工具名**；单关键词搜索用 OR 评分（多词不再返回空）；`toolNames` 解锁时会
  校验名字并明确报告 unknown names——避免模型“搜不到就以为工具不存在”。
- `delegationDepthExempt: true`：子 agent 默认跳过 bootstrap、直接进入
  resident 目录（同样保持干净 persona 与解锁提示）；`--bootstrap-subagents`
  让子代理也走受控阶段。

## 快速开始

```sh
# Standard / Code / Cordis：自动检测，并自动补 Minimal 工具组 + 禁用 tool-bash
node tools/make-anchored-preset.mjs \
  --from "$DSH_HOME/.agent-presets/standard" \
  --to standard-anchored

# 从 harness 安装目录直接套壳 shipped preset：
node tools/make-anchored-preset.mjs \
  --from /path/to/dsh/apps/cli/config/agent-presets/standard \
  --to standard-anchored

# Cordis / 创造模式（进程级 Inspect provider，必须给守卫 bundle）：
node tools/make-anchored-preset.mjs \
  --from /path/to/dsh/apps/cli/config/agent-presets/cordis \
  --to creative-anchored \
  --guard-cordis-tools /path/to/dsh/apps/cli/node_modules/@deepseek-ai/dsh-tool-cordis/lib/index.js

# whoami-standard 流（anchor-turn 文本=你是谁；零工具预热回合，子代理也继承该锚定）：
node tools/make-anchored-preset.mjs --from standard --to standard-whoami --whoami

# 干跑，只打印计划：
node tools/make-anchored-preset.mjs --from standard --to standard-anchored --dry-run
```

生成后：**完全重启 DeepSeek Harness → 新建空白 session → 选择新 preset**。
不要中途热切换 preset。

## 验证

导出 session JSONL，检查 `request/header`：

- 第一个 header 只有 `bash` + `str_replace_editor`，且 system prompt 只有
  Minimal persona 一句（无 harness 身份块/工具指引/运行时快照小节）；
- 首个持久 `tool/call` 或 `assistant/message` 之后，下一个 header 变为
  resident 目录：`bash`、`str_replace_editor`、`dev_tool_search`、
  `skill_search`、`skill_load`（以及已解锁工具），**不是**完整目录；
- 调一次 `dev_tool_search({"toolNames":["read"]})` 后，再下一个 header 应
  出现 `read` 并持续保留；
- `compaction/end` 后 header 回落到 `bash` + `str_replace_editor` +
  `compactionTools`，直到新的晋升信号；
- Windows 上 header 的 `bash` 描述来自 `custom-bash`（Git Bash），且
  `bash -c 'echo hi'` 真实返回输出。

也可用 `node verify/run-verify.mjs --preset <id> --task "..." --stop-after-first-assistant`
在独立 headless 进程里对真实端点做一次性校验（打印每个 request/header 的
工具面与首个 assistant message 的 reasoning）。

## 与上游合并的流程

上游 `preset/`、`README*`、`test/` 的改动由 `Sync upstream` workflow 自动
rebase 进 `main` 并合并进 `agent-dev`（每 15 分钟 + 手动 dispatch）。手动
同步命令：

```sh
git fetch upstream
git switch main
git pull --ff-only origin main
git rebase upstream/main
git push --force-with-lease origin main
git switch agent-dev
git merge main
git push origin agent-dev
```

### 合并后必做：同步参数

上游实验一旦调整参数（例如 PR #10 的可配置 `suppressedContextSources`、
PR #14 的 Minimal 工具对、PR #27 的 resident/compaction 流），**不要直接改
代码**，先对照下面的映射：

| 上游位置 | 下游位置 |
|---|---|
| `preset/agent.cordis.yml` 的 `bootstrapTools` | 生成器默认检测/写入逻辑（`MINIMAL_BOOTSTRAP_TOOLS` 与 `detectBootstrapTools`） |
| `preset/agent.cordis.yml` 的 `promoteOn` | `template/defaults.json` → `promoteOn`（默认 `either`） |
| `preset/agent.cordis.yml` 的 `compactionTools` | `template/defaults.json` → `compactionTools` |
| `preset/agent.cordis.yml` 的 `bootstrapMaxTokens`（现在默认不设） | 生成器 opt-in 语义；默认不写该行 |
| `preset/agent.cordis.yml` 的 `suppressedContextSources` | `template/defaults.json` → `suppressedContextSources` |
| `preset/tool-bootstrap.mjs` 的 resident 集合 / 解锁 / epoch 语义 | `template/hook/tool-bootstrap.mjs` + `template/hook/compaction-epoch.mjs`（手动对照同步） |
| `preset/{instruction-hint,dev-tool-search,skill-search,custom-bash}.mjs` | `template/hook/` 同名文件（手动对照同步） |
| `shared/{zero-tool-bootstrap,anchor-turn}.mjs`（whoami/zero 两模式共用） | `template/hook/` 同名文件（`zero-tool-bootstrap` 的 import 改为 `./compaction-epoch.mjs`） |
| 插件对 `agent/pre-step` / `agent/request` 的 `prepend` 与降级语义 | `template/hook/tool-bootstrap.mjs`（手动对照同步） |

改完后重跑测试并重新生成 preset：

```sh
npm test
node tools/make-anchored-preset.mjs --from standard --to standard-anchored
```

## 约束与取舍

- 生成器对“无法自动确定小工具面”的源 preset **fail loud**，不会静默产出
  一个首请求不锚定的 preset；这时必须给 `--bootstrap-tools`。
- 源 preset 已有 `tool-bootstrap` / `zero-tool-bootstrap` 行时拒绝套壳。
- 晋升后不是完整目录：resident 目录 + `dev_tool_search` 按需解锁是上游
  PR #27 的用户实测结论。若确需两阶段旧行为（晋升即完整目录），不要在
  hook 上改回全量——那会拉回 standard 轨迹。
- **Windows 上不要用 PTY persistent bash**：本机 DSH 构建无 win32 PTY 后端
  （`subprocess-local: terminal inspection is unsupported on platform win32`）。
  生成器自动改用 `custom-bash`（普通子进程 Git Bash）；`--win-bash-path`
  指向实际安装路径。
- 钩子运行时对缺失 bootstrap 工具 fail-open（警告一次后暴露完整目录），
  不会 brick session。
- 源 preset 若注册进程级全局服务（如 cordis 的 `tool-cordis` 向 `cordisInspect`
  注册 Inspect provider），直接套壳会让副本与源 preset 在同一 DSH 进程只能
  挂载其一。此时必须给
  `--guard-cordis-tools <path>`（指向部署包的
  `<harness>/apps/cli/node_modules/@deepseek-ai/dsh-tool-cordis/lib/index.js`）：
  生成器会把该 bundle 复制进目标并打上两层守卫补丁、把行换成
  本地 `./tool-cordis-guarded.mjs`，工具与原版逐字节等价：
  1. 自身注册遇“already registered”时共享跳过；
  2. 向共享注册表的 `register` 安装进程级容错包装——之后任何 cordis 家族
     preset（包括原版）重复注册都变成共享 no-op，**任意挂载顺序都共存**。
- 生成的 preset 与 shell 同信任级；请审阅 `template/hook/tool-bootstrap.mjs`
  后再套用。
