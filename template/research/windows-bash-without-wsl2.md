# Windows 10/11 上让 DeepSeek Harness 的 `persistent bash` 真正执行（无 WSL2）

> 研究结论文档。全部证据来自第一手来源：本机 harness 源码 checkout（`D:\Harness\deepseek-harness`）、node-pty 仓库内 vendored README/typings、Microsoft 官方 ConPTY 文档、Git for Windows / MSYS2 / BusyBox-w32 官方站点。
> 本机可直接核对的源码用 `路径:行号` 标注；外部 URL 用链接标注。未亲自读到的第一手内容一律标注「未核实」，不臆造。

---

## 结论摘要

`persistent bash` 在 Windows 上失败的根因**不是** node-pty（node-pty 本身已带 win32 ConPTY 预编译二进制，Windows 上可用），而是 `subprocess-local` 的 `ProcessInspector` 只实现了 Linux（`/proc`）与 macOS（`/bin/ps`）两条路径，`spawnTerminal` 在 win32 上无条件调用 `createProcessInspector()` 直接抛错。**推荐方案**：在用户自己的 preset 里新增一个**自定义 `TerminalBackend` 插件**（实现 `TerminalBackend` 接口、直接用 node-pty ConPTY 驱动 Git for Windows / MSYS2 的 `bash.exe`），替换 `persistent-shell` 组里的 `terminal-bash` 行——`tool-bash-persistent` 与 `pty` 注册表无需改动，全程不碰 shipped harness、不装 WSL2。若只求「能跑 ls/cat/sed/grep/find」且可放弃持久状态，退而求其次用**普通子进程 shim**（`ctx.subprocess.spawn` + Git Bash `bash.exe -c`）最省事；`python`/`pip` 需额外装 MSYS2 `python-pip` 或让 Windows Python 进 PATH。harness 本身**没有**任何第一方 Windows 持久终端后端（唯一第一方 Windows shell 是非持久、非 PTY 的 `tool-pwsh`）。

---

## 问题根因

错误字符串 `subprocess-local: terminal inspection is unsupported on platform win32` 精确产自：

- `packages/subprocess/subprocess-local/src/process-inspector.ts:366-374` — `createProcessInspector()`：
  ```ts
  export function createProcessInspector(platform = process.platform, arch = process.arch, internals = DEFAULT_INTERNALS): ProcessInspector {
    if (platform === 'linux') return new LinuxProcessInspector(arch, internals)   // :371
    if (platform === 'darwin') return new MacProcessInspector(internals)          // :372
    throw new Error(`subprocess-local: terminal inspection is unsupported on platform ${platform}`) // :373
  }
  ```
- `packages/subprocess/subprocess-local/src/index.ts:161-184` — `spawnTerminal()` 在分配 PTY 时**无条件**构造 inspector（第 174 行），随后才 `nodePty.spawn(...)`（第 175 行）：
  ```ts
  const inspector = this.terminalInspector ?? createProcessInspector()  // :174
  const terminal = nodePty.spawn(file, [...spec.argv.slice(1)], options) // :175
  ```

`ProcessInspector` 需要的能力（`process-inspector.ts:14-25`）全部是 POSIX 语义：`foregroundPgid`、`isStdinWaiting`、`processTree`、`processSession`、`isAlive`、`signalGroup`、`signalProcess`。实现层面：`LinuxProcessInspector` 读 `/proc/<pid>/stat`、`/proc/<pid>/task/<tid>/syscall`、`/proc/<pid>/fdinfo`（`process-inspector.ts:273-319`、`82-227`）；`MacProcessInspector` 调 `/bin/ps`（`process-inspector.ts:331-357`）。**没有任何 win32 分支。**

调用链（为什么 persistent bash 会走到这里）：

