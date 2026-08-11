# 前端补丁:kimi-web-gateway.patch

multi-agent-gateway 的前端是 Kimi Code Web 0.33.0(仓库 `MoonshotAI/kimi-code`,
基线 commit `c2d7beb`)的 `apps/kimi-web` 加上本补丁。补丁包含全部网关适配:
provider 分段选择器、codex/claude 会话接入、原生斜杠命令目录、Plan 门控放开等
(21 个修改文件 + 2 个新文件,约 600 行)。

`web-dist/` 是构建产物(已入库);本补丁是**源码的唯一出处**——`/tmp` 下的工作
副本随时会被系统清理,重建前端必须从这里出发。

## 重建步骤

```bash
git clone https://github.com/MoonshotAI/kimi-code.git /tmp/kimi-code
cd /tmp/kimi-code
git checkout c2d7beb
git apply /path/to/multi-agent-gateway/patches/kimi-web-gateway.patch
cd apps/kimi-web
npm install
npm run build
rsync -a --delete dist/ /path/to/multi-agent-gateway/web-dist/
```

## 改前端时

1. 在打过补丁的 `/tmp/kimi-code` 里改 `apps/kimi-web`。
2. `npm run build` + rsync 到 `web-dist/`。
3. 重新生成补丁并一起提交(新文件先 `git add -N` 再 diff):
   ```bash
   cd /tmp/kimi-code
   git add -N apps/kimi-web/src/composables/useDraftAgent.ts apps/kimi-web/src/lib/sessionProvider.ts
   git diff -- apps/kimi-web > /path/to/multi-agent-gateway/patches/kimi-web-gateway.patch
   git reset -q
   ```
