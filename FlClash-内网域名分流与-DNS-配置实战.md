---
title: "代理与公司网络并行：FlClash 域名分流和 DNS 配置指南"
date: 2026-07-10
tags:
  - FlClash
  - Clash Meta
  - DNS
  - TUN
  - 网络排障
description: "一套可复用、可验证的 FlClash 内部域名直连与分流配置方法。"
---

# 代理与公司网络并行：FlClash 域名分流和 DNS 配置指南

开发环境经常同时依赖两类网络：外部开发工具需要通过代理访问，而测试环境、代码仓库、制品库等内部服务需要使用公司网络和内部 DNS。

开启全局代理或 TUN 后，内部服务可能无法解析、连接超时，甚至被解析成 Fake-IP；关闭代理后，外部工具又无法使用。解决这个问题不需要在两种网络状态之间反复切换，关键是让 FlClash 对内部域名执行三项策略：

```text
内部域名流量 → DIRECT
内部域名解析 → 内部 DNS
内部域名      → 不使用 Fake-IP
```

严格来说，这类配置属于“分流”和“分域 DNS”，并不是传统意义上的“内网穿透”。本文提供一套不依赖具体公司、域名或脚本的复现方法。

## 一、先理解问题发生在哪一层

访问一个 HTTPS 内部站点，大致会经过以下过程：

```text
应用发起请求
  ↓
DNS 解析域名
  ↓
FlClash 根据规则选择 DIRECT 或代理节点
  ↓
系统路由选择网卡和网关
  ↓
与目标服务器建立 TCP/TLS 连接
  ↓
服务器返回 HTTP 响应
```

因此“网页打不开”并不能直接证明代理规则有问题。它可能是：

- DNS 查询使用了错误的服务器；
- Fake-IP 没有被正确还原；
- 域名匹配到了代理节点；
- 当前网络没有到目标网段的路由；
- TLS 证书、服务器或应用接口本身异常；
- 页面能打开，但它调用的另一个 API 域名没有配置。

排障时应逐层验证，而不是一次修改大量设置。

## 二、准备一组安全的示例参数

本文使用以下虚构参数，实际操作时必须替换成自己的值：

| 参数 | 示例值 | 获取方式 |
| --- | --- | --- |
| 内部域名后缀 | `corp.example` | 从内部服务 URL 提取 |
| 内部站点 | `gitlab.corp.example` | 浏览器或项目文档 |
| 内部 DNS | `192.0.2.53` | `scutil --dns` |
| 站点真实 IP | `192.0.2.10` | 关闭代理后查询 |

`192.0.2.0/24` 是文档示例地址段，不能直接用于真实环境。

## 三、在无代理状态下建立基线

先暂停 FlClash 的 TUN 和系统代理，或切换到确认可以访问内部服务的网络状态。

### 1. 查询真实 DNS 结果

```bash
dscacheutil -q host -a name gitlab.corp.example
```

记录返回的真实 IP。若没有结果，继续检查内部 DNS：

```bash
scutil --dns
```

也可以直接向指定 DNS 查询：

```bash
dig @192.0.2.53 gitlab.corp.example
```

### 2. 验证 HTTPS 连通性

```bash
curl -I --connect-timeout 10 https://gitlab.corp.example/
```

以下响应通常都能证明 DNS、TCP 和 TLS 链路已经建立：

- `200`：请求成功；
- `301`、`302`、`307`、`308`：服务器正常返回跳转；
- `401`、`403`：网络已通，但需要认证或缺少权限；
- `404`：请求已到达服务器，只是该路径不存在。

真正值得关注的网络错误包括：

- `Could not resolve host`：DNS 解析失败；
- `Connection timed out`：路由、防火墙或目标服务不可达；
- `Connection refused`：目标地址可达，但端口没有监听；
- TLS 握手错误：证书、SNI 或中间代理可能有问题。

### 3. 检查路由

如果内部服务使用私有网段或 VPN，查看目标 IP 实际从哪个接口发送：

```bash
route -n get 192.0.2.10
netstat -rn -f inet
```

如果关闭代理时也没有到目标网段的路由，仅修改 FlClash 无法解决问题，需要先连接公司 VPN、办公网络或零信任客户端。

## 四、识别 Fake-IP

重新开启 FlClash 后，再次执行：

```bash
dscacheutil -q host -a name gitlab.corp.example
```

