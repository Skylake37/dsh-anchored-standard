# Anchor Hook Template

把上游 `preset/` 里的 anchored 机制做成**可复用的模板**：不修改任何上游文件，
只向现有 preset 上“套壳”，生成 `<preset>-anchored` 变体。所有下游自有文件都
集中在 `template/` 和 `tools/` 两个目录，上游合并不会碰它们。

## 文件布局

```
template/
  hook/tool-bootstrap.mjs   # 可复用钩子（生成时复制进每个目标 preset）
  defaults.json             # 下游自有参数，合并上游后在这里同步参数
  README.md                 # 本说明
tools/
  make-anchored-preset.mjs  # 一键套壳生成器（零依赖 Node ESM）
```

生成器会：

1. 把源 preset 目录整体复制到 `$DSH_HOME/.agent-presets/<to>`（默认
   `<source>-anchored`）；
2. 把 `template/hook/tool-bootstrap.mjs` 复制为目标的 `tool-bootstrap.mjs`；
3. 在目标 `agent.cordis.yml` 的**第一行 entry 之前**插入 `tool-bootstrap` 行
   （保持“先注册 → pre-step 剥离是最后一层 waterfall 变换”的顺序契约）；
4. 若源 preset 没有 Minimal 工具对（persistent `bash` +
   `str_replace_editor`），把上游 anchored preset 同款的 `persistent-shell`
   和 `bootstrap-filesystem` 两个 group 追加进去；同时禁用标准 `tool-bash`
   行，避免 `bash` 工具名注册两次（上游 PR #14 的做法）；
5. 改写目标的 `preset.yml`（name/description/order）。

## 当前 anchor 参数（上游 PR #14 / issue #11）

- `bootstrapTools: [bash, str_replace_editor]`：**官方 Minimal preset 的真实
  工具对**。issue #11 实测该 schema 在 adapter 默认 maxTokens（256000）下
  5/5 锚定，而所有 standard 家族 schema（pwsh/read、pwsh-only、sandboxed
  bash/read）11/11 落入 standard 行为。
- `bootstrapMaxTokens`：**opt-in**。默认不写这一行 → 首请求走 adapter 默认
  maxTokens，不 cap；显式 `--max-tokens` 才注入 cap（并保持 `prepend` 注册、
  晋升后释放）。
- `suppressedContextSources: [agent-instructions, skill-catalog]`：首请求剥离
  自动注入的 AGENTS.md 摘要和技能目录；空数组关闭剥离。
- `promoteOn: either`：首个 `tool/call` 或首个 `assistant/message` 先到者
  晋升。
- `delegationDepthExempt: true`（下游额外参数）：子 agent 首请求直接看到完整
  目录。

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

# Minimal 家族（已有 persistent-bash + str_replace_editor）：直接套，不补组
node tools/make-anchored-preset.mjs \
  --from /path/to/dsh/apps/cli/config/agent-presets/minimal \
  --to minimal-anchored

# 干跑，只打印计划：
node tools/make-anchored-preset.mjs --from standard --to standard-anchored --dry-run
```

生成后：**完全重启 DeepSeek Harness → 新建空白 session → 选择新 preset**。
不要中途热切换 preset。

## 验证

导出 session JSONL，检查 `request/header`：

- 第一个 header 只有 `bash` + `str_replace_editor`；
- 首个持久 `tool/call` 或首个 `assistant/message` 之后，下一个变化的 header
  应是完整目录，并且后续保持。

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
PR #14 的 Minimal 工具对和 opt-in cap），**不要直接改代码**，先对照下面的
映射：

| 上游位置 | 下游位置 |
|---|---|
| `preset/agent.cordis.yml` 的 `bootstrapTools` | 生成器默认检测/写入逻辑（`tools/make-anchored-preset.mjs` 的 `MINIMAL_BOOTSTRAP_TOOLS` 与 `detectBootstrapTools`） |
| `preset/agent.cordis.yml` 的 `promoteOn` | `template/defaults.json` → `promoteOn` |
| `preset/agent.cordis.yml` 的 `bootstrapMaxTokens`（现在默认不设） | 生成器 opt-in 语义；默认不写该行 |
| `preset/agent.cordis.yml` 的 `suppressedContextSources` | `template/defaults.json` → `suppressedContextSources` |
| 插件对 `agent/pre-step` / `agent/request` 的 `prepend` 与降级语义 | `template/hook/tool-bootstrap.mjs`（手动对照同步） |
| 插件对 promotion 事件集 / 缺失工具 fail-open 算法 | `template/hook/tool-bootstrap.mjs`（手动对照同步） |

改完后重跑测试并重新生成 preset：

```sh
node --test template/test
node tools/make-anchored-preset.mjs --from standard --to standard-anchored
```

## 约束与取舍

- 生成器对“无法自动确定小工具面”的源 preset **fail loud**，不会静默产出
  一个首请求不锚定的 preset；这时必须给 `--bootstrap-tools`。
- 源 preset 已有 `tool-bootstrap` 行时拒绝套壳（避免双 gate）。
- 源 preset 用非 Minimal persona 时，套出来的变体只保证“两阶段目录 + 上下文
  剥离 + 可选 token cap”机制，不保证复现上游评测里的完整 anchor 条件。
- 钩子运行时对缺失 bootstrap 工具 fail-open（警告一次后暴露完整目录），
  不会 brick session。
- 源 preset 若注册进程级全局服务（如 cordis 的 `tool-cordis` 向 `cordisInspect`
  注册 Inspect provider），套壳副本与源 preset 在同一 DSH 进程只能挂载其一
  ——先开者胜，后开者挂载失败。这是部署层单例注册的约束，模板无法消除；
  处理办法是每进程只用一个（重启切换），或手工移除该行（失去对应工具）。
- 生成的 preset 与 shell 同信任级；请审阅 `template/hook/tool-bootstrap.mjs`
  后再套用。
