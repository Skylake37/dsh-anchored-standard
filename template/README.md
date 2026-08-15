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
4. 改写目标的 `preset.yml`（name/description/order）。

钩子支持两种工具面配置（互斥）：

- `bootstrapTools: [...]`：精确首请求工具列表，适合任意 preset；
- `shellTools` + `commonTools`：legacy 模式，要求恰好一个可用 shell + 全部
  common 工具，否则 fail-open 到完整目录并告警一次。

其余参数与上游 `preset/tool-bootstrap.mjs` 对齐：
`promoteOn`、`bootstrapMaxTokens`、`suppressedContextSources`（空数组表示关闭
上下文剥离），另加 `delegationDepthExempt`（默认 true：子 agent 首请求直接
看到完整目录）。

## 快速开始

```sh
# Standard / Code / Cordis 这类有 bash/pwsh + read 的 preset，自动检测：
node tools/make-anchored-preset.mjs \
  --from "$DSH_HOME/.agent-presets/standard" \
  --to standard-anchored

# 从 harness 安装目录直接套壳 shipped preset：
node tools/make-anchored-preset.mjs \
  --from /path/to/dsh/apps/cli/config/agent-presets/standard \
  --to standard-anchored

# 没有 read/bash 的 preset（如 Minimal）必须显式给 bootstrapTools：
node tools/make-anchored-preset.mjs \
  --from /path/to/dsh/apps/cli/config/agent-presets/minimal \
  --to minimal-anchored \
  --bootstrap-tools persistent-bash

# 干跑，只打印计划：
node tools/make-anchored-preset.mjs --from standard --to standard-anchored --dry-run
```

生成后：**完全重启 DeepSeek Harness → 新建空白 session → 选择新 preset**。
不要中途热切换 preset。

## 验证

导出 session JSONL，检查 `request/header`：

- 第一个 header 只有 bootstrap 工具；
- 首个持久 `tool/call` 或首个 `assistant/message` 之后，下一个变化的 header
  应是完整目录，并且后续保持。

## 与上游合并的流程

本分支只新增 `template/`、`tools/`，所以上游 `preset/`、`README*`、`test/`
的改动会干净合并。常规同步：

```sh
git fetch upstream
git checkout main
git merge --ff-only upstream/main     # fork main 保持与上游一致
git checkout feature/anchor-template
git merge main                        # 或 git rebase main
```

### 合并后必做：同步参数

上游实验一旦调整参数（例如 2026-08 的 PR #10 把剥离名单改成了可配置的
`suppressedContextSources`），**不要直接改代码**，先对照下面的映射，把新值写
进 `template/defaults.json`：

| 上游位置 | 下游位置 |
|---|---|
| `preset/agent.cordis.yml` 的 `promoteOn` | `template/defaults.json` → `promoteOn` |
| `preset/agent.cordis.yml` 的 `bootstrapMaxTokens` / 插件 `DEFAULT_BOOTSTRAP_MAX_TOKENS` | `template/defaults.json` → `bootstrapMaxTokens` |
| 插件 `DEFAULT_SUPPRESSED_SOURCES` 或 `suppressedContextSources` | `template/defaults.json` → `suppressedContextSources` |
| 插件对 `agent/pre-step` 的注册选项、降级语义 | `template/hook/tool-bootstrap.mjs`（手动对照同步） |
| 插件对 promotion 事件集 / 工具面选择的算法 | `template/hook/tool-bootstrap.mjs`（手动对照同步） |

只有最后两行需要改代码；前几行都只改 JSON。改完后重跑测试并重新生成 preset：

```sh
node --test template/test
node tools/make-anchored-preset.mjs --from standard --to standard-anchored
```

## 约束与取舍

- 生成器对“无法自动确定小工具面”的源 preset **fail loud**，不会静默产出
  一个首请求不锚定的 preset；这时必须给 `--bootstrap-tools`。
- 源 preset 已有 `tool-bootstrap` 行时拒绝套壳（避免双 gate）。
- 源 preset 用非 Minimal persona 时，套出来的变体只保证“两阶段目录 + token
  cap + 上下文剥离”机制，不保证复现上游评测里的完整 anchor 条件。
- 钩子运行时对缺失 bootstrap 工具 fail-open（警告一次后暴露完整目录），
  不会 brick session。
- 生成的 preset 与 shell 同信任级；请审阅 `template/hook/tool-bootstrap.mjs`
  后再套用。
