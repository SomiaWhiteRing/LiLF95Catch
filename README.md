# LiLF95Catch – F95Zone 讨论帖抓取与本地查看器

LiLF95Catch 是一个针对 F95Zone 论坛（当前主要测试目标为 Lessons in Love 讨论帖）的本地抓取与查看工具，包含：

- Python 爬虫：抓取指定线程的每一楼正文与元数据，按楼层区间分片保存为 JSON。  
- Next.js Viewer：把 JSON 分片预构建成静态数据包，浏览器本地过滤、分页和全文搜索。

> 说明：当前实现已经包含完整的抓取、分片、增量更新与文本查看能力。图片本地缓存与用户信息 JSON 维护仍在规划中，后续可以按 PLAN.md 中的设计继续扩展。

---

## 目录结构

- `crawler/`  
  - `lilf95_crawler/`：Python 爬虫实现（解析、存储、CLI）。  
  - `config/`：抓取配置（Cookie、线程 URL 等）。  
- `data/`（运行时生成，已加入 `.gitignore`）  
  - `threads/{thread_id}/meta.json`：线程元信息。  
  - `threads/{thread_id}/state.json`：增量抓取状态。  
  - `threads/{thread_id}/shards/*.json`：按楼层分片的帖子 JSON。  
- `viewer/`  
  - Next.js + TypeScript 静态项目，提供本地/Cloudflare Pages 查看界面。  
- `PLAN.md`  
  - 更详细的设计文档与未来扩展计划。  
- `AGENTS.md`  
  - 面向代码助手的协作与风格约定（也能帮助你理解工程结构）。

---

## 环境依赖

- Python 3.10+（建议开启虚拟环境）。  
- Node.js 18+ 和 npm（或其它兼容的包管理器，如 pnpm）。  
- 访问 F95Zone 的网络环境（爬虫部分会发起 HTTPS 请求）。

---

## 爬虫安装与配置

1. 在仓库根目录安装 Python 依赖：

   ```bash
   python -m venv .venv
   .venv\Scripts\activate  # Windows
   # 或 source .venv/bin/activate  # *nix

   pip install -r requirements.txt
   ```

2. 配置抓取用的 Cookie：

   - 复制示例配置：

     ```bash
     cp crawler/config/config.json.example crawler/config/config.json
     ```

   - 编辑 `crawler/config/config.json`，将：

     ```json
     "raw_cookie_header": "xf_user=YOUR_USER_COOKIE_HERE; xf_session=YOUR_SESSION_COOKIE_HERE"
     ```

     替换为你浏览器中登录 F95Zone 后的完整 `Cookie` 头（至少包含 `xf_user` 与 `xf_session` 等关键字段）。

   - 请勿将真实的 `config.json` 提交到任何公开仓库；本仓库的 `.gitignore` 已忽略该文件。

3. 如需抓取其它线程：

   - 将 `thread_id` 与 `thread_url` 修改为目标帖子的 ID 与 URL。  
   - 其它参数如 `posts_per_shard`、`request_interval_seconds` 可按需要调整。

---

## 运行爬虫

### 1. 全量抓取（推荐配合并发）

如果是第一次抓整个帖子的所有楼层，或者想强制从头刷新所有数据，建议使用 `crawl-remote`，它支持按页并发抓取。

如果不指定 `--from-page` / `--to-page`，爬虫会先抓取第 1 页，自动探测线程的最后一页号，然后从第 1 页一直抓到最后一页：

```bash
python -m crawler.lilf95_crawler.cli crawl-remote \
  --config crawler/config/config.json \
  --schema-version 1
```

`crawler/config/config.json` 中可设置：

- `concurrent_pages`：同时抓取的页数（例如 8），控制“按页并发”；  
- `concurrent_downloads`：每页内部同时下载图片的并发数（例如 4）。

`crawl-remote` 的行为是：

- 在 `from-page .. to-page` 区间内，以 `concurrent_pages` 为上限并发抓取和解析 HTML；  
- 然后按页号顺序，下载该页图片、更新用户信息和头像缓存、写 shard JSON 和进度 `state.json/meta.json`。

### 2. 增量抓取（适合日常更新）

增量抓取会根据 `data/threads/{thread_id}/state.json` 中记录的进度，从上次位置继续向后抓取，直到检测到没有“下一页”为止。

首次运行（从第一页开始）：

```bash
python -m crawler.lilf95_crawler.cli crawl-incremental \
  --config crawler/config/config.json \
  --schema-version 1
```

可选地限制本次最多抓取的页数（调试用），例如一次只抓 3 页：

```bash
python -m crawler.lilf95_crawler.cli crawl-incremental \
  --config crawler/config/config.json \
  --schema-version 1 \
  --max-pages 3
```

每次运行会：

