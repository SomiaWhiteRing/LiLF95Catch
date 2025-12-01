# Lessons in Love 讨论帖抓取与查看工具设计（基于真实页面结构修订）

> 目标：使用 Python 抓取 F95Zone 上 Lessons in Love 讨论帖（以及潜在的其它帖子），将数据以分片 JSON + 本地图片方式存储，并用 Next.js 编写一个带丰富过滤功能的本地查看器。

本方案已经根据实际抓取到的 `page-3030` HTML 结构（XenForo 2 论坛）做了修订，尤其是对**隐藏内容/剧透、附件、正文的真实 DOM 组织方式**进行了更精确的建模。

---

## 1. 页面与帖子结构概览

- 页面整体是 XenForo 的 `thread_view` 模板：
  - `<html data-template="thread_view" data-content-key="thread-48158" ...>`
  - 本地调试文件：`f95_page_3030.html`（未登录视图）

- 每一楼对应一个 `article.message.message--post.js-post`：
  - `data-author="TBone9"`：当前显示用户名（字符串）
  - `data-content="post-18745049"`：形如 `post-{post_id}`
  - `id="js-post-18745049"` / 内部 `span#post-18745049`：稳定的 `post_id`

- 楼层元信息：
  - 楼层号：`header.message-attribution ul.message-attribution-opposite li a` 文本形如 `#60,581`
  - 时间：`header.message-attribution time.u-dt`
    - `datetime="2025-11-27T12:42:27+0000"`
    - `data-time="1764247347"`（Unix 时间戳）

- 用户信息：
  - 用户 ID：左侧用户块中 `a.username[data-user-id="5976324"]`
  - 显示用户名：同一个 `a.username` 的文本
  - 其它：加入时间、消息数、点赞数等在 `section.message-user` 内部的 `dl.pairs` 中

- **正文与隐藏内容的真实结构（关键修订点）：**
  - 实际帖子的内容全部在：
    - `div.message-content` → `div.message-userContent.lbContainer` → `article.message-body` → `div.bbWrapper`
  - `bbWrapper` 里的 **所有东西都是“正文的一部分”**：
    - 普通文本（包含 `<br>`、`<p>` 等）
    - 引用块：`blockquote.bbCodeBlock.bbCodeBlock--quote`
    - 剧透/隐藏内容：`div.bbCodeSpoiler` + 内部 `div.bbCodeBlock.bbCodeBlock--spoiler`
    - 图片：`<img.bbImage>`，通常包裹在 `<a href="https://attachments.f95zone.to/...">`
    - 附件链接：`<a href="https://f95zone.to/attachments/xxxx/" target="_blank">View attachment ...</a>`

  这意味着：**隐藏内容并不是额外的字段，而是混在 `bbWrapper` 的 HTML 中，通过特定的 DOM 结构标记出来。**  
  登录后，同一个 `bbCodeSpoiler-content` 中将不再是“没有权限”的提示，而是实际隐藏文本/图片。

---

## 2. 抓取器整体设计（Python）

### 2.1 模块划分

预期 Python 包结构（示意）：

- `crawler/`
  - `config/`：JSON/YAML 配置（Cookie、线程 ID、抓取参数）
  - `lilf95_crawler/`
    - `http_client.py`：请求封装（Cookie、UA、限流、重试）
    - `page_parser.py`：页面级解析（解析出每个 `article.message` 区块）
    - `post_parser.py`：单帖解析（基于 `bbWrapper` 的 DOM）
    - `storage.py`：JSON 分片读写、schema_version 管理
    - `images.py`：图片下载与去重缓存
    - `users.py`：全局用户信息 JSON 维护
    - `state.py`：增量更新进度记录
    - `cli.py`：命令行入口

### 2.2 Cookie 与登录态

- 抓取隐藏内容（剧透）必须使用登录态；配置文件中直接提供 Cookie：
  - 例如 `config/config.json` 中：
    - `cookies.raw_cookie_header = "xf_user=...; xf_session=...; ..."`
  - HTTP 请求时直接设置 `Cookie` 头。

