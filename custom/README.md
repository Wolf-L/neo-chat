# Fork 定制层（custom overlay）

这个目录放本 fork 的全部定制。fork 里其余文件与上游 `u14app/neo-chat`
保持一致，不直接改上游代码，所以上游更新不会和定制冲突。

## 工作方式

`.github/workflows/custom-deploy.yml` 每 2 小时运行一次（也可手动运行，
`custom/**` 有改动时也会触发）：

1. 拉取最新上游代码（纯净，不合并进 fork）。
2. 把本目录复制进去，运行 `node custom/apply.mjs` 注入定制。
3. 依次运行 `pnpm typecheck`、`pnpm test`、`pnpm build:worker`。
4. 全部通过后用 `pnpm deploy:worker`（带 `--keep-vars`）部署到 Cloudflare。

同一份“上游提交 + 定制内容”只部署一次，没有新提交时这次运行会直接结束。
任何一步失败都不会部署，线上继续跑上一个成功版本，下次定时运行再试。

## 注入内容

- `overlay/src/lib/sync/scheduler.ts`：替换上游的同步调度器。回复结束 3 秒后
  同步一次，失败时在 5 秒、15 秒后各重试一次；启动时和每次登录
  （`/api/config` 返回成功）后自动加入服务器预设的同步库。
- `overlay/src/lib/sync/customPreset.ts`：客户端读取预设并配置同步库。
- `overlay/src/lib/sync/customServerPreset.ts`：服务端从环境变量生成预设。
  只有设置了访问密码时才会下发。
- 生成路由 `src/app/api/sync/custom-preset/route.ts`。
- `wrangler.overrides.json`：合并进 `wrangler.jsonc`（workers.dev、两个域名）。
- 删除测试上游调度器的测试文件（它测的是被替换掉的实现）。

## 防护检查

`apply.mjs` 遇到下列情况会直接报错，这次部署中止：

- 上游新增了和定制层同名的文件，或已经有 `/api/sync/custom-preset` 路由。
- 上游删除了 `src/lib/sync/scheduler.ts`。
- 上游代码不再从 `@/lib/sync/scheduler` 引入 `startEncryptedSyncScheduler`
  （否则替换后的调度器根本不会被调用）。

上游改了同步相关的接口时，`typecheck` 和 `custom/test` 里的测试会失败，
同样会中止部署。

## 环境变量（在 Cloudflare 后台设置）

| 变量                               | 说明              |
| ---------------------------------- | ----------------- |
| `SYNC_PRESET_S3_ENDPOINT`          | S3 兼容端点（R2） |
| `SYNC_PRESET_S3_BUCKET`            | 桶名              |
| `SYNC_PRESET_S3_ACCESS_KEY_ID`     | 访问密钥 ID       |
| `SYNC_PRESET_S3_SECRET_ACCESS_KEY` | 访问密钥          |
| `SYNC_PRESET_RECOVERY_CODE`        | 同步库恢复码      |
| `SYNC_PRESET_S3_REGION`            | 可选，默认 `auto` |
| `SYNC_PRESET_S3_PREFIX`            | 可选，对象前缀    |
| `SYNC_PRESET_S3_FORCE_PATH_STYLE`  | 可选，默认 `true` |

## GitHub 仓库设置

- Secrets：`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`。
- 可选 Variables：`UPSTREAM_REPOSITORY`（默认 `u14app/neo-chat`）、
  `UPSTREAM_BRANCH`（默认 `main`）。

## 本地验证

在上游代码的工作区里：

```bash
node custom/apply.mjs
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build:worker
```

`apply.mjs` 会改动工作区文件，验证完用 `git checkout -- . && git clean -fd src`
恢复。
