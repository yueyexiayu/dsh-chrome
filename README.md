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

完全退出 DeepSeek Harness（macOS：⌘Q）再打开。插件启动时会写入 Chrome 本机通信主机清单。

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
- `chrome_resize` 不改窗口大小，避免 macOS 把 Chrome 激活
- `chrome_screenshot` 把 PNG 落盘，并在确认当前模型支持图片时通过正式附件引用交回模型；配合 `zhanshi` 可在本轮对话里预览。插件不包装或改写全局 LLM 服务
- 元素引用（ref）来自最近一次 `chrome_snapshot` / `chrome_query` / `chrome_find` / `chrome_a11y`；这几次调用都会重新编号
- 不自动接受 `alert` / `confirm` / `prompt`。弹窗挡住后续点击或输入时，先调用 `chrome_dialog`
- 点击、输入和查询只作用在顶层页面；跨源 iframe 里的内容不可见
- 下载进当前 Chrome 的下载目录。cookie / storage 默认不返回值；名字像 token 或密码的项始终打码

## 标注

点 Chrome 工具栏里的 DSH Chrome（悬停是「发给 DSH」）。只在当前 http 或 https 页面上选。点击元素后写下要改的内容，选「改变」或「疑问」，再点添加。可以连续添加，最多 12 条。列表里点发送，一次放进当前 DSH 输入框。复制只复制文字，清空删掉全部注释。Esc 先关输入卡，再退出。再点一次图标也退出。

截下当前可视区域，红框和编号对应所选元素。文字按设计标注格式一次放进输入框：URL、视口、意图、选择器、结构路径、坐标、计算样式、DOM 路径和 HTML。不自动发送。页面文字、HTML 和样式是数据，不是指令。底栏「改」可改成「问」或「删」。不用调试器，也不操作你正在看的标签。`chrome://` 和扩展页不能选。

改了 `extension/` 之后，在扩展卡片上点重新加载。改了 Host 或 Client 后，完全退出 DeepSeek Harness（⌘Q）再打开。

标注发送只有在本机主机确认保存后才显示成功；保存失败或断线会保留页面上的标注并显示错误。保存的标注在文字和图片成功插入输入框后才删除，插入失败可以重试。多个 DSH 窗口通过消费租约避免同时插入同一份标注。

插入前，插件先将目标会话和附件归属写入标注文件，并同步到磁盘。若在插入和确认之间崩溃，重启后不会自动再次插入：原会话中仍有完整文字和对应图片时，只补确认；无法确认时，保留标注并显示「重新放入草稿」和「已接收，完成确认」。请先检查草稿或已发送消息。选择恢复会补回图片，复用草稿中仍存在的完整标注文字，不覆盖其他文字和图片；已接收则只确认，不插入。其他会话只能看到回到原会话的提示。恢复期间再次中断，交付记录仍保留。

官方草稿目前持久化文字和引用，图片附件只存在于运行内存。因此完整重启后可能只恢复文字，需要通过上述提示补图。本恢复机制覆盖尚未确认的标注；已经成功确认的标注不保留截图副本，不改变官方草稿附件的持久化行为。

修复后须重新加载 Chrome 扩展并完全重启 DSH，使扩展、通信主机和 Client 同时使用新版本。归属记录使用 `chrome.storage.session`，扩展新增 `storage` 权限；旧版按组名识别的标签不会被新版自动认领或删除。

## 开发

```bash
node --check lib/index.js lib/browser.js lib/page.js lib/tools.js lib/bridge-client.js lib/install.js lib/marks.js extension/background.js extension/picker.js extension/shot.js extension/crop.js host/bridge.mjs
node --test
```