1. `minimal` preset 的 `persistent-shell` 组（`apps/cli/config/agent-presets/minimal/agent.cordis.yml:18-44`）装了 `pty`（`@deepseek-ai/dsh-terminal`）+ `terminal-bash`（`@deepseek-ai/dsh-terminal-bash`）+ `persistent-bash`（`@deepseek-ai/dsh-tool-bash-persistent`）。用户自己的 `anchored-standard` 保留了同款 `persistent-shell` 组（`D:\Skills\dsh-anchored-standard\preset\agent.cordis.yml:107-133`）。
2. `terminal-bash` 声明 `inject = ['terminals', 'sandboxPolicy', 'subprocess']`（`terminal-bash/src/index.ts:25`），并默认把 `spawnTerminal` 委托给宿主 `subprocess`：`spec => ctx.subprocess.spawnTerminal(spec)`（`terminal-bash/src/index.ts:108-110`），在 `spawn()` 里调用（`terminal-bash/src/index.ts:125-133`）。
3. 宿主的 `subprocess` 服务是 `@deepseek-ai/dsh-subprocess-local`，由宿主 composition 挂载（`packages/bundle/base/cordis.patch.yml:163-164`）。
4. 于是 `tool-bash-persistent` 一开 shell → `terminals.spawn(type:'shell')` → `terminal-bash` 后端 → `ctx.subprocess.spawnTerminal` → `subprocess-local.spawnTerminal` → `createProcessInspector()` → win32 抛错。

补充：`terminal-bash` 的默认 shell 是 `/bin/bash`、参数 `--noprofile --norc -i`（`terminal-bash/src/config.ts:46-47`），`tool-bash-persistent` 初始化还会执行 `stty -echo; PS1=...`（`tool-bash-persistent/src/index.ts:247`）——这些 bash-ism 在 Windows 上都需要一个真正的 bash（Git Bash / MSYS2 自带 `stty`）。

---

## 方案矩阵

| 方案 | 提供什么 | 前置条件 | 持久状态 / PTY 保真度 | 安装占用 | 许可证 | 证据 |
|---|---|---|---|---|---|---|
| **A. ConPTY / node-pty 自定义 `TerminalBackend`**（推荐） | 真 PTY（ConPTY），持久 shell 状态、交互 stdin、Ctrl+C、prompt 探测，完全复刻 Linux 版 persistent bash 的行为 | Git Bash 或 MSYS2 的 `bash.exe`；node-pty 已随 harness 依赖（win32 ConPTY 预编译已在本机 pnpm store 内，无需本地编译） | 高：持久 cwd/env、交互 stdin；无 POSIX「前台进程组」概念（见「Harness 集成面」），就绪探测降级为 prompt 标记 + 输出静默 | 无新二进制（复用 node-pty）；bash 由 Git/MSYS2 提供 | node-pty MIT；bash 随发行版 | node-pty README `:12`「supports Linux, macOS and Windows… conpty API on Windows 1809+ and winpty」；typings `node-pty.d.ts:90-96`（`useConpty`）；`prebuilds/win32-x64/{conpty.node,winpty.dll,pty.node}` 已存在 |
| **B. Git for Windows 普通子进程 shim**（最简，无 PTY） | 一次性 `bash.exe -c '…'`；ls/cat/sed/grep/find/git 全在；无持久状态、无交互 stdin | 安装 Git for Windows；把 `bash.exe` 路径写进插件配置 | 低：每次调用是全新进程，cwd/env 不跨调用保留；无 PTY | ~几百 MB（Git for Windows 安装包） | Git GPLv2（发行版含 MSYS2 运行时，各组件许可不一，需按安装组件确认） | gitforwindows.org；`bash-local` 已示范「`ctx.subprocess.spawn` + `['bash','-c',cmd]`」模式（`bash-local/src/index.ts:212`），只需把 `bash` 换成绝对路径 `bash.exe` |
| **C. MSYS2 完整发行版** | Git Bash 的超集：`pacman` 可装 `python`/`pip`/`make`/`gcc` 等，满足「python/pip」需求 | 独立安装 MSYS2，`pacman -S bash coreutils sed grep findutils python-pip` | 同 A（配合 node-pty ConPTY 后端），或同 B（子进程 shim） | 较大（基础几百 MB，加工具链可上 GB） | 各包独立（coreutils/bash 为 GPLv3，见 packages.msys2.org） | msys2.org；`packages.msys2.org/packages/base`、`/package/coreutils`；`msys2.org/docs/filesystem-paths/`（路径转换） |
| **D. BusyBox-w32** | 单个/少量独立 `.exe`（`busybox.exe`，内置 ash shell、coreutils 子集） | 下载解压即用；无 bash（是 `ash`）、无 python、无 pip | 低：`ash` 可交互但非 bash；`tool-bash-persistent` 依赖 bash 语法与 `stty`，需改造 | 极小的几个 `.exe`（< 2 MB） | BusyBox GPLv2 | github.com/rmyorston/busybox-w32；frippery.org/busybox/ |
| **E. harness 原生后端/配置** | **不存在**。无第一方 Windows 持久终端后端；唯一第一方 Windows shell 是 `tool-pwsh`（普通子进程、非持久、非 PTY），由宿主层 win32 交换启用 | 无（仅 pwsh） | 无持久 bash | 0 | — | `packages/bundle/base/cordis.patch.yml:210-216`（`tool-bash` 在 win32 `disabled`，`tool-pwsh` 反之）；`shell/src/index.ts:16-18`（win32 层把 POSIX 行换成 pwsh）；全仓 grep 无 `conpty`/`winpty`/win32 终端后端 |