若结果落在 FlClash 配置的 `fake-ip-range` 中，说明域名被 Fake-IP 模式接管。Fake-IP 是 Clash 加速域名匹配的正常机制，但分域 DNS、内部域名和部分局域网服务通常需要排除。

不要仅凭某个固定地址段判断。应在当前配置中查看：

```yaml
dns:
  enhanced-mode: fake-ip
  fake-ip-range: <当前 Fake-IP 地址段>
```

## 五、配置内部域名直连

在 `rules` 中加入域名后缀规则：

```yaml
rules:
  - DOMAIN-SUFFIX,corp.example,DIRECT
```

如果只允许某个主机直连，可以使用精确规则：

```yaml
rules:
  - DOMAIN,gitlab.corp.example,DIRECT
```

规则一般从上到下匹配，因此内部域名规则必须位于通用代理规则、规则集或最终 `MATCH` 之前。

多个内部后缀可以分别声明：

```yaml
rules:
  - DOMAIN-SUFFIX,corp.example,DIRECT
  - DOMAIN-SUFFIX,dev.example,DIRECT
  - DOMAIN-SUFFIX,office.example,DIRECT
```

优先使用域名规则，不建议仅按服务器 IP 分流。域名背后可能存在负载均衡、CDN、服务迁移或多个地址。

## 六、排除内部域名的 Fake-IP

在 `dns.fake-ip-filter` 中加入内部域名后缀：

```yaml
dns:
  fake-ip-filter:
    - '+.corp.example'
```

多个内部后缀的写法：

```yaml
dns:
  fake-ip-filter:
    - '+.corp.example'
    - '+.dev.example'
    - '+.office.example'
```

这一步使内部域名返回实际 DNS 结果，而不是 FlClash 分配的占位地址。

## 七、为内部域名指定 DNS

使用 `nameserver-policy` 让指定后缀只通过内部 DNS 查询：

```yaml
dns:
  nameserver-policy:
    '+.corp.example':
      - 192.0.2.53
```

多个内部 DNS 可以按环境配置：

```yaml
dns:
  nameserver-policy:
    '+.corp.example':
      - 192.0.2.53
      - 192.0.2.54
    '+.dev.example':
      - 192.0.2.53
```

内部 DNS 必须能从当前物理网络或 VPN 接口直达。如果 DNS 服务器本身只能通过公司 VPN 访问，配置 FlClash 前要先保证 VPN 路由正常。

## 八、什么时候才应该配置 hosts

如果一个必要域名在内部 DNS 中确实没有记录，但已确认它应指向某个固定服务器，可以临时增加 hosts：

```yaml
hosts:
  legacy-api.corp.example: 192.0.2.10
```

hosts 是最后手段，不应代替正常的 DNS 管理，原因包括：

- IP 变化后客户端会静默访问旧地址；
- 绕过负载均衡和容灾策略；
- 配置分散在个人电脑上，难以统一维护；
- 很容易忘记清理临时映射。

如果多个开发者都需要相同映射，更合理的做法是由网络或运维团队补齐 DNS 记录。

## 九、组合后的最小配置

下面是一份可复制的最小示例：

```yaml
dns:
  enable: true
  enhanced-mode: fake-ip
  fake-ip-filter:
    - '+.corp.example'
  nameserver-policy:
    '+.corp.example':
      - 192.0.2.53

rules:
  - DOMAIN-SUFFIX,corp.example,DIRECT
  # 其他规则……
  - MATCH,<你的默认代理策略组>
```

根据实际情况替换域名、DNS 和默认代理策略组。不要直接照抄示例地址。

## 十、为什么修改后会被覆盖

图形化 Clash 客户端通常同时存在两类配置：

1. 订阅或本地 profile，是配置来源；
2. 运行时配置，是客户端根据 profile 合并生成的结果。

若只修改运行时配置，重新加载订阅、切换 profile 或重启客户端后，修改可能被覆盖。因此需要确认：

- 当前真正启用的是哪个 profile；
- 客户端是否支持“覆写”“扩展配置”或“合并配置”；
- 自定义规则是否应放入覆写文件而不是订阅原文；
- 订阅更新后，自定义内容是否仍然存在。

修改前应创建备份。修改后重新加载当前 profile，必要时完全退出并重启客户端。

## 十一、自动化维护时应遵循的原则

内部域名较多或订阅频繁更新时，可以编写一个小工具自动合并配置。工具无需绑定具体文件名，但应具备以下能力：

