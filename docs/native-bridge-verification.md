# 0.2.2 原生桥接运行态验收

日期：2026-10-15，Asia/Tokyo。以下是本机当前工作区的实测结果，不把单测或磁盘版本声明当作部署成功。

## 目标与现场

- 修复前，本会话真实 `chrome_browsers(list)` 再现 `Chrome connection closed during handshake`。
- 当前真实 App/Host executable：`/Applications/DeepSeek Harness 0.2.1-alpha.2.20261015.1.app/Contents/MacOS/DeepSeek Harness`。主应用 PID 82235，Host PID 82250；Host 实际监听 `127.0.0.1:62186`。这些值均本轮现场查询，不沿用历史端口。
- `ELECTRON_RUN_AS_NODE=1` 实测该 executable 的 `process.versions.electron` 为 `44.7.0`，不创建 Electron GUI。
- 旧 `/Applications/DeepSeek Harness.app` 不作为测试定位或运行依赖。

## 修复及安全边界

- `host/peerpath.c` 和其 helper 二进制未改：仍用 socket 的 `LOCAL_PEERPID` 和 `proc_pidpath` 获取 OS 对端可执行路径，不信任 argv、消息自报路径或调试端口。
- `host/peer-identity.mjs` 只接受 `/Applications/DeepSeek Harness[ <合法 SemVer>].app/Contents/MacOS/DeepSeek Harness`，要求 realpath 与路径完全相同，失败关闭。普通 Node、任意其他 App、Helper、嵌套伪路径及 symlink 逃逸不获准。
- helper 输出只剥除协议尾换行和可选 C 终止 NUL，不再 trim 文件名或删除任意嵌入 NUL。
- token 认证、protocol 2、控制器竞争和 owner 隔离未放宽。没有普通 Node 测试后门；入场前已删除的旧 Node 豁免不是本次新改动。
- 这是既有 OS executable 路径信任模型的收紧与版本兼容，不宣称新增代码签名/二进制内容认证，也不宣称防止同权限用户替换安装目录中的软件。
- 原生 fixture 改为校验真实 `process.execPath` / Electron Node 模式，共享生产身份 gate；强制当前用户所有、私有权限、系统临时目录下的 mkdtemp `DSH_HOME`。未注册测试 NativeMessagingHost，未接真实 Chrome。
- controller-restart fixture 的前缀缩短，解决 canonical 系统临时路径导致 socket 110 bytes 超过 macOS 104-byte 上限的 `EINVAL`；新路径 99 bytes。没有修改生产 socket 规则来迎合测试。

## 回归证据

1. 旧 gate 对实际版本化 App 的断言先失败；修复后身份专属回归 6/6。
2. 旧 native-runtime fixture 在真实版本化 Electron 下报旧 App 路径 `ENOENT`；修复后新增 fixture/OS 回归 6/6。
3. OS 负例分别启动普通 `/usr/local/bin/node` 和 `argv0` 伪造为真实 DSH executable 的普通 Node。后者确认 `process.execPath !== process.argv0`，生产桥断开连接，零 auth/hello Native 转发，桥进程仍存活。不是 VM 模拟 OS 身份。
4. 版本同步后的最终纯套件：`/usr/local/bin/node test/run-pure.mjs`，224/224，四个 batch 全 exit 0（211 + 5 + 7 + 1），含新增身份测试。
5. 最终完整套件：`ELECTRON_RUN_AS_NODE=1 '<上述真实 executable>' --test --test-reporter=tap test/*.test.mjs`，252/252，0 fail、0 skip、0 cancelled，exit 0。普通 Node 只用于纯测及明确拒绝的负例。
6. `lib/*.js`、`extension/*.js`、`host/*.mjs`、`test/*.mjs` 和 `test/fixtures/*.mjs` 全部 `node --check` 通过；独立审查另完成 `clang -fsyntax-only host/peerpath.c`。

完整测试日志分别为本机 `/tmp/dsh-chrome-final-pure.log` 和 `/tmp/dsh-chrome-final-native.log`。这些日志不是当前 Chrome 端到端证据；实际连接见下一节。

## 实际加载与真实握手

