# Anchor Hook Template

把上游 anchored 机制做成**可复用的模板**：不修改任何上游文件，只向现有
preset 上“套壳”，生成新 preset 或原位 patch。所有下游自有文件集中在
`template/` 和 `tools/` 两个目录。

当前只有一个 gate hook：`anchor-bootstrap.mjs`，三种模式 profile：
`anchored` / `zero` / `whoami`。hook 的完整模式表、配置键、每个文件的职责见
[`hook/README.md`](./hook/README.md)；原子机理分类与合并设计见
[`research/mode-merge-analysis.md`](./research/mode-merge-analysis.md)。

## 快速开始

```pwsh
cd D:\Skills\dsh-anchored-standard

# 生成 zero 模式 preset（当前推荐）
node tools/make-anchored-preset.mjs --from <source-dir-or-id> --to <new-id> --mode zero

# 原位 patch 一个已有 preset（例如 matlab-agentic-preset）
node tools/patch-preset-in-place.mjs --target <preset-dir> --mode zero --name '<display-name>'

# 干跑，只打印计划
node tools/make-anchored-preset.mjs --from standard --to standard-zero --mode zero --dry-run
```

生成后：**完全重启 DeepSeek Harness → 新建空白 session → 选择新 preset**。
不要中途热切换 preset。

## 生成器做什么

1. 复制源 preset 到 `$DSH_HOME/.agent-presets/<to>`；
2. 写入 `anchor-bootstrap.mjs` 及伴生 hooks，并插入第一行 entry 之前；
3. 若源 preset 没有 Minimal 工具对，追加 `persistent-shell` 与
   `bootstrap-filesystem`，Windows 上改用 `custom-bash`；
4. 禁用源 `agent-instructions` / `tool-skill`，由
   `instruction-hint` / `skill-search` 接管；
5. 改写 `preset.yml`（name/description/order）。

## 与上游合并的同步映射

| 上游位置 | 下游位置 |
|---|---|
| `preset/agent.cordis.yml` 的 bootstrap/promote/compaction 参数 | `template/defaults.json` + `tools/make-anchored-preset.mjs` 的 `MODE_PROFILES` |
| `preset/tool-bootstrap.mjs` 的 resident / epoch / 解锁语义 | `template/hook/anchor-bootstrap.mjs`（本地为超集） |
| `shared/zero-tool-bootstrap.mjs` + `shared/anchor-turn.mjs` | 已合并进 `template/hook/anchor-bootstrap.mjs` |
| `shared/{compaction-epoch,custom-bash,dev-tool-search,instruction-hint,skill-search}.mjs` | `template/hook/` 同名文件（`dev-tool-search` 为本地增强版） |

改完重跑 `npm test` / `npm run check`，并重新生成安装态。

## 验证

导出 session JSONL，检查 `request/header`：首请求工具面、合成 anchor（zero /
whoami）、晋升后 resident 目录、`compaction/end` 回落，以及 Windows 上
`custom-bash` 是否真实可执行。完整验证方法和真机命令见
[`hook/README.md`](./hook/README.md) 与 `verify/run-verify.mjs`。

## 约束与取舍

- 源 preset 已挂 `anchor-bootstrap` / `tool-bootstrap` /
  `zero-tool-bootstrap` 时拒绝套壳。
- 晋升后不是完整目录；resident + `dev_tool_search` 按需解锁是实测结论。
- **Windows 上不要用 PTY persistent bash**；生成器自动改用 `custom-bash`。
- 含 `tool-cordis` 的源 preset 必须给 `--guard-cordis-tools`，否则 fail loud。
- 生成的 preset 与 shell 同信任级；请审阅 `template/hook/anchor-bootstrap.mjs`。