- 抓取器启动时：
  - 读取配置，初始化 `http_client`。
  - 可选：请求一次首页或目标页，检查是否仍为 `data-logged-in="false"`，用于检测 Cookie 是否过期。

### 2.3 抓取流程（单线程基本版）

1. 读取本地已有数据：
   - `data/threads/{thread_id}/meta.json`（如果存在）  
   - 分片文件列表（`shards/`）  
   - `state.json`（增量进度）

2. 从远端获取当前总楼层 / 页数：
   - 访问第一页或最后一页，解析分页组件或 schema.org 的 `userInteractionCount`。

3. 根据本地最大 `post_id` 或最大楼层号，计算需要抓取的页区间。

4. 按页循环：
   - 请求 `.../page-{n}`，解析出所有 `article.message`。
   - 对每个 `article.message` 调用 `post_parser` 输出结构化数据。
   - 收集新帖子，按 `post_id` / 楼层排序。

5. 将新帖子写入 JSON 分片（见后文）。

6. 下载图片，更新附件字段中的 `local_path`。

7. 更新 `users.json` 和 `state.json`。

---

## 3. 单帖解析（基于真实 bbWrapper 结构）

### 3.1 基本字段提取

对于单个 `article.message`：

- `post_id`：
  - 从 `data-content="post-18745049"` 或 `id="js-post-18745049"` 中解析数字部分。

- `post_index`（楼层号）：
  - 从 `header.message-attribution ul.message-attribution-opposite li a` 文本中剥离 `#60,581` → `60581`。

- 作者信息：
  - `author_id`：`section.message-user a.username[data-user-id]`
  - `author_name`：上述 `a.username` 的文本

- 时间信息：
  - `created_at`：`time.u-dt[datetime]`（ISO 字符串）
  - `created_at_epoch`：`time.u-dt[data-time]`（可选）

- 点赞 / 表情：
  - `div.reactionsBar` 下的 `ul.reactionSummary li span.reaction[data-reaction-id]`
    - 可统计各 reaction-id 的计数，也可只存总 `likes_count`。

### 3.2 正文与隐藏内容

- 原始 HTML：
  - 从 `div.bbWrapper` 直接取 `innerHTML`，存为 `content_html_raw`。

- 标准化 HTML：
  - 可选一步：对 `content_html_raw` 做轻度清洗（去除无用属性、补全标签），存为 `content_html_normalized`。

- 纯文本版本：
  - 用 HTML 解析器把 `bbWrapper` 中的所有文本抽出，保留合适的换行，得到 `content_text_full`。

- 剧透（bbCodeSpoiler）标注：
  - 在解析 DOM 时，识别所有：
    - `div.bbCodeSpoiler`：
      - 标题：`button.bbCodeSpoiler-button span.bbCodeSpoiler-button-title` 文本
      - 内容容器：`div.bbCodeSpoiler-content div.bbCodeBlock.bbCodeBlock--spoiler div.bbCodeBlock-content`
  - 登录状态下：
    - 该内容区应包含真正的隐藏文本/图片。
  - 存储方案：
    - 将每个 spoiler 抽出为一个结构化条目（标题 + HTML + 纯文本），同时 **保持其在 `content_html_raw` 中的原始 HTML 不动**。
    - 例如：
      ```json
      "spoilers": [
        {
          "title": "Yumiko",
          "html": "<div class=\"bbCodeBlock bbCodeBlock--spoiler\">...</div>",
          "text": "隐藏内容纯文本..."
        }
      ]
      ```

- 引用块（quote）：
  - 结构：`blockquote.bbCodeBlock.bbCodeBlock--quote`。
  - 不做特别拆分时，可以留在 `content_html_*` 和 `content_text_full` 中即可。
  - 若需要更精细的后续功能，可提取：
    - 引用来源（`a.bbCodeBlock-sourceJump` 中的 `href` 和文本）
    - 引用的 `post_id`（从 `.../goto/post?id=18746094` 中解析）

---

## 4. 附件与图片处理

### 4.1 图片

- 图片通常表现为：
  - `<a href="https://attachments.f95zone.to/...gif"> <img class="bbImage" src="https://attachments.f95zone.to/.../thumb/...gif" ...> </a>`
  - 或其它 `img.bbImage`。