要点说明：

- **node-pty 在 Windows 上本来就可用**：vendored README 明确「supports Linux, macOS and Windows … Windows conpty API on Windows 1809+ and winpty」（`node_modules/.pnpm/node-pty@1.1.0_*/node_modules/node-pty/README.md:12`），且本机 pnpm store 已带 `win32-x64` 预编译（`conpty.node`、`winpty.dll`、`pty.node`、`conpty/conpty.dll`、`conpty/OpenConsole.exe`）。所以「ConPTY 后端」的难点**不是** ConPTY 本身，而是 harness 的 `ProcessInspector` 没有 win32 实现。
- **node-pty 在 Windows 上的限制**：`IPty.kill(signal)` 的信号参数在 Windows 不支持、传入会抛（typings `node-pty.d.ts:178-184`）；`IPty.pid` 是外层进程 pid（`:116-120`）；输出/退出走 `onData`/`onExit`（`:149-155`）。**没有** `processGroupId` / `inputWaiting` 这类 POSIX 前台进程组概念——这决定了后端必须自行实现就绪探测与取消语义（见下）。
- **MSYS 路径转换是真实坑**：MSYS2/Git Bash 会把命令行参数里 POSIX 形路径（如 `/workspace/…`）自动转成 Windows 路径，可通过 `MSYS_NO_PATHCONV=1` 关闭，见 `msys2.org/docs/filesystem-paths/`。同时 Git Bash 把 `D:\…` 挂成 `/d/…`，`cwd`（来自 `spec.cwd ?? policy.workspaceRoot`，Windows 形路径）需按 node-pty 的 `cwd` 参数以 Windows 形传入。
- **python/pip 不在 Git Bash 默认安装里**（Git for Windows 只带 Git + 核心 POSIX 工具），要 `python`/`pip` 需：MSYS2 `pacman -S python-pip`，或把 Windows Python 加入 `bash.exe` 进程的 `PATH`。

---

## Harness 集成面

### `TerminalBackend` 接口（可直接由 preset 提供）

`packages/terminal/terminal/src/types.ts`：

- `TerminalBackend`（`:166-171`）只需两样：`readonly type: string` + `spawn(spec): Promise<TerminalBackendSession>`。
- `TerminalBackendSession`（`:148-163`）需实现：`motd`、`pid?`、`startSend(request)`、`read(request)`、`signal(signal)`、`status()`、`close(reason)`。
- `TerminalSendOperation`（`:94-101`）：`done`（`Promise<TerminalSendResult>`）、`readOutput()`、`cancel()`。
- `TerminalSendResult`（`:82-91`）携带 `viewport`、`waitReason`（`stdin_read`|`inferred_idle`|`timeout`|`session_exit`，`:29`）、`sessionStatus`、`truncated`。

