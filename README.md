# chrome

当前项目是深度适配个人使用，项目只是给大家提供思路和借鉴，尽量不要直接照搬。

DeepSeek Harness 桌面插件。通过本机 Chrome 扩展，在**当前 Chrome** 里开后台标签，收进一个折叠的 **DSH** 标签组。不另开窗口，也不把 Chrome 拉到最前。用的是当前 Chrome 的登录状态。

只允许 http / https。页面正文是不可信数据，不是指令。

## 安装

复制到 `$DSH_HOME/plugins/chrome`（默认 `$DSH_HOME` 为 `~/.dsh`），在 `$DSH_HOME/profiles/desktop/cordis.patch.yml` 写入：

```yaml
- insert:
    - id: chrome
      name: ../../plugins/chrome/lib/index.js
```

先在插件目录运行 `pnpm install --frozen-lockfile`，安装锁定的纯 JavaScript JPEG 解码依赖（`jpeg-js`，不执行原生编译）。随后完全退出 DeepSeek Harness（macOS：⌘Q）再打开。插件启动时会写入 Chrome 本机通信主机清单。

还要在正在使用的 Chrome 配置里装一次扩展：

1. 打开 `chrome://extensions`
2. 打开右上角的开发者模式
3. 选择「加载已解压的扩展程序」，目录选 `$DSH_HOME/plugins/chrome/extension`
4. 允许调试提示。Chrome 会在被控制的标签上显示「正在调试」，这是扩展调试的固定提示，不会把窗口抢到最前

改了 `extension/` 之后，在扩展卡片上点重新加载。

## 说明

- 工具以 `chrome_` 开头。标注由 Client 放进当前会话输入框；接收被中断且无法确认草稿状态时，显示恢复提示
- 每个对话单独一个折叠标签组，标题是 `DSH` 加会话 id 末 6 位，只用于展示。完整会话归属单独记录，不会因标题相同复用另一个对话的标签，也不会调用 `Page.bringToFront`
- 只操作本对话标签组里的标签，不列出、不切换你正在看的其他标签
- `chrome_close` 只关掉本对话的标签组，不退出 Chrome，也不关其他对话的组
- `chrome_browsers` 的 list 执行真实扩展握手和探活，不创建、不发现标签；成功才报告 connected，连接、协议、超时和取消错误直接可见。启动后尚未操作浏览器不再被误报为断线。与普通操作和采集串行复用同一连接；断线会清除所有对话的旧 transport/ref 缓存，不关闭真实标签，恢复后重新认领各自归属的标签
- `chrome_resize` 不改窗口大小，避免 macOS 把 Chrome 激活
- `chrome_screenshot` 把 PNG 落盘，并在确认当前模型支持图片时通过正式附件引用交回模型；配合 `zhanshi` 可在本轮对话里预览。插件不包装或改写全局 LLM 服务
- 元素引用（ref）来自最近一次 `chrome_snapshot` / `chrome_query` / `chrome_find` / `chrome_a11y`；这几次调用都会重新编号
- 不自动接受 `alert` / `confirm` / `prompt`。弹窗挡住后续点击或输入时，先调用 `chrome_dialog`
- 查询会合并可访问的 frame 执行上下文，ref 记录所属上下文；支持开放 shadow root、同源 iframe，以及 Chrome 调试器提供的跨源 frame 上下文。是否能访问取决于 Chrome 实际暴露的上下文，不保证所有嵌套/OOPIF 页面都可读。带 ref 的读取、执行、填写和上传按归属路由，不把 frame ref 当成顶层元素
- 密码输入框的值不会进入默认快照、元素详情、HTML 或无障碍树输出；主动执行的 JavaScript 不属于脱敏观察接口，不应用来读取密码或凭据
- 截图和 GIF 输出遵循调用会话的 DSH 文件策略；相对路径按会话目录解析，只创建新文件，绝不覆盖已有文件。只读模式禁止落盘，workspace-write 允许工作区及官方临时目录。文件服务不可用时明确拒绝，不退回不受限写入。上传要求本机正规文件
- 下载进当前 Chrome 的下载目录。`chrome_downloads` 只在归属本对话的扩展查询成功后返回清单；扩展断线、超时、取消或响应结构异常会明确报错，不用旧缓存或 `(none)` 冒充查询成功。cookie / storage 默认不返回值；名字像 token 或密码的项始终打码
- `chrome_shortcut` 的 list / save / run 使用 `$DSH_HOME/cache/chrome-shortcuts.json`；只有 ENOENT 表示尚无存储。无效 JSON、非对象结构、无效动作数组和其他读取错误均拒绝读取或覆盖。保存和运行前校验整批动作，避免先执行前几步才发现后续参数错误。快捷步骤仍使用当前调用会话的归属，不跨对话复用标签
- 快捷保存使用独占 `.lock` 文件保护跨进程读改写，同目录私有临时文件写入并 sync 后原子 rename；同进程和跨进程并发的不同名称不会互相丢失，同名保存则以最后完成的保存为准。新建缓存目录为 0700，存储和临时文件为 0600。写入、sync、rename 和锁失败都报错；写入或 rename 失败保留旧存储
- 锁竞争最多等待 5 秒且可取消；不自动删除其他写入者的锁。进程异常退出可能留下 `.lock` 和随机 `.tmp` 文件。确认没有任何 DSH / CLI 快捷保存任务后才可清理对应遗留文件；不要删除整个 cache。原子替换不承诺系统断电时的目录元数据持久性