- 策略：
  - 遍历 `bbWrapper` 中所有 `<img>`：
    - 取其 `src`（缩略图）以及上层 `<a>` 的 `href`（原图/附件）。
  - 为每个“原图 URL”创建下载任务：
    - 下载到 `data/threads/{thread_id}/images/{post_id}/...` 或按 hash 分桶。
    - 文件名可以根据 URL path 或内容 hash 生成。

- 存储：
  - 在帖子结构中记录：
    ```json
    "attachments": [
      {
        "type": "image",
        "remote_url": "https://attachments.f95zone.to/2025/11/5504084_1000021698.gif",
        "thumb_url": "https://attachments.f95zone.to/2025/11/thumb/5504084_1000021698.gif",
        "local_path": "threads/48158/images/18745676/5504084_1000021698.gif",
        "filename": "5504084_1000021698.gif"
      }
    ]
    ```
  - 同时在 HTML 查看器中将这些 `local_path` 映射到静态服务路径。

### 4.2 非图片附件

- 常见形式：
  - `a[href^="https://f95zone.to/attachments/"][target="_blank"]`，链接文本类似 `View attachment 5476024`。

- 策略：
  - 不下载文件，只记录链接和显示文本：
    ```json
    {
      "type": "file",
      "remote_url": "https://f95zone.to/attachments/5476024/",
      "filename": "View attachment 5476024"
    }
    ```
  - 在 HTML 查看器中渲染为可点击的外链。

---

## 5. JSON 存储设计（纯 JSON + 分片）

### 5.1 目录结构

- `data/`
  - `threads/{thread_id}/`
    - `meta.json`：线程总体信息（标题、总楼层等）
    - `shards/`：每 1000 楼一个分片 JSON
    - `images/`：本地图片缓存
    - `state.json`：增量抓取状态
  - `users/`
    - `users.json`：全局用户信息索引

### 5.2 分片文件命名与 schema_version

- 命名示例：
  - `threads/48158/shards/48158_000001-001000_v1.json`
  - 其中：
    - `000001-001000`：楼层范围
    - `_v1`：该分片使用的 schema 版本

- 分片 JSON 结构示例（精简）：
  ```json
  {
    "thread_id": 48158,
    "shard_index": 1,
    "range": { "from_post_index": 1, "to_post_index": 1000 },
    "schema_version": 1,
    "generated_at": "2025-01-01T12:00:00Z",
    "posts": [
      {
        "post_id": 18745049,
        "post_index": 60581,
        "author_id": 5976324,
        "author_name": "TBone9",
        "created_at": "2025-11-27T12:42:27+0000",
        "likes_count": 2,
        "content_html_raw": "<div class=\"bbWrapper\">...</div>",
        "content_text_full": "……纯文本……",
        "spoilers": [],
        "attachments": [],
        "capture": {
          "first_seen_at": "2025-11-28T08:52:00Z",
          "last_checked_at": "2025-11-28T08:52:00Z"
        }
      }
    ]
  }
  ```

- schema 演进：
  - 当需要调整字段设计时：
    - 写迁移脚本，读取 `_v1.json`，生成 `_v2.json`。
    - 读取时总是选择同一分片前缀下 `v` 最大的版本。
  - 同一 `post_id` 的“内容更新”（如编辑、点赞数变化）在增量抓取时直接覆盖相应字段。

---

## 6. 用户信息 JSON（防止改名）

- `data/users/users.json` 结构大致为：
  ```json
  {
    "schema_version": 1,
    "users": {
      "5976324": {
        "user_id": 5976324,
        "names": [
          {
            "name": "OldName",
            "first_seen_post_id": 111111,
            "last_seen_post_id": 122222
          },
          {
            "name": "TBone9",
            "first_seen_post_id": 18745049,
            "last_seen_post_id": 20000000
          }
        ],
        "first_seen_at": "2023-04-06T00:00:00Z",
        "last_seen_at": "2025-11-28T08:52:00Z",
        "avatar_url": "https://...",
        "groups": ["Member"]
      }
    }
  }
  ```