- 明确选择目标 profile，而不是猜测某个运行时文件；
- 写入前创建带时间戳的备份；
- 重复执行不会产生重复规则；
- 保留原有节点、代理组和无关规则；
- 同时维护 `rules`、`fake-ip-filter` 和 `nameserver-policy`；
- 使用临时文件完成写入，避免中途失败损坏 YAML；
- 写入后校验 YAML 语法；
- 打印修改位置和恢复方式；
- 不依赖管理员权限运行。

不要通过 `sudo` 掩盖路径、权限或解释器问题。个人配置文件被 root 写入后，客户端可能无法继续更新它。

## 十二、完整验证流程

保持 FlClash 的系统代理和 TUN 开启，依次验证。

### 1. DNS 是否返回真实地址

```bash
dscacheutil -q host -a name gitlab.corp.example
```

结果不应落入当前配置的 `fake-ip-range`。

### 2. HTTPS 是否可达

```bash
curl -I --connect-timeout 10 https://gitlab.corp.example/
```

能收到任意合理 HTTP 状态码，通常表示网络层已打通。

### 3. 实际开发协议是否正常

以 Git 仓库为例：

```bash
git ls-remote https://gitlab.corp.example/group/project.git
```

如果返回引用列表，说明连接和认证都正常；如果提示登录、Token 或权限不足，说明网络已经通，应转为处理凭据问题。

### 4. 检查页面依赖的其他域名

前端页面正常显示，不代表所有后端接口都正常。可以通过浏览器开发者工具的 Network 面板查找失败请求，重点关注：

- API 是否使用另一个域名后缀；
- WebSocket 是否走了不同的主机；
- 登录跳转是否进入了新的认证域名；
- 静态资源、对象存储和制品下载是否来自其他域名。

将新发现的内部域名按同一流程验证，再决定使用精确域名还是整个后缀规则。

### 5. 确认外部代理仍正常

最后验证原本需要代理的开发工具或外部网站。如果内部服务正常，但外部服务全部失效，通常是规则顺序、默认 `MATCH` 或代理策略组被误改。

## 十三、常见错误与判断方法

### 只加 DIRECT 规则

现象：域名仍返回 Fake-IP，连接依旧异常。

原因：路由规则只决定连接走向，不能保证 DNS 使用内部服务器。需要同时配置 Fake-IP 排除和 DNS 策略。

### 只配置内部 DNS

现象：解析正确，但流量仍被送入代理节点。

原因：DNS 与出站策略是两个独立环节。还需要 `DIRECT` 规则。

### 把 HTTP 404 当成网络故障

现象：反复修改网络配置，但问题没有变化。

原因：`404` 已证明请求到达服务器。应检查 URL、接口路径或服务端路由。

### 使用 hosts 固定所有内部服务

现象：短期正常，服务迁移后突然失效。

原因：hosts 绕过了正常 DNS 更新机制。应优先使用分域 DNS。

### 修改错误的配置文件

现象：当时生效，重启或更新订阅后消失。

原因：修改的是生成的运行时配置，而不是当前 profile 或持久化覆写配置。

## 十四、可复用的决策流程

遇到新的内部站点时，可以使用下面的判断顺序：

```text
关闭代理时能访问吗？
├─ 不能 → 先检查公司网络、VPN、路由、DNS 或服务本身
└─ 能
   ↓
开启代理后是否返回 Fake-IP？
├─ 是 → 加入 fake-ip-filter
└─ 否 → 继续
   ↓
是否必须使用内部 DNS？
├─ 是 → 加入 nameserver-policy
└─ 否 → 继续
   ↓
流量是否错误地经过代理？
├─ 是 → 加入 DOMAIN 或 DOMAIN-SUFFIX 的 DIRECT 规则
└─ 否 → 检查 TLS、认证、URL 和应用层错误
```

## 结语

代理与公司网络共存的本质，是把 DNS 解析和流量路由分别配置清楚。最稳定的方案通常由三部分组成：

```text
DOMAIN-SUFFIX → DIRECT
fake-ip-filter → 排除内部域名
nameserver-policy → 指向内部 DNS
```

以后新增测试环境、内部代码仓库、制品库或管理后台时，不需要记住某个特定链接或脚本。只需重新执行“建立直连基线、确认 DNS、配置三层策略、重新加载、逐层验证”这套流程，就能定位并解决大多数代理与内部网络冲突。
