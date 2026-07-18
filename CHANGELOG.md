# 更新日志

## 1.0.0

- 首次发布 Yunzai 版本
- 从 astrbot_plugin_klbq_wiki v1.4.5 完整移植
- 同时支持 `-`、`#klbq`、`/klbq`、`#卡拉彼丘`、`/卡拉彼丘`、`#卡丘`、`/卡丘` 多种命令前缀
- 例如：`-心夏`、`#klbq 心夏`、`#卡丘 心夏 皮肤`
- 支持角色、武器、角色武器、皮肤、生日、赛季、喵言喵语查询
- 使用 Yunzai 内置 puppeteer 渲染图片卡片
- 使用合并转发消息发送皮肤图片
- 使用 cheerio 替代 BeautifulSoup 进行 HTML 解析
- 使用 YAML 配置文件替代 AstrBot WebUI 配置