- 更新逻辑：
  - 每解析一个帖子：
    - 若 `user_id` 不存在：创建新记录，`names` 添加一条。
    - 若存在且最后一个 `name` 与此次 `author_name` 不同：追加一个新 name 记录。
    - 若相同：更新该 name 的 `last_seen_post_id` 和用户整体的 `last_seen_at`。

---

## 7. 增量更新与中断恢复

- `state.json` 中记录：
  - `last_scanned_post_id`
  - 或者 `last_scanned_page`
  - 上次成功抓取时间等

- 基本策略：
  - 每处理完一页或一批帖子就更新 `state.json`。
  - 下次运行时，从 `state` 指定的位置继续：
    - 例如：从 `last_scanned_post_id` 的下一楼开始。
  - 支持命令行选项：
    - `--full-refresh`：从头重新扫描（但写入时根据 `post_id` 去重/覆盖）。
    - `--from-post N`：从指定楼层重新抓取，用于修复历史数据。

- 分片写入：
  - 根据 `post_index` 将帖子分配到固定楼层范围的分片中。
  - 若某分片已存在：
    - 使用 `post_id` 作为键，对该分片中的帖子进行“更新或插入”。

---

## 8. Next.js 查看器

### 8.1 数据访问层（Node 侧）

- Next.js 的 API Route 直接用 Node `fs` 读 `data/` 下的 JSON：
  - `GET /api/threads/[threadId]/meta`
  - `GET /api/threads/[threadId]/shards`
  - `GET /api/threads/[threadId]/posts`：支持查询参数（作者、时间、楼层范围、likes 阈值、关键字等）

- 在 API 内部按需加载分片：
  - 根据过滤条件与页码计算需要加载的分片集合，避免一次性加载整帖所有数据。
  - 读取分片时，根据文件前缀选择 `schema_version` 最大的 JSON 文件。

### 8.2 过滤与展示功能

- 支持的主要过滤条件：
  - 按作者（单选/多选），用户列表来自 `users.json` 和帖子数据。
  - 按时间范围（起止日期）。
  - 按楼层范围（from / to）。
  - 按点赞数阈值（≥ N）。
  - 只看楼主 / 只看特定用户组（例如开发者）。
  - 关键字 / 简单正则：在 `content_text_full` 中搜索。

- 排序：
  - 默认：按 `post_index` 升序。
  - 可选：按 `likes_count` 降序、`created_at` 等。

- UI 形态：
  - 左侧过滤面板，右侧楼层列表。
  - 楼层项展示：
    - 楼层号、时间、作者（点击可过滤）、点赞数。
    - `content_html_normalized` 直接渲染为 HTML，保留引用块和剧透结构。
  - 剧透交互：
    - 在本地保持 XenForo 类似的“点击展开”行为，
    - 或者提供“全部展开剧透”的选项（由查看器前端控制，不影响原始 HTML 存储）。

### 8.3 图片与静态文件

- Next.js 配置静态目录指向 `data/threads/{thread_id}/images`：
  - 帖子 JSON 中的 `local_path` 映射为可访问的 URL。
  - 楼层中渲染 `<img>` 时使用本地 URL，支持懒加载与预览。

- 附件链接：
  - 按原始 `remote_url` 渲染为外部链接，由浏览器直接访问 F95Zone。

---

## 9. 后续工作与扩展

- **立即可做的下一步：**
  - 在 `crawler/` 下初始化 Python 包和 CLI 骨架。
  - 写一个只针对本地 `f95_page_3030.html` 的解析脚本，验证：
    - `post_id` / 楼层号 / 作者 / 时间的提取。
    - `bbWrapper` 抽取与 `spoilers` / 附件识别逻辑。

- **未来可选扩展：**
  - 多线程/多进程下载。
  - 本地标注与收藏系统（额外的 `annotations.json`）。
  - 导出功能（按过滤条件导出 JSON / Markdown / HTML）。

本设计已经以实际 DOM 为基础，确保隐藏内容、引用、图片和附件都在“正文 bbWrapper”这一统一结构下被正确建模，后续实现时只需按本方案分模块落地即可。

