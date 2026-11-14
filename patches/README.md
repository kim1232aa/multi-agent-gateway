# Kimi Web 基线说明

`web-dist/` 现在严格保存官方 `@moonshot-ai/kimi-code@2.6.2` 的
`dist-web`，对应 commit `6a8493df3e1d796a63f7c7ca0de76c1e690cd943`。
关键文件的 SHA-256 记录在 `web-origin-manifest.json`。升级时必须整包替换，
不能保留上一版本的哈希资源文件。

此前提交的 `c2d7beb` 实际对应 0.28.1 时代的公开源码，不是 0.33.0 的 Web
源码；旧的 `kimi-web-gateway.patch` 已退役，不能再作为构建来源。官方 0.33
Web 源码已迁移到内部仓库，公开仓库只提供预编译 `dist-web`。

## 正确的扩展方式

不要修改或重编 `web-dist/`。网关启动时校验 manifest，向官方 `index.html` 的
内存响应注入 `web-extension/boot.js` 和 `web-extension/style.css`；官方 JS、CSS
和其他静态资源保持原样。校验失败时自动回退为纯官方 Kimi Web。

如需升级版本，应先确认官方 tag 和 commit，重新生成完整 `web-dist/` 与
`web-origin-manifest.json`，再同步检查注入点和浏览器回归。
