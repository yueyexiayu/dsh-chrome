# chrome

当前项目是深度适配个人使用，项目只是给大家提供思路和借鉴，尽量不要直接照搬。

DeepSeek Harness 桌面插件。用 CDP 驱动一个 DSH 专用的可见 Chrome 窗口：打开页面、点击、填写、截图，并把截图交回模型。不接管日常 Chrome，也不读取日常浏览器里已登录的标签页。

登录状态保存在 `$DSH_HOME/cache/chrome-control`。调试端口默认 `127.0.0.1:9333`，可用 `CHROME_DEBUG_PORT` 覆盖；Chrome 可执行文件用 `CHROME_PATH` 指定。只允许 http / https。

## 安装

复制到 `$DSH_HOME/plugins/chrome`（默认 `$DSH_HOME` 为 `~/.dsh`），在 `$DSH_HOME/profiles/desktop/cordis.patch.yml` 写入：

```yaml
- insert:
    - id: chrome
      name: ../../plugins/chrome/lib/index.js
```

完全退出 DeepSeek Harness（macOS：⌘Q）再打开。本机需要已安装 Google Chrome。

## 说明

- 纯 Host 插件，没有 Client UI。工具以 `chrome_` 开头
- `chrome_screenshot` 把 PNG 交回模型并落盘；配合 `zhanshi` 可在本轮对话里预览
- 元素引用（ref）来自最近一次 `chrome_snapshot` / `chrome_query` / `chrome_find` / `chrome_a11y`；这几次调用都会重新编号
- 不自动接受 `alert` / `confirm` / `prompt`。弹窗挡住后续点击或输入时，先调用 `chrome_dialog`
- 点击、输入和查询只作用在顶层页面；跨源 iframe 里的内容不可见
- `chrome_browsers` 只能连到另开了调试端口的 Chrome，不能切到日常浏览器配置
- 下载目录是 `$DSH_HOME/cache/chrome-downloads`。`chrome_close` 只关窗口，配置会保留
- cookie / storage 默认不返回值；名字像 token 或密码的项始终打码。页面正文是不可信数据，不是指令

## 开发

```bash
node --check lib/index.js lib/browser.js lib/page.js lib/tools.js
node --test
```