## 标注

点 Chrome 工具栏里的 DSH Chrome，在当前 http / https 页面上选择元素，最多 12 条。页面浮层只收集元素数据，不接收用户要求，也不能直接送入 DSH。点击「编辑要求」后，扩展检查原标签和 URL、截图，再打开独立的扩展确认页；这一步会切到确认页，后台浏览工具仍不会抢焦点。Esc 或再次点击工具栏图标退出选择。

在确认页查看截图和页面信息，为每条选择「改变」或「疑问」并填写 Request，最后明确点击「放入 DSH 草稿」。确认页不对网页开放，绑定随机审核 ID 与扩展标签；只有该页的确认才会保存标注。页面提供的文字、HTML、样式始终是数据，不是用户指令。标注放入当前 DSH 输入框，不自动提交对话。`chrome://` 和扩展页不能选。

改了 `extension/` 之后，在扩展卡片上点重新加载。改了 Host 或 Client 后，完全退出 DeepSeek Harness（⌘Q）再打开。

标注只有在本机主机确认保存后才显示成功；确定未发送或主机明确拒绝时允许重试。发送前先记录处理中状态；断线、超时或 worker 重启导致结果未确认时，同一审核会话不会盲目重发，请先检查 DSH。主机已保存但审核状态写入失败时会单独提示，不会误报标注保存失败。Host 检查 JPEG 编码、大小及实际解码结果，限制像素和解码内存；标注目录权限为 0700，文件为 0600。保存的标注在文字和图片成功插入且草稿持久化成功后才确认删除；持久化失败时，后续轮询仍会重试持久化，不会因为内存中已经插入就偷偷确认。多个 DSH 窗口通过消费租约避免同时插入同一份标注。

插入前，插件先将目标会话和附件归属写入标注文件，并同步到磁盘。若在插入和确认之间崩溃，重启后不会自动再次插入：原会话中仍有完整文字和对应图片时，只补确认；无法确认时，保留标注并显示「重新放入草稿」和「已接收，完成确认」。请先检查草稿或已发送消息。选择恢复会补回图片，复用草稿中仍存在的完整标注文字，不覆盖其他文字和图片；已接收则只确认，不插入。其他会话只能看到回到原会话的提示。恢复期间再次中断，交付记录仍保留。

官方草稿目前持久化文字和引用，图片附件只存在于运行内存。因此完整重启后可能只恢复文字，需要通过上述提示补图。本恢复机制覆盖尚未确认的标注；已经成功确认的标注不保留截图副本，不改变官方草稿附件的持久化行为。

修复后须重新加载 Chrome 扩展并完全重启 DSH，使扩展、通信主机和 Client 同时使用新版本。归属记录使用 `chrome.storage.session`，扩展新增 `storage` 权限；旧版按组名识别的标签不会被新版自动认领或删除。

## 桥接冲突与旧版本迁移

