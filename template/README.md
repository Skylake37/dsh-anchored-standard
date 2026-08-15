# Anchor Hook Template

把上游 `preset/` 里的 anchored 机制做成**可复用的模板**：不修改任何上游文件，
只向现有 preset 上“套壳”，生成 `<preset>-anchored` 变体。所有下游自有文件都
集中在 `template/` 和 `tools/` 两个目录，上游合并不会碰它们。

下游默认生成**全轮次锚定（promoteOn: never）**的 preset：整个 session 的每
一次请求都保持 Minimal 系统提示 + Minimal 工具对 + 无自动注入 context，因此
思维链全程稳定 `We need` 开头（上游 issue #16 minimal-turbo 的结论，也是
issue #17/#18 记录的两阶段方案“晋升后回到 Let me”的解法）。需要两阶段行为
（首请求锚定、晋升后恢复完整目录）时传 `--promote-on either`。

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

## 当前 anchor 参数（上游 PR #14 / issue #11 + 下游全轮次扩展）

- `bootstrapTools: [bash, str_replace_editor]`：**官方 Minimal preset 的真实
  工具对**。issue #11 实测该 schema 在 adapter 默认 maxTokens（256000）下
  5/5 锚定，而所有 standard 家族 schema（pwsh/read、pwsh-only、sandboxed
  bash/read）11/11 落入 standard 行为。
- `bootstrapMaxTokens`：**opt-in**。默认不写这一行 → 首请求走 adapter 默认
  maxTokens，不 cap；显式 `--max-tokens` 才注入 cap（并保持 `prepend` 注册、
  晋升后释放）。
- `suppressedContextSources: [agent-instructions, skill-catalog]`：剥离自动
  注入的 AGENTS.md 摘要和技能目录；空数组关闭剥离。
- `suppressedContextPlugins: [@deepseek-ai/dsh-system-prompt]`：同时剥离
  运行时上下文快照消息（下游扩展）。
- `bootstrapPersonaText`（下游扩展）：bootstrap 阶段把 system prompt 收敛成
  **只有 persona 一节**的 Minimal 原句——harness 身份块、Web 朝向、工具指引、
  运行时快照小节全部去掉，等价于上游 anchored preset 的 `complete` persona
  效果。实测决定首轮风格的就是“工具面相同前提下的 system prompt 与注入
  context”，这一节收敛是锚定复现的必要条件（对 `complete` persona 的源
  preset 由注册表强制恢复，hook 自动跳过）。
- `promoteOn: never`（下游默认）：**永晋升**——每个顶层请求都保持上述
  bootstrap 条件，思维链全程 `We need`；`either`/`tool-call`/
  `assistant-message` 恢复上游两阶段语义（晋升后回到 `Let me`，见 issue
  #17/#18）。
- `delegationDepthExempt: true`：子 agent 始终看到完整阶段。

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

# Cordis / 创造模式（进程级 Inspect provider，必须给守卫 bundle）：
node tools/make-anchored-preset.mjs \
  --from /path/to/dsh/apps/cli/config/agent-presets/cordis \
  --to creative-anchored \
  --guard-cordis-tools /path/to/dsh/apps/cli/node_modules/@deepseek-ai/dsh-tool-cordis/lib/index.js

# 两阶段上游语义（首请求锚定，晋升后恢复完整目录）：
node tools/make-anchored-preset.mjs --from standard --to standard-anchored --promote-on either

# 干跑，只打印计划：
node tools/make-anchored-preset.mjs --from standard --to standard-anchored --dry-run
```

生成后：**完全重启 DeepSeek Harness → 新建空白 session → 选择新 preset**。
不要中途热切换 preset。

## 验证

导出 session JSONL，检查 `request/header`：

- 第一个 header 只有 `bash` + `str_replace_editor`，且 system prompt 只有
  Minimal persona 一句（无 harness 身份块/工具指引/运行时快照小节）；
- 默认 `never` 模式下，**每一个**后续 header 都保持同样的小工具面与小
  persona；思维链逐轮检查应全部 `We need` 开头、无 `let me`；
- `--promote-on either` 生成的两阶段变体则相反：首个持久 `tool/call` 或
  `assistant/message` 之后的下一个 header 变为完整目录，后续轮次预期回到
  standard 风格（issue #17/#18 实测）。

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
PR #14 的 Minimal 工具对和 opt-in cap），**不要直接改代码**，先对照下面的
映射：

| 上游位置 | 下游位置 |
|---|---|
| `preset/agent.cordis.yml` 的 `bootstrapTools` | 生成器默认检测/写入逻辑（`tools/make-anchored-preset.mjs` 的 `MINIMAL_BOOTSTRAP_TOOLS` 与 `detectBootstrapTools`） |
| `preset/agent.cordis.yml` 的 `promoteOn` | `template/defaults.json` → `promoteOn`（下游默认 `never` = 全轮次锚定；上游合并后若仍要两阶段语义，显式改回 `either`） |
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
- 默认 `never` 模式下，源 preset 的完整工具目录（含 persona 扩展与
  cordis/子代理等工具）**永不暴露**——这是 issue #16 实测“全程 We need”
  的代价。需要工具与锚定兼顾时用 `--promote-on either` 回到两阶段，或按
  minimal-turbo 的做法用 `--bootstrap-tools` 显式加入少量额外工具
  （如 `bash,str_replace_editor,pwsh`，Windows 上持久 bash 不可用时尤其
  推荐，见下）。
- 本机部署（0.1.0-rc.5 预构建）在 Windows 上**持久 bash 工具不可用**
  （`subprocess-local: terminal inspection is unsupported on platform win32`：
  该构建没有 win32 PTY 后端），它只作为锚定 schema 存在；如需可执行的 shell，
  给 `--bootstrap-tools` 加上 `pwsh`（issue #16 minimal-turbo 的 Windows
  适配做法，其截图显示加 pwsh 后仍为 we 风格）。
- 钩子运行时对缺失 bootstrap 工具 fail-open（警告一次后暴露完整目录），
  不会 brick session。
- 源 preset 若注册进程级全局服务（如 cordis 的 `tool-cordis` 向 `cordisInspect`
  注册 Inspect provider），直接套壳会让副本与源 preset 在同一 DSH 进程只能
  挂载其一（先开者胜，后开者整体挂载失败）。此时必须给
  `--guard-cordis-tools <path>`（指向部署包的
  `<harness>/apps/cli/node_modules/@deepseek-ai/dsh-tool-cordis/lib/index.js`）：
  生成器会把该 bundle 复制进目标并打上两层守卫补丁、把行换成
  本地 `./tool-cordis-guarded.mjs`，工具与原版逐字节等价：
  1. 自身注册遇“already registered”时共享跳过；
  2. 向共享注册表的 `register` 安装进程级容错包装——之后任何 cordis 家族
     preset（包括原版）重复注册都变成共享 no-op，**两个方向的开挂载顺序
     都共存**。否则“梁圣版先开、原生创造模式后开”会让原生 preset 整体
     挂载失败，旧 cordis session 恢复失败（表现之一：模型选择器不可用）。
- 生成的 preset 与 shell 同信任级；请审阅 `template/hook/tool-bootstrap.mjs`
  后再套用。