注册点：`TerminalSessionService.registerBackend(backend)`（`terminal/src/index.ts:125-137`），按 `backend.type` 去重（重复抛 `DUPLICATE_BACKEND`）。spawn 时按 `request.type` 选后端（`terminal/src/index.ts:158-159`）。

**关键结论：`TerminalBackend` 契约完全不要求前台进程组 / POSIX 信号。** 那些是 `SubprocessTerminalHandle`（subprocess 能力面）的要求（`subprocess/src/types.ts:235-264`：`inspectForeground`→`SubprocessTerminalForeground{processGroupId,inputWaiting}`（`:222-227`）、`signalForeground`、`terminate`）。一个自定义后端**可以完全绕开 `ctx.subprocess.spawnTerminal`**，直接用 node-pty ConPTY，从而永不触碰 `createProcessInspector`。

### preset 能否自带后端插件行

能。`terminals` 是「entry-local」服务（`minimal/agent.cordis.yml:18-23` 的 `isolate: terminals: true`；`anchored-standard` 同款 `preset/agent.cordis.yml:107-111`）。preset 在自己的 `persistent-shell` 组里**换掉 `terminal-bash` 行**、换成自定义后端插件行即可；`pty`（注册表）与 `persistent-bash`（工具）两行原样保留。

- `tool-bash-persistent` 只依赖 `['tools','terminals']`（`tool-bash-persistent/src/index.ts:402`），用 `config.backendType`（默认 `'shell'`，`:418`）去 `ctx.terminals.spawn(owner, { type })`（`:234-237`）。**后端类型可任意指**——只要自定义后端注册在 `type: 'shell'`（或把 `persistent-bash` 的 `backendType` 配成新类型），工具零改动。
- 插件行有两条形态（见 `packages/preset/agent-presets/src/mount.ts:66-91` 的 `PresetTree.import`）：
  1. **裸包名**（`name: '@scope/dsh-terminal-win'`）→ 从 harness 的 node_modules 解析（`mount.ts:86-91`），包的自身依赖（`node-pty`、`@deepseek-ai/dsh-terminal`）也在 harness node_modules 内正常解析。**这是最干净的做法**，但需要把包装进 harness 依赖。
  2. **相对路径**（`name: './terminal-win.mjs'`）→ 从 preset 目录解析（`mount.ts:86` 走 `super.import`）。**注意**：这个 override 只解决「行名 → 插件模块」的解析；插件模块**自己**的 `import 'node-pty'` 由 Node 按该 `.mjs` 文件位置向上走 node_modules，preset 在 `$DSH_HOME/.agent-presets/<id>/` 下**够不到** harness 的 node_modules（`mount.ts:69-71` 注释原话）。所以纯 `./foo.mjs` 方案里，`node-pty` 必须用绝对/动态路径指到 harness（脆弱），或该 `.mjs` 干脆不 import node-pty（改用 `ctx.subprocess.spawn`，即方案 B）。本地 `.mjs` 无 import 的范例：`D:\Skills\dsh-anchored-standard\preset\tool-bootstrap.mjs`。
- **preset 唯一做不到的是替换宿主 `subprocess` 服务**：它是宿主 plane 单例（`base/cordis.patch.yml:163-164`；`subprocess/src/index.ts:74-78` 注明「loading a second throws」）。所以「给 `subprocess-local` 加 win32 `ProcessInspector`」这条路属于**宿主 composition 改动**，不是 preset 能做的事——方案 A 选择直接绕开它，正是为了保持「零宿主改动」。

### 自定义后端的就绪/取消语义（ConPTY 下的等价物）

对照 Linux 版 `LocalPtySession`（`terminal-bash/src/session.ts`），它唯一两处 POSIX 依赖是：

