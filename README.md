# 卡拉彼丘 Wiki 查询（Yunzai 版）

[![Yunzai](https://img.shields.io/badge/Yunzai-Plugin-4c8bf5)](https://github.com/TimeRainStarSky/Yunzai)
[![Version](https://img.shields.io/badge/version-1.4.1-5c6ac4)](https://github.com/qsbb/astrbot_plugin_klbq_wiki)

一个面向 [Yunzai-Bot](https://github.com/TimeRainStarSky/Yunzai)（TRSS-Yunzai / Miao-Yunzai）的卡拉彼丘资料查询插件。数据来自卡拉彼丘 Biligame Wiki，支持角色、武器、皮肤、近期生日、当前赛季和喵言喵语查询。

本插件移植自 [astrbot_plugin_klbq_wiki](https://github.com/qsbb/astrbot_plugin_klbq_wiki) v1.4.5，将原有的 AstrBot Python 实现完整改写为 Yunzai JavaScript 插件。

- 插件名称：`klbq-wiki`
- 当前版本：`1.4.1`
- 作者：凌溪

## 功能特性

- 查询角色资料、背景信息和角色武器
- 查询武器类型、射速、弹匣、移速、换弹时间和分距离部位伤害等数据
- 内置全部角色的常用简称、社区昵称及常见错字
- 查询角色皮肤列表、指定皮肤、宿舍皮和私服皮肤
- 合并发送皮肤模型正面、模型背面和立绘（通过合并转发消息）
- 传说皮肤自动合并基础形态及各进阶形态
- 查询近期角色生日、当前赛季及结束时间
- 从 Wiki 随机获取一条喵言喵语
- 查询结果默认渲染为图片（puppeteer），生图失败时回退文字
- 支持调整图片宽度、每行格子数和渲染超时
- 支持用户自定义别名

## 安装

### 方式一：git 克隆（推荐）

在 Yunzai 根目录下执行：

```bash
git clone --depth=1 https://github.com/qsbb/klbq-wiki.git ./plugins/klbq-wiki/
```

### 方式二：手动下载

下载仓库压缩包，将解压后的插件目录放入：

```text
Yunzai/plugins/klbq-wiki
```

### 安装依赖

在 Yunzai 根目录下执行：

```bash
pnpm install --filter=klbq-wiki
# 或
pnpm install cheerio
```

> 如果使用的是 npm/cnpm，执行：`npm install cheerio`

依赖 `cheerio` 用于 HTML 解析。Yunzai 自带的 `puppeteer` 渲染器用于图片生成。

## 指令说明

插件同时支持以下命令前缀：

```text
-          （连字符，如 -心夏）
#klbq      （如 #klbq 心夏 或 #klbq心夏）
/klbq      （如 /klbq 心夏 或 /klbq心夏）
#卡拉彼丘  （如 #卡拉彼丘 心夏 或 #卡拉彼丘心夏）
/卡拉彼丘  （如 /卡拉彼丘 心夏 或 /卡拉彼丘心夏）
#卡丘      （如 #卡丘 心夏 或 #卡丘心夏）
/卡丘      （如 /卡丘 心夏 或 /卡丘心夏）
```

前缀与关键词之间有无空格均可识别。下表统一使用 `-` 演示，所有前缀均可互换使用。

### 角色与武器

| 指令 | 说明 | 示例 |
| --- | --- | --- |
| `-<角色>` | 查询角色资料 | `-心夏` |
| `-<武器>` | 查询武器资料 | `-空境` |
| `-<角色>武器` | 查询该角色使用的武器 | `-心夏武器` |
| `-<角色>的武器` | 查询该角色使用的武器 | `-心夏的武器` |
| `-<角色> 武器` | 空格形式的角色武器查询 | `-心夏 武器` |

角色和武器查询默认返回图片卡片。角色卡会随机展示当前角色的 Wiki 立绘，武器卡会优先展示透明武器图。

### 皮肤

| 指令 | 说明 | 示例 |
| --- | --- | --- |
| `-<角色> 皮肤` | 按品质列出角色全部皮肤 | `-心夏 皮肤` |
| `-<角色> <皮肤名>` | 查询指定皮肤，支持包含匹配 | `-心夏 休日冒险` |
| `-<角色> 宿舍皮` | 查询通过宿舍获得的皮肤 | `-心夏 宿舍皮` |
| `-<角色> 私皮` | 查询 Wiki 中的私服品质皮肤 | `-心夏 私皮` |

指定皮肤查询会通过合并转发消息发送 Wiki 中实际存在的图片：

- 模型正面
- 模型背面
- 皮肤立绘

传说品质皮肤会自动查找并合并发送基础形态和所有进阶、换色形态。

> 合并转发消息需要适配器支持（OneBot v11 / go-cqhttp / Lagrange 等）。不支持合并转发的适配器会自动退化为逐条发送。

### 生日、赛季与喵言喵语

| 指令 | 说明 |
| --- | --- |
| `-生日` | 返回最近几位即将过生日的角色 |
| `-角色生日` | 与 `-生日` 相同 |
| `-赛季` | 返回当前赛季名称、剩余时间和结束日期 |
| `-赛季结束` | 与 `-赛季` 相同 |
| `-喵言喵语` | 从 Wiki 随机发送一条喵言喵语 |
| `-随机喵言喵语` | 与 `-喵言喵语` 相同 |
| `-喵` | 与 `-喵言喵语` 相同（简写） |

生日按照 `Asia/Shanghai` 时区计算。角色生日和喵言喵语数据会在内存中缓存 6 小时。

### 插件管理（仅主人可用）

| 指令 | 说明 |
| --- | --- |
| `-设置` | 查看所有配置项及当前值 |
| `-设置 <项名>` | 查看指定配置项详情 |
| `-设置 <项名> <值>` | 修改指定配置项（自动保存） |
| `-设置 <项名> on/off` | 布尔项快捷开关 |
| `-设置 重置` | 恢复全部默认配置 |
| `-卡拉彼丘更新` | 拉取 GitHub 上的最新版本（保留本地改动） |
| `-卡拉彼丘强制更新` | 丢弃所有本地改动并强制更新到最新版本 |
| `-更新` / `-强制更新` | 简写形式 |

#### 配置项示例

```text
-设置                              # 查看所有配置
-设置 send_detail_link on         # 开启 Wiki 链接发送
-设置 send_detail_link off        # 关闭 Wiki 链接发送
-设置 render_image off            # 关闭图片渲染，改为纯文字
-设置 auto_restart off            # 关闭更新后自动重启
-设置 restart_delay 5             # 设置重启前等待 5 秒
-设置 grid_columns 3              # 修改图片每行格子数为 3
-设置 birthday_count 10           # 修改生日查询返回数量为 10
-设置 image_timeout 15            # 修改图片渲染超时为 15 秒
-设置 send                        # 查看 send_detail_link 详情（模糊匹配）
-设置 重置                         # 恢复全部默认配置
```

#### 可配置项

| 配置项 | 类型 | 范围 | 说明 |
| --- | --- | --- | --- |
| `render_image` | 布尔 | on/off | 将查询结果渲染为图片卡片 |
| `send_detail_link` | 布尔 | on/off | 查询结果后发送 Wiki 链接 |
| `text_fallback` | 布尔 | on/off | 图片渲染失败后回退文字 |
| `cat_language_image` | 布尔 | on/off | 喵言喵语使用图片发送 |
| `auto_restart` | 布尔 | on/off | 更新成功后自动重启 Yunzai |
| `birthday_count` | 整数 | 1-20 | 生日查询返回角色数量 |
| `restart_delay` | 整数 | 1-30 | 自动重启前等待秒数 |
| `grid_columns` | 整数 | 1-4 | 图片卡片每行格子数 |
| `card_width` | 整数 | 420-1200 | 图片卡片最小宽度（像素） |
| `image_timeout` | 数字 | 1-60 | 图片渲染超时时间（秒） |

> 配置项支持模糊匹配，如 `-设置 send` 会匹配到 `send_detail_link`。当多个配置项都匹配时（如 `image`），会提示无法确定，需要输入完整项名。

#### 更新流程

1. 执行 `git pull --ff-only` 拉取最新代码
2. 输出更新日志和当前版本号
3. 若 `auto_restart` 为 `true`（默认），延时 `restart_delay` 秒后自动重启 Yunzai
4. 若 `auto_restart` 为 `false`，提示用户手动重启

自动重启采用 Yunzai 官方重启机制：通过 redis 设置 `Yz:restart` 标记后 `process.exit`，依赖 PM2 等进程管理器自动拉起新进程。若直接运行 `node app.js`（未使用 PM2），进程退出后需手动重新启动。

强制更新会先执行 `git reset --hard HEAD && git clean -fd` 丢弃所有本地改动（包括配置文件修改），再拉取最新版本。如需保留配置，请提前备份 `config/config.yaml`。

常见错误诊断：

- **本地改动冲突**：提示使用 `-卡拉彼丘强制更新`
- **分支分歧**：提示使用 `-卡拉彼丘强制更新`
- **认证失败**：检查 git 凭据配置
- **更新超时**：60 秒超时，检查网络
- **非 git 仓库**：提示重新克隆

## 别名支持

内置别名可直接用于角色、角色武器和皮肤查询，例如：

```text
-奶妈
-哈基米武器
-LV 皮肤
-盾构 宿舍皮
```

英文别名不区分大小写，例如 `lv`、`LV` 和 `Lv` 均可查询拉薇。

如需补充自己的别名，可在 `config/config.yaml` 的 `custom_aliases` 中按行填写：

```text
心夏老师=心夏
空境武器=空境
```

格式为：`别名=Wiki 页面标题`

自定义英文别名同样不区分大小写。后填写的自定义别名会覆盖同名内置别名。

## 配置项

配置文件位于 `plugins/klbq-wiki/config/config.yaml`，修改后重启 Yunzai 生效：

| 配置项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `birthday_count` | 整数 | `5` | 生日查询返回的角色数量，范围 1–20 |
| `render_image` | 布尔 | `true` | 是否将查询结果优先渲染为图片卡片 |
| `cat_language_image` | 布尔 | `false` | 是否将喵言喵语渲染为图片，关闭时原样发送文字 |
| `send_detail_link` | 布尔 | `false` | 是否在查询结果后单独发送原始 Wiki 链接。默认关闭，因为单独发送链接可能触发其他插件（如 lin-plugin 复读只因）的 bug。图片卡片已包含完整资料，链接非必需 |
| `image_timeout` | 浮点数 | `8` | 图片渲染超时时间，范围 1–60 秒 |
| `text_fallback` | 布尔 | `true` | 图片渲染失败或超时后是否发送文字结果 |
| `grid_columns` | 整数 | `2` | 图片卡片每行资料格子数，范围 1–4 |
| `card_width` | 整数 | `760` | 图片卡片最小宽度，范围 420–1200 像素 |
| `auto_restart` | 布尔 | `true` | 更新成功后自动重启 Yunzai，依赖 PM2 等进程管理器自动拉起 |
| `restart_delay` | 整数 | `3` | 自动重启前等待秒数，范围 1–30，确保消息发送完成 |
| `custom_aliases` | 多行文本 | 空 | 自定义别名，每行填写一条映射 |

## 与 AstrBot 版的区别

| 项目 | AstrBot 版 | Yunzai 版 |
| --- | --- | --- |
| 框架 | AstrBot | Yunzai-Bot / TRSS-Yunzai / Miao-Yunzai |
| 语言 | Python | JavaScript (ES Module) |
| HTTP | aiohttp | fetch (Node 18+ 内置) |
| HTML 解析 | BeautifulSoup + HTMLParser | cheerio |
| 图片渲染 | AstrBot html_render | Yunzai puppeteer (art-template 模板) |
| 合并消息 | Comp.Nodes | Bot.makeForwardMsg / e.group.makeForwardMsg |
| 配置 | AstrBot WebUI 配置 | YAML 配置文件 |
| 命令前缀 | `/klbq`、`/卡拉彼丘` | `-`、`#klbq`、`/klbq`、`#卡拉彼丘`、`/卡拉彼丘`、`#卡丘`、`/卡丘` |

## 输出与平台兼容

- 角色与武器资料使用 Yunzai 内置 puppeteer 渲染为图片。
- 皮肤详情使用合并转发消息发送。
- 合并转发的实际表现取决于消息平台和适配器能力。
- 不支持合并转发的平台会自动退化为逐条发送。
- 所有查询均需要 Yunzai 所在环境能够访问 Biligame Wiki 及其图片域名。

## 常见问题

### 指令没有响应

1. 确认插件已放置在 `plugins/klbq-wiki/` 目录。
2. 确认 `cheerio` 依赖已安装。
3. 重启 Yunzai。
4. 检查后台是否出现以 `[KlbqWiki]` 开头的日志。
5. 确认命令格式正确，例如 `-心夏`、`#klbq 心夏`、`#卡丘 心夏`、`-心夏 皮肤`。
6. 检查是否有其他插件提前拦截了同名指令。

### 图片渲染超时

可以在配置中提高 `image_timeout`，并保持 `text_fallback` 开启。超时后插件会发送文字结果。

### 图片或资料缺失

插件展示的数据和图片来自 Wiki。页面字段未填写、图片尚未上传或 Wiki 页面结构变化时，部分内容可能无法显示。

## 数据来源与免责声明

本插件的数据来自：

- [卡拉彼丘 Biligame Wiki](https://wiki.biligame.com/klbq/)
- [卡拉彼丘 Biligame Wiki API](https://wiki.biligame.com/klbq/api.php)

本项目是非官方社区插件，与《卡拉彼丘》官方及 Biligame Wiki 运营方无隶属关系。游戏名称、角色、图片及相关素材的权利归其各自权利人所有。

Wiki 内容可能因版本更新、页面维护或数据延迟发生变化，请以游戏内信息和官方公告为准。

## 反馈与贡献

遇到问题或希望补充别名、字段和查询功能，可以在 GitHub 提交 Issue。