- 插件源码/包版本为 **0.2.2**。扩展源码本次未修改，配对版本继续 **0.2.4**；锁文件没有根包版本字段，依赖未变，不重写锁文件。
- 未修改官方 App/源码或 profile 配置，也未退出正在承载本任务的 DSH。现场只读核验官方 HMR 实例存在：`root=[]`、`closing=false`、`include:chrome` entry；重载前 browser 模块的 owner 队列、pages、capture sessions、pending cleanups、activity 和 unconfirmed creates 均为空，bridge/connecting 为 null。
- 经当前 Host 自有 inspector 调用**已安装的官方 HMR 服务**，在其 `runExclusive` 事务内执行 manifest invalidation、定向 `stashed` 和 `partialReload`，无全局 loader exit、无手工替换工具函数、无认证修改。结果 `include:chrome` registered=true、1 个注册 fiber、entryFiberRegistered=true，fiber uid 410；实际新工具调用报告 adapter 0.2.2。
- [dsh-plugin skill 第 5 条](/Users/ning/.dsh/skills/dsh-plugin/SKILL.md#L108-L109) 明确写着“必须完全退出 DeepSeek Harness（⌘Q）再打开。热重载不够”。本次没有执行这一重启步骤：为避免中断正在承载本任务及其他会话的 Host，使用现场存在的官方定向重载，并另行验证注册 fiber 与真实工具命中新代。此处如实记录与 skill 步骤的差异，不把它说成 skill 允许的例外；实际加载结论依据运行态证据，而非改磁盘文件或刷新页面。
- 独立核验旧 Native Host PID 88692 的完整 command、Chrome 父 PID 24855 和真实 socket 后，只对该 Native Host 发 SIGTERM。扩展自行重连，新 Native Host PID **91988**，启动时间 **15:20:49 JST**，完整 command 为 `/usr/local/bin/node /Users/ning/.dsh/plugins/chrome/host/bridge.mjs`；新 socket 为 `cache/dsh-c-df40b3f2`。没有退出 Chrome、复制/改名 App 或可执行文件。
- 当前已注册工具的真实 `chrome_browsers(list)` 成功（验收后再次成功）：adapter **0.2.2**，worker extension **0.2.4**，Chrome 完整版本 **153.0.8010.37**，policy **0.2.1-alpha.2.browser-policy.1**，`bridge: connected`、`pending cleanup owners: none`。扩展 worker 的实际版本满足配对校验；它不是匿名 headless 或 debug-port attach。

## 当前 Chrome 端到端

验收窗口：**15:21:01–15:22:55 JST**（06:21:01–06:22:55Z）。使用本任务拥有的 loopback 页面与后台标签，未读取用户原标签正文。

1. 真工具 `chrome_navigate` 打开本任务本地页面；`chrome_snapshot` 返回标题、heading、input/button/link refs；`chrome_get_text(main)` 读取真实 DOM。
2. 真工具 `chrome_type` 填入 `bridge-0.2.2-verified`，`chrome_click` 点击 Apply proof；可见 output 从 `Not applied` 变为 `Applied: bridge-0.2.2-verified`。`chrome_evaluate` 独立读取 output 与 `data-interactions`，结果计数为 **1**。
3. 通过同一真实 Host 的已加载 browser/owner API 创建另一个**本任务自有** B owner 验收组。A 的 `chrome_tabs(list)` 不包含 B；A 尝试 switch 到 B 的 `tab-1652409125` 明确拒绝：`target_id does not belong to this conversation or is no longer available`。
4. A 的 `chrome_close` 只删除 A 自有 tabs（1652409119、1652409122）；B 的 tab 1652409125 仍可列出及读取 `Not applied`，证明 A 的交互和关闭未污染/关闭 B。随后仅关闭 B 自有组。
5. 验收前后 Chrome PID 均 **24855**，仍是同一个原有普通窗口；原有 **31** 个 tab 的 ID 和顺序完全相同，active tab 始终 **1652409116**。任务 tabs 已全部移除；未关闭、切换或操作用户原标签及其他真实会话。
6. AppKit `NSWorkspace.didActivateApplicationNotification` 全程记录前台切换；上述验收窗口内没有 Chrome PID 24855 的 activation。期间前台有用户的其他应用切换（含一个已退出的 unknown PID 事件），因此不以“前后前台应用相同”作伪证，也不宣称用户未进行其他前台操作。Chrome 原窗口 active tab 不变的独立记录与扩展 owner 约束一并佐证未激活用户 Chrome 窗口。
7. 清理后 Host 的 pages/capture sessions/owner cleanups/unconfirmed creates/owner 队列为空；重新调用 `chrome_browsers` 不创建标签，连接成功且无 pending cleanup。
8. 写完记录后又做一次全局精确相等断言，此时失败：验收窗口结束数分钟后出现了非任务 tab 1652409131，且成为 active tab；监测在 15:27:21 JST 记录了 Chrome activation。没有把这次较晚快照说成相等或把其归为任务 tab。按只保护原标签、不干涉并发用户活动的边界重新检查：原 31 个 ID 全部保留且相对顺序不变，3 个任务 ID 均不存在，非任务新增 1 个，校验通过；没有关闭或切换该新增标签。上面关于 active tab 和无 Chrome activation 的结论严格限定于 15:21:01–15:22:55 的实际验收窗口。

## 工作区保护

入场时仓库已有大量修改和未跟踪文件。修改前保存了 tracked diff、index diff 和 status，并构建入场工作区基线用于比较；原有 index 为空。相对此基线，本任务仅变更身份 gate、测试 runtime 与相关测试接线、版本和说明；其他 tracked 文件逐字节相同。未回退、删除或覆盖既有工作，也未将既有 browser-policy/owner 改动冒称本次修复。

用户随后明确选择“提交修复及必要的既有原生测试基础”。因此提交纳入既有 Node 后门删除和原生 fixture 迁移等本次依赖的基础，但按上下文重新组合暂存文件，排除无关 browser-policy、owner、extension、lockfile、vendor 和 lib 改动。工作区的 execution 版本断言与扩展执行契约仍保留在原工作区，不冒充本次提交的新功能。

另将**实际暂存树**独立导出到 `/tmp/dsh-chrome-staged.P0CI3C`，只为其提供已声明的 `jpeg-js` 依赖，而非整个当前 node_modules。该树独立通过纯套件 **178/178**（166 + 5 + 6 + 1）和真正 installed Electron 的完整套件 **206/206**，均 0 fail/skip、exit 0；日志为 `/tmp/dsh-chrome-staged-pure.log`、`/tmp/dsh-chrome-staged-native.log`。与前述工作区 **224/252** 数量不同是因为没有提交无关前作及其新增测试，不把两种范围混淆。13 个暂存文件不含 extension/lib/vendor/lockfile；差异与 whitespace 检查通过。