1. `inspectForeground()`（`session.ts:263`、`:440`）——用于判定「shell 已回到提示符并等输入」（`stdin_read`）。ConPTY 无此信息；自定义后端可用**输出中的 prompt 标记 + 静默超时**替代：`tool-bash-persistent` 已把 `PS1` 设成固定串 `__DSH_PERSISTENT_BASH_PROMPT__ `（`tool-bash-persistent/src/index.ts:18`、`:247`），后端检测到该串尾随静默即可结算 `stdin_read`（等价于 `session.ts:446-449` 的 `promptSeen && promptTextSeen` 分支）。
2. `signalForeground('SIGINT')`（`session.ts:532`，用于取消/超时打断）。ConPTY 下 `pty.kill(signal)` 不支持；SIGINT 用 `pty.write('\x03')`（ETX/Ctrl+C）实现，SIGTERM/SIGKILL/SIGHUP 用 `pty.kill()`（无参）终止 shell。`targetPgid` 返回值退化为返回 `pty.pid`（`TerminalSignalResult` 仍需一个数字，`terminal/src/types.ts:126-131`）。

这样，`waitReason` 四值仍可全部提供：`stdin_read`（prompt 标记）、`inferred_idle`（输出静默）、`timeout`（绝对 deadline）、`session_exit`（`onExit`）。

---

## 推荐实现设计（无 WSL2、尽量零 shipped-harness 改动）

### 首选：方案 A —— preset 内自定义 ConPTY `TerminalBackend`

**新增一个插件包** `@scope/dsh-terminal-win`（或放入 preset 自身的 `package.json` 依赖后 `pnpm install`），内容近似：

```js
// 伪码，非完整实现
import * as pty from 'node-pty'
export const name = 'terminal-win'
export const inject = ['terminals']          // 仅注册表；不碰 subprocess

export function apply(ctx, config) {
  ctx.terminals.registerBackend({
    type: config.backendType ?? 'shell',
    async spawn(spec) {
      const term = pty.spawn(config.shellPath /* e.g. 'C:\\Program Files\\Git\\usr\\bin\\bash.exe' */,
        config.shellArgs ?? ['--login', '-i'],
        { name: 'dumb', cols: 160, rows: 40, cwd: spec.cwd, env,
          useConpty: true /* Windows 1809+；老系统回退 winpty */ })
      return new WinBashSession(term)   // 实现 TerminalBackendSession
    },
  })
}
```

`WinBashSession` 实现 `TerminalBackendSession`（`terminal/src/types.ts:148-163`），内部维护：
- 有界 scrollback（可照抄 `terminal-bash/src/session.ts:40-75` 的 `BoundedTextBuffer` 思路）；
- `startSend`：`term.write(text + (submit ? '\r' : ''))`，然后轮询输出直到 prompt 标记 / 静默 / 超时 / `onExit`，结算对应 `waitReason`；
- `cancel()`/`signal('SIGINT')`：`term.write('\x03')`；`signal(其他)`：`term.kill()`（无参）；
- `status()` 由 `onExit` 维护；`close()` 调 `term.kill()` 并等 `onExit`。

**preset 里要改的文件**（`D:\Skills\dsh-anchored-standard\preset\agent.cordis.yml` 的 `persistent-shell` 组，`:107-133`）：

1. 把 `terminal-bash` 行（`:116-119`）替换为自定义后端行 `- id: terminal-win\n  name: '@scope/dsh-terminal-win'\n  config: { shellPath: '<bash.exe 绝对路径>' }`。
2. `pty` 行（`:113-114`）与 `persistent-bash` 行（`:121-133`）**保持不变**（`backendType` 默认 `shell` 即命中自定义后端）。
3. `persistent-bash` 的 `description`（`:125-133`）可顺手改掉「apt/pip mirror」等 Linux 专属措辞。
4. 无需改 `tool-bash`（`:88-95`，已 `disabled: true`）与宿主 composition。

**前置安装**：Git for Windows（取 `usr\bin\bash.exe` 或 `bin\bash.exe`，用 `--login` 让 `/etc/profile` 建好 PATH）；如需 python/pip 再装 MSYS2 `python-pip` 或给 `bash.exe` 的 env 追加 Windows Python 目录。**环境变量**建议设 `MSYS_NO_PATHCONV=1` 规避参数路径自动转换（msys2.org/docs/filesystem-paths/）。

