# 球序 · Tennis Flow

面向手机端的 ATP、WTA 与大满贯赛程时间流。网站使用 Cloudflare Workers 托管静态页面和 API，D1 保存比赛数据。GitHub Actions 每 6 小时执行一次全量校准，Cloudflare 在比赛开始后按赛事级别进行自适应赛果检查。

比赛数据来自 ESPN Tennis 的公开赛程页面。采集器只处理 ATP/WTA 单打，并保留数据来源；球员中文名使用 Wikidata 中文标签与常用简体译名校正，并在 Actions 中缓存。时间、场地、排名和技术统计在来源缺失时显示为“待定”或“暂无”。数据库种子仅用于首次部署前预览。

## 本地预览

只看界面（会自动使用相对日期的演示数据）：

```bash
python3 -m http.server 8080 --directory public
```

完整 Worker + D1 环境：

```bash
npm install
npx wrangler d1 create tennis-flow-db
```

把命令返回的 `database_id` 写入 `wrangler.jsonc`，然后执行：

```bash
npm run db:init:local
npm run dev
```

## 微信小程序

仓库根目录包含原生微信小程序项目，AppID 为 `wxf575cca5dce6ff34`。使用微信开发者工具导入仓库根目录即可，工具会读取 `project.config.json` 并以 `miniprogram/` 作为小程序源码目录。

正式预览前，请在微信公众平台的“开发管理 → 开发设置 → 服务器域名”中，把 `https://scores.tennisdrills.org` 配置为 `request` 合法域名。小程序复用网站的 `/api/matches` 和 `/api/health` 接口，不需要登录或单独的数据库。

## 部署到 Cloudflare

1. 登录：`npx wrangler login`
2. 创建 D1：`npx wrangler d1 create tennis-flow-db`
3. 更新 `wrangler.jsonc`、`wrangler.live-sync.jsonc` 和 `wrangler.live-sync-wta.jsonc` 中的 `database_id`，三个 Worker 使用同一个 D1 数据库
4. 初始化线上数据库：`npm run db:init:remote`
5. 部署：`npm run deploy`
6. 部署独立的比分同步 Worker：`npm run deploy:live`

## GitHub Actions 配置

在仓库的 **Settings → Secrets and variables → Actions** 中添加：

| Secret | 用途 |
|---|---|
| `WORKER_SYNC_URL` | Worker 的写入接口，例如 `https://tennis-flow.example.workers.dev/api/sync` |
| `SYNC_TOKEN` | Worker 与 GitHub Actions 共用的随机长密钥 |

任务每 6 小时执行一次，也可以在 Actions 页面手动运行。工作流读取昨天到未来七天的 ATP/WTA 单打赛程与赛果，规范化后通过受保护接口写入 D1。

## 轻量单场比分同步

独立 Worker `tennis-flow-live-sync`（ATP）和 `tennis-flow-live-sync-wta`（WTA）分别使用对应的 live-sync 配置，每分钟触发。每场比赛距离上次检查至少 5 分钟才再次检查。它们直接读取 ESPN 单场球员配对、状态和两位球员的盘分资源，每场通常只有几 KB；每次最多处理 2 场，并优先处理最久未检查的比赛。每个巡回赛 5 分钟内最多检查 10 场，超过容量的比赛会在后续运行继续处理。所有变更合并成一次 D1 batch，比分不变时不会改写比赛记录。

只检查已开赛 18 小时内或将在 30 分钟内开赛的已知比赛；当日没有准确开赛时间的比赛每小时探测一次。没有符合条件的比赛时不访问 ESPN。网站 Worker 的旧批量采集 Cron 已停用，网站接口继续使用同一个 D1。GitHub 的全量采集负责赛程发现及技术统计，增量 Action 可作为补充；Cloudflare 的实时比分同步无需等待 Actions。

运行日志沿用 `adaptive_cron_runs`、`adaptive_sync_runs` 和 `adaptive_sync_state`，单场目标以 `match:espn-...` 标识，历史保留 30 天。接口异常、无效配对或空的进行中比分不会清除已有数据；来源确认换人时更新配对，并保持未换球员的比分方向。并发采集不能把已完赛比赛改回进行中，也不能覆盖更新时间更晚的数据。运行 `npm run check:live` 验证单场同步行为。

### 标准数据格式

```json
{
  "source": "来源名称",
  "updatedAt": "2026-09-05T06:17:00+08:00",
  "matches": [
    {
      "id": "source-match-id",
      "date": "2026-09-05",
      "time": "19:30",
      "status": "scheduled",
      "round": "半决赛",
      "court": "中央球场",
      "bestOf": 3,
      "tournament": {
        "id": "source-tournament-id",
        "name": "赛事名称",
        "tour": "ATP",
        "level": "Grand Slam",
        "surface": "硬地",
        "city": "纽约",
        "country": "美国"
      },
      "players": [
        { "id": "p1", "name": "Player One", "nameZh": "球员一", "country": "CHN", "rank": 20 },
        { "id": "p2", "name": "Player Two", "nameZh": "球员二", "country": "ESP", "rank": 8 }
      ],
      "winnerId": null,
      "score": null,
      "setScores": [],
      "stats": null,
      "sourceUrl": "https://example.com/match"
    }
  ]
}
```

允许的状态为 `scheduled`、`finished`、`cancelled`、`postponed`。技术统计可使用：

```json
{
  "aces": [12, 9],
  "doubleFaults": [3, 5],
  "firstServe": [68, 62],
  "breakPoints": [4, 2]
}
```

## 数据使用原则

- 不直接抓取明确禁止自动化访问的 ATP/WTA 页面或统计接口。
- 每条记录保留来源和来源更新时间。
- 页面展示最后同步时间，并允许数据缺失。
- GitHub 全量采集保持每 6 小时；比赛时段由 Cloudflare 执行低请求量的自适应赛果检查。
- 不推测来源没有提供的准确开赛时间、场地、排名或技术统计。