- 自动发现并抓取新页；  
- 解析页面中所有 `article.message--post`；  
- 按楼层号将帖子合并到对应的分片 JSON 文件（默认每 1000 楼一个文件）；  
- 更新：
  - `data/threads/{thread_id}/meta.json`（标题、最后已知页数、最后检查时间等）；  
  - `data/threads/{thread_id}/state.json`（最后抓到的页号、楼层号与 post_id）。

### 2. 指定页区间抓取（手动控制）

如果你只希望抓取某个页区间（例如 3020–3030 页），可以使用：

```bash
python -m crawler.lilf95_crawler.cli crawl-remote \
  --config crawler/config/config.json \
  --from-page 3020 \
  --to-page 3030
```

这同样会将抓取结果合并到对应的 shard 文件，并更新 `meta.json` 与 `state.json`。

### 3. 本地 HTML 调试解析（可选）

仓库根目录下的 `f95_page_3030.html` 是事先保存的一页 HTML 样本，可用来本地调试解析逻辑：

```bash
python -m crawler.lilf95_crawler.cli parse-local f95_page_3030.html \
  -o data/threads/48158/shards/test_page_3030_v1.json
```

---

## 数据结构概览

抓取完成后，你可以在 `data/threads/{thread_id}` 下看到：

- `meta.json`：  
  - 包含 `thread_id`、`thread_url`、`schema_version`、`title`、`last_page_known`、`created_at`、`last_checked_at` 等。  
- `state.json`：  
  - 包含 `last_page_crawled`、`last_post_index`、`last_post_id`、`schema_version`。  
- `shards/{thread_id}_{from}-{to}_v1.json`：  
  - 每个文件覆盖一个固定的楼层区间（例如 `48158_060001-061000_v1.json`），内部包含：  
    - 顶层元数据（线程 ID、分片范围、schema 版本、生成时间）。  
    - `posts` 数组：每条帖子包含 `post_id`、`post_index`、`author_id`、`author_name`、`created_at`、`likes_count`、`content_text_full`、`content_html_raw`、`spoilers`、`attachments` 等字段。

具体字段可参考 `PLAN.md` 与 `crawler/lilf95_crawler/models.py`。

---

## 构建静态 Viewer 数据

Viewer 不再在运行时读取本机文件系统。先把 `data/` 下的 JSON 分片导出为浏览器可缓存的静态数据包：

```bash
python -m crawler.lilf95_crawler.cli build-static-viewer-data \
  --out viewer/public/datasets
```

生成内容在 `viewer/public/datasets/`，每个 JSON chunk 控制在 20 MiB 以下。该目录是构建产物，默认不提交。

---

## 启动 Next.js Viewer

1. 安装依赖（只需在首次使用时执行一次）：

   ```bash
   cd viewer
   npm install
   ```

2. 启动开发服务器：

   ```bash
   npm run dev
   ```

3. 打开浏览器访问：

   - `http://localhost:3000/`：线程列表页面  
   - 如果已经抓到了 `thread_id = 48158` 的数据，你会看到类似 “Lessons in Love” 的条目，点击即可进入该线程的查看页。

Cloudflare Pages 构建命令：

```bash
cd viewer
npm run cf:build
```

输出目录：`viewer/out`。这条命令会先重建静态数据包，再执行 `next build`。

### Cloudflare Pages 部署

仓库已包含 GitHub Actions 工作流：`.github/workflows/deploy-cloudflare-pages.yml`。每次推送到 `master` 会构建并部署到 Cloudflare Pages 项目 `lilf95catch`。

需要在 GitHub 仓库 Secrets 中配置：

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`

PowerShell 设置示例（需要先安装并登录 GitHub CLI）：

```powershell
gh secret set CLOUDFLARE_ACCOUNT_ID -b "YOUR_ACCOUNT_ID"
gh secret set CLOUDFLARE_API_TOKEN -b "YOUR_API_TOKEN"
```

Cloudflare API Token 需要 `Pages:Edit`，如果要自动绑定 `LiLcatch.shatranj.space`，还需要 `DNS:Edit` 和 `Zone:Read`：
https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=%5B%7B%22key%22%3A%22page%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22dns%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22zone%22%2C%22type%22%3A%22read%22%7D%5D&accountId=%2A&zoneId=all&name=LiLF95Catch%20Cloudflare%20Pages%20Deploy

自定义域名：在 Cloudflare Pages 项目 `lilf95catch` 中绑定 `LiLcatch.shatranj.space`。如果 `shatranj.space` 的 DNS 也在 Cloudflare，Pages 会自动补 DNS 记录。

如果 DNS 没有自动出现，在 Cloudflare DNS 手动添加：

```text
Type: CNAME
Name: LiLcatch
Target: lilf95catch.pages.dev
Proxy: On
```

本地一键创建项目、部署并绑定域名：

```powershell
.\scripts\deploy-cloudflare.ps1 `
  -AccountId "YOUR_ACCOUNT_ID" `
  -ApiToken "YOUR_API_TOKEN"