**验证**：重启 DSH → 新 session → 选 preset → 调 `bash` 跑 `pwd; echo $PS1; ls; sed; grep; find`，确认有真实输出且状态跨调用保持（`export X=1` 后下一调用 `echo $X`）。

### 次选：方案 B —— 普通子进程 bash shim（放弃持久状态）

不装 `pty`/`terminal-bash`，改为一个**新的 `bash` 工具插件**，内部走 `ctx.subprocess.spawn`（普通 seam，Windows 上可用，树终止走 `taskkill /T`，见 `subprocess/src/types.ts:163-164`）：

```js
// 伪码：一个与 bash-local 同构、但显式指定 Git Bash 路径的 bash 工具
ctx.subprocess.spawn({ argv: [config.bashPath, '-c', command], cwd, stdio: {...collect...}, graceMs, signal })
```

参照 `bash-local/src/index.ts:212`（`run` 用 `['bash','-c',cmd]`）与 `:173-198`（`spawnSpec` 的 collect/spill/env 设置），把 argv[0] 换成绝对 `bash.exe` 路径即可。**取舍**：每次调用全新进程（无持久 cwd/env）、无交互 stdin、`python`/`pip` 同样要额外装。适合「只要能执行 ls/cat/sed/grep/find」的最小场景。

### 不可取 / 需宿主改动的路径

- **给 `subprocess-local` 补 win32 `ProcessInspector`**：技术可行（用 Win32 `GetConsoleProcessList`/Job Object/`tasklist` 近似前台进程与 stdin 等待），但 `subprocess` 是宿主 plane 单例，属 shipped harness 改动，违背「零宿主改动」目标，且 ConPTY 本来就不暴露 POSIX 前台进程组，近似实现复杂度高、收益低。
- **BusyBox-w32 当持久 shell**：它是 `ash` 不是 `bash`，且 `tool-bash-persistent` 的 wrapper（`printf`/`eval`/`$'…'`/`$?`，`tool-bash-persistent/src/index.ts:78-83`）与 `stty -echo` 初始化（`:247`）按 bash 语义写，直接换壳会破；只适合方案 B 的 `-c` 一次性执行，仍缺 python/pip。

---

## 证据清单

### harness 源码（`D:\Harness\deepseek-harness`，file:line）

- 根因抛错：`packages/subprocess/subprocess-local/src/process-inspector.ts:366-374`（`:373` 为 throw）。
- 无条件构造 inspector：`packages/subprocess/subprocess-local/src/index.ts:174`（`spawnTerminal` 内，`:161-184`）。
- `ProcessInspector` 接口（POSIX 语义）：`process-inspector.ts:14-25`；Linux 用 `/proc`：`:82-227`、`:273-319`；macOS 用 `/bin/ps`：`:331-357`。
- `LocalTerminalHandle` 依赖 inspector 的 `inspectForeground`/`signalForeground`：`subprocess-local/src/terminal.ts:83-103`、`:93-103`。
- `TerminalBackend` / `TerminalBackendSession` / `TerminalSendOperation` / `TerminalSendResult` 契约：`packages/terminal/terminal/src/types.ts:166-171`、`:148-163`、`:94-101`、`:82-91`；`TerminalSignal`/`waitReason`：`:29`、`:36`。
- `registerBackend` / 按 `type` 选后端：`packages/terminal/terminal/src/index.ts:125-137`、`:158-159`。
- `terminal-bash` 委托 `ctx.subprocess.spawnTerminal`：`packages/terminal/terminal-bash/src/index.ts:25`（inject）、`:108-110`（默认委托）、`:125-133`（调用）、`:150-153`（`apply` 注册后端）。
- `terminal-bash` 默认 shell `/bin/bash --noprofile --norc -i`：`terminal-bash/src/config.ts:46-47`。
- `tool-bash-persistent` 只依赖 `terminals`、按 `backendType` spawn：`packages/shell/tool-bash-persistent/src/index.ts:402`、`:418`、`:234-237`；bash 化 wrapper 与 `stty -echo`：`:78-83`、`:247`。
- `SubprocessTerminalHandle` 契约（含 `inspectForeground`/`signalForeground`）：`packages/subprocess/subprocess/src/types.ts:235-264`、`:222-227`；抽象 `spawnTerminal`：`subprocess/src/index.ts:139`。
- 宿主 plane `subprocess` 与 win32 shell 交换：`packages/bundle/base/cordis.patch.yml:163-164`、`:210-216`；`shell/src/index.ts:16-18`（win32 换 pwsh）。
- `bash-local` 的 `['bash','-c',cmd]` 模式（方案 B 参照）：`packages/shell/bash-local/src/index.ts:212`、`:243`。
- preset 行名解析规则（裸名→harness node_modules，相对名→preset 目录）：`packages/preset/agent-presets/src/mount.ts:66-91`。
- 本仓库锚定 preset 的已知限制与 pwsh 工作区：`D:\Skills\dsh-anchored-standard\template\README.md:162-166`。