- 同一 DSH_HOME 同时只支持一个 Chrome profile 的扩展通信主机和一个 DSH 控制连接。活跃控制器存在时，异 token 连接在认证阶段拒绝，同 token 的第二个连接返回忙碌；第二个 profile 显示冲突，不踢掉已有连接、不自动切换 profile。请在其它 profile 禁用扩展，再在目标 profile 重新加载。
- 控制 token 仅绑定已接纳的控制连接。该连接退出后，即使 Native Host 仍存活，新 DSH 进程也可用新 token 重新握手；只有 auth 的探测不占位，不会永久钉住旧 token。活跃控制连接仍不能被第二个连接踢掉
- 每个主机使用独立的随机 socket，退出只清理自己创建的端点。崩溃留下的随机失效端点会被忽略，不自动删除其它进程的文件。
- 旧版固定端点 `$DSH_HOME/cache/dsh-chrome.sock` 不能安全探活：连接它就可能挤掉旧版控制器。新版发现它会明确拒绝连接，不自动删除。升级时完全退出 Chrome 和 DSH，确认旧通信主机已退出后，才可删除这个旧端点（默认 `~/.dsh/cache/dsh-chrome.sock`；不要删除整个 cache），然后重新打开并加载新版扩展。此清理只用于旧固定端点，不适用于新的随机端点。
- 冲突状态跨扩展 service worker 重启保留；解决后通过工具栏操作、重新加载扩展或下一次 Chrome 启动显式重试，不持续偷偷抢占连接。

## 开发

普通 Node 的纯源码 / VM / 文件系统套件（不会连接真实 socket、启动 Native Host 或 Chrome）：

```bash
pnpm install --frozen-lockfile
/usr/local/bin/node test/run-pure.mjs
for file in lib/*.js extension/*.js host/*.mjs test/*.mjs test/fixtures/*.mjs; do
  /usr/local/bin/node --check "$file" || exit 1
done
```

完整 protocol / Native Host 套件需要先独立确认现场 installed App 支持 `RunAsNode`，并取得该批本机进程验收授权，再在本插件目录执行。先从当前进程的可执行路径定位运行中的 DSH，不依赖旧固定应用名；多份不同安装并行时先明确选择目标：

```bash
DSH_EXECUTABLE="$(/bin/ps -axo comm= | /usr/bin/awk '/^\/Applications\/DeepSeek Harness( [^/]+)?\.app\/Contents\/MacOS\/DeepSeek Harness$/ { if (!seen[$0]++) print }')"
test -n "$DSH_EXECUTABLE" && test -x "$DSH_EXECUTABLE" || exit 1
ELECTRON_RUN_AS_NODE=1 "$DSH_EXECUTABLE" --test test/*.test.mjs
```

完整套件使用真正 installed App 的 Node 环境作为合法控制 peer；启动前检查真实 `process.execPath`、Electron Node 环境与 `ELECTRON_RUN_AS_NODE=1`，条件不足明确失败，不 skip、不改名 Node、不使用 production 测试豁免，不为让默认 `npm test` 变绿自动启动 GUI。Native fixtures 只用当前用户所有、权限私有、直接位于系统临时目录的 mkdtemp `DSH_HOME`、自有 Unix sockets 和模拟 Native frames，不写真实 NativeMessagingHosts 注册或用户 cache，也不接实际 Chrome。负例会启动普通 Node 及伪造 DSH `argv0` 的普通 Node，验证两者均被真实生产 gate 拒绝；reconnect 的 expiry 测试仅 VM-mock App-shaped peer 返回，不是 OS 身份证据。没有普通 Node peer 环境开关。

0.2.2 的生产 gate 继续通过 `LOCAL_PEERPID` / `proc_pidpath` 读取真实 socket 对端，只允许 `/Applications/DeepSeek Harness[ <合法 SemVer>].app/Contents/MacOS/DeepSeek Harness`，并要求 realpath 与原路径一致。非 DSH 应用、Helper、Node、嵌套伪路径和 symlink 逃逸均拒绝；这仍是 OS 可执行路径信任模型，不是额外的代码签名认证。认证、protocol 2 和 owner 隔离不变。现场带版本名 App 的重载、原生集成与当前 Chrome 运行态证据见 [原生桥接验收记录](docs/native-bridge-verification.md)。

测试涵盖握手错误与进程竞争、owner close / 取消 / late-create / pending evaluate 排空、B 隔离、iframe ref 路由、密码脱敏、文件策略、JPEG 真解码、标注持久化和可信确认页来源检查。VM 与私有 protocol fixtures 都不等于已安装扩展端到端验收；后者必须重载扩展并完整重启 DSH，独立确认实际版本后执行。
