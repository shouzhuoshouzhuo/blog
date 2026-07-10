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
---
```

提交并推送到 `main` 分支后，GitHub Actions 会自动构建和发布。

## 本地预览

```bash
bundle install
bundle exec jekyll serve --baseurl /blog
```

访问 `http://127.0.0.1:4000/blog/`。