### node-pty（vendored，第一手）

- Windows/ConPTY 支持与 Node 16+：`node_modules/.pnpm/node-pty@1.1.0_*/node_modules/node-pty/README.md:12`、`:85`。
- `useConpty` / `useConptyDll` 选项与默认阈值（≥18309 默认 ConPTY，17134 起可用但默认关闭）：`node-pty.d.ts:90-104`。
- `IPty.pid`/`onData`/`onExit`：`node-pty.d.ts:116-120`、`:149-155`。
- `kill(signal)` 信号参数 Windows 不支持（传参抛错）：`node-pty.d.ts:178-184`。
- win32 预编译产物存在（无本地编译）：`node_modules/.pnpm/node-pty@1.1.0_*/node_modules/node-pty/prebuilds/win32-x64/{conpty.node,conpty_console_list.node,pty.node,winpty.dll,winpty-agent.exe,conpty/conpty.dll,conpty/OpenConsole.exe}`。
- 官方仓库：https://github.com/microsoft/node-pty

### Microsoft ConPTY（官方）

- Creating a Pseudoconsole session：https://learn.microsoft.com/en-us/windows/console/creating-a-pseudoconsole-session
- `CreatePseudoConsole`：https://learn.microsoft.com/en-us/windows/console/createpseudoconsole
- ConPTY 引介（node-pty README `:12` 引用的官方博客）：https://blogs.msdn.microsoft.com/commandline/2018/08/02/windows-command-line-introducing-the-windows-pseudo-console-conpty/

### Git for Windows / MSYS2 / BusyBox-w32（官方站点）

- Git for Windows：https://gitforwindows.org ；git-scm：https://git-scm.com ；Git 包装器说明：https://gitforwindows.org/git-wrapper
- MSYS2：https://www.msys2.org ；base 包：https://packages.msys2.org/packages/base?repo=msys&variant=x86_64 ；coreutils：https://packages.msys2.org/package/coreutils?repo=msys&variant=x86_64 ；路径转换：https://www.msys2.org/docs/filesystem-paths/
- BusyBox-w32：https://github.com/rmyorston/busybox-w32 ；下载页：https://frippery.org/busybox/index.html

### 未核实 / 需按安装现场确认

- Git for Windows 默认安装路径 `C:\Program Files\Git\bin\bash.exe` / `usr\bin\bash.exe` 与自带 `sed/grep/find` 的具体版本：属安装器默认值，本文按常见布局表述，**未逐文件核对**，实施时以 `where bash` / 安装目录为准。
- MSYS2 各包（coreutils/bash 的 GPLv3、msys2-runtime 的许可）与 Git for Windows 发行版各组件许可的精确版本：**未逐一读 LICENSE**，仅标注「需按安装组件确认」。
- BusyBox-w32 的 GPLv2 标注：BusyBox 上游许可众所周知，但本文**未直接打开** busybox-w32 README 核对，标注「GPLv2（上游）」，以仓库 README 为准。
