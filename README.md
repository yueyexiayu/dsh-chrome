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

- 纯 Host 插件，没有 Client UI。工具以 `chrome_` 开头
- 新标签用 `active: false` 创建，放进标题为 `DSH` 的标签组，并保持折叠。不会调用 `Page.bringToFront`，也不会把窗口设为 focused
- 只操作这个标签组里的标签，不列出、不切换你正在看的其他标签
- `chrome_close` 只关掉 DSH 标签组，不退出 Chrome
- `chrome_resize` 不改窗口大小，避免 macOS 把 Chrome 激活
- `chrome_screenshot` 把 PNG 交回模型并落盘；配合 `zhanshi` 可在本轮对话里预览
- 元素引用（ref）来自最近一次 `chrome_snapshot` / `chrome_query` / `chrome_find` / `chrome_a11y`；这几次调用都会重新编号
- 不自动接受 `alert` / `confirm` / `prompt`。弹窗挡住后续点击或输入时，先调用 `chrome_dialog`
- 点击、输入和查询只作用在顶层页面；跨源 iframe 里的内容不可见
- 下载进当前 Chrome 的下载目录。cookie / storage 默认不返回值；名字像 token 或密码的项始终打码

## 开发

```bash
node --check lib/index.js lib/browser.js lib/page.js lib/tools.js lib/bridge-client.js lib/install.js extension/background.js
node --test
```
