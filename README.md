# 守拙手记

个人技术博客，使用 Jekyll 构建并通过 GitHub Pages 自动发布。

## 新增文章

在 `articles/` 目录中新建 Markdown 文件，文件开头填写：

```yaml
---
title: "文章标题"
date: 2026-07-10
tags: [网络, 排障]
description: "一句话摘要"
primary_topic: network-systems
topics: [network-systems, engineering-practice]
---
```

- `primary_topic` 决定文章在主页哪个主题下出现，只填写一个。
- `topics` 决定文章进入哪些主题详情页，可以填写多个。
- `tags` 用于技术关键词和搜索，不参与主题归档。

当前主题 ID：`network-systems`、`ai-agents`、`engineering-practice`、`creation-tools`。

提交并推送到 `main` 分支后，GitHub Actions 会自动构建和发布。

## 本地预览

本地预览建议使用 Ruby 3.1 或更高版本；仅在线发布不需要在电脑上安装 Jekyll。

```bash
bundle install
bundle exec jekyll serve --baseurl /blog
```

访问 `http://127.0.0.1:4000/blog/`。