```

如果没有 GitHub CLI，可以在 GitHub 仓库 `Settings -> Secrets and variables -> Actions` 手动添加同名 Secrets；或者先在当前 PowerShell 里设置环境变量：

```powershell
$env:CLOUDFLARE_ACCOUNT_ID="YOUR_ACCOUNT_ID"
$env:CLOUDFLARE_API_TOKEN="YOUR_API_TOKEN"
.\scripts\deploy-cloudflare.ps1 -AccountId $env:CLOUDFLARE_ACCOUNT_ID -ApiToken $env:CLOUDFLARE_API_TOKEN
```

---

## Viewer 功能概览

### 1. 线程列表页（`/`）

- 从 `/datasets/manifest.json` 读取线程列表。  
- 每一项显示：
  - 线程标题（来自 `meta.json` 的 `title`）或 `Thread {id}`。  
  - 一个页数标记（`pages: last_page_known`），如果有的话。  
- 点击某个线程进入 `/threads/{threadId}`。

### 2. 线程查看页（`/threads/{threadId}`）

- 页面顶部显示：
  - 线程标题、ID、最后已知页数 (`last_page_known`)、最后检查时间 (`last_checked_at`)。

- Viewer 强制使用浏览器缓存：
  - 未安装缓存时，线程页只显示状态与“安装数据”，不能检索或打开帖子。
  - 已安装缓存且版本匹配时，帖子元数据、正文 chunk、搜索索引都只从 Cache API 读取。
  - 数据包更新后，“安装数据/更新缓存”会按文件 hash 复用旧缓存中未变化的 chunk，只下载缺失或变化的文件。

- 过滤、排序与分页控件（页面顶部，浏览器 Web Worker 本地执行）：
  - 按作者名包含过滤（`Author (name contains)`）。  
  - 按作者 ID 精确过滤（`Author ID`）。  
  - 按正文关键字过滤（`Text contains`，匹配 `content_text_full`）。  
  - 楼层号范围：最小楼层 (`Min floor #`)、最大楼层 (`Max floor #`)。  
  - 最小点赞/表情数（`Min likes/reactions`）。  
  - 按日期范围过滤（`From date` / `To date`）。  
  - 每页帖子数量（`Page size`，默认 50，最多 200）。  
  - 排序：楼层升序/降序、最新/最早、点赞最多、长文优先、相关度。  
  - 点击“查看结果”会应用当前过滤条件并重置页码为 1。

- 分页信息：
  - 显示当前页 / 总页数 / 当前过滤下的总帖子数。  
  - 提供 Prev / Next 按钮在页之间跳转。

- 帖子列表：
  - 每条帖子展示：
    - 作者名、楼层号（`#post_index`）、发帖时间（本地格式）。  
    - 点赞/表情数（当前为简化统计）。  
    - 正文纯文本（`content_text_full`），以 `<pre>` 形式展示，保留换行。
  - 当前版本中尚未直接渲染原始 HTML（`content_html_raw`），以避免样式和 XSS 复杂度；后续可加一个“切换 HTML 模式”的选项。

---

## 当前状态与后续方向

已经实现：

- 从 F95Zone 远程抓取线程页面（支持登录 Cookie）。  
- 解析并提取每楼的核心字段（post_id、楼层、作者 ID/名、时间、likes、正文文本、剧透块、附件链接等）。  
- 将帖子按楼层范围分片写入 JSON（支持去重更新与 schema_version）。  
- 维护简单的 `meta.json` 和 `state.json`，支持增量抓取。  
- 基于本地 JSON 构建 Next.js Viewer，提供按作者、楼层、时间、点赞数与关键字的过滤和分页浏览。

后续可选改进（见 `PLAN.md`）：

- 图片缓存：Cloudflare 静态版暂不打包本地图片，正文里的远程图片 URL 由浏览器直接加载。  
- 用户信息 JSON：当前已维护全局 `users/users.json`，后续可以在 Viewer 中展示更多用户元信息（加入时间、历史用户名等）并加入基于用户组的过滤。  
- HTML 展示：当前已提供纯文本/HTML 模式切换，后续可优化剧透展开、引用高亮、内联图片排版等。  
- 更丰富的 UI：例如楼主/开发者过滤、“只看某人”、本地标注与收藏、导出筛选结果等。

如果你打算扩展本项目，建议首先阅读 `PLAN.md` 与 `AGENTS.md`，再根据既有结构在 `crawler/` 与 `viewer/` 中逐步添加功能。***
