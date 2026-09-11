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
3. 更新 `wrangler.jsonc` 中的 `database_id`
4. 初始化线上数据库：`npm run db:init:remote`
5. 部署：`npm run deploy`

## GitHub Actions 配置

在仓库的 **Settings → Secrets and variables → Actions** 中添加：

| Secret | 用途 |
|---|---|
| `WORKER_SYNC_URL` | Worker 的写入接口，例如 `https://tennis-flow.example.workers.dev/api/sync` |
| `SYNC_TOKEN` | Worker 与 GitHub Actions 共用的随机长密钥 |

任务每 6 小时执行一次，也可以在 Actions 页面手动运行。工作流读取昨天到未来七天的 ATP/WTA 单打赛程与赛果，规范化后通过受保护接口写入 D1。

## 自适应赛果检查

Cloudflare Worker 每 10 分钟唤醒一次，但不会每次都请求数据源。未到开赛时间不检查；开赛后，大满贯、ATP/WTA 1000、年终总决赛和奥运会每 10 分钟检查，ATP/WTA 500 每 30 分钟检查，其他及无法识别级别的赛事每 60 分钟检查。只把已完赛、取消或延期且内容发生变化的记录写入 D1；超过开赛时间 18 小时仍无结果时，交由 6 小时全量校准补漏。

定时唤醒历史保存在 `adaptive_cron_runs`，实际访问数据源的历史保存在 `adaptive_sync_runs`，记录赛事分组、目标间隔、HTTP 状态、耗时和更新数量。历史保留 30 天。当同一 ATP/WTA 日期分组在运行中进入更高级别赛事时，会立即按新的更短间隔提频，不再等待旧的慢速计划。

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
