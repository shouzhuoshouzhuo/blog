---
layout: article
title: "多实例 RAG 系统的缓存设计"
date: 2026-09-30
tags: [RAG, 缓存, 分布式系统, 架构设计]
description: "知识库更新后，多个 RAG 实例如何复用缓存、切换版本，并安全回收旧数据。"
primary_topic: engineering-practice
topics: [ai-agents, engineering-practice]
styles:
  - /assets/css/rag-cache-diagrams.css
published: true
---

## 从单实例到多实例

用户连续问了几次相同的问题，RAG 服务却每次都重新计算向量、搜索文档、重排片段，最后再调用模型生成答案。这些步骤中，有一部分工作可以复用。最容易落地的做法，是把问题向量和检索结果暂存在进程内存里。

当服务扩成多个实例，请求经过负载均衡落到不同机器，本地缓存的收益就被摊薄了：这台机器刚算好的结果，另一台机器还要再算一次。于是引入共享 Redis，让实例之间复用结果。本地缓存继续保存最热的数据，省下访问 Redis 的网络往返。

真正麻烦的是知识库更新。文档已经修改，Redis 和各实例的内存里还留着旧结果；更糟的是，请求检索时拿到旧片段标识，读取正文时却碰上了新文档。即使两次读取各自都成功，拼出的上下文也可能不完整。

对于允许短暂更新延迟的知识库，可以让已经开始的请求继续使用旧数据，让后续请求逐步转到新数据。前提是**一次请求从检索到取文档，始终使用同一份知识快照**。这样，更新期间的差异被限制在请求之间，不会混进同一个答案的依据里。

## 缓存的复用条件

相同的问题，不一定对应相同的检索结果。用户的可见范围可能不同，知识库可能已经更新，检索参数也可能变化。缓存 key 必须能够区分这些差异，否则命中率越高，错误结果被复用得越多。

| 对象 | 复用条件 | 主要收益与限制 |
| --- | --- | --- |
| Query embedding | 输入及预处理相同，模型修订版本相同 | 省去向量计算；通常不随知识库更新失效 |
| 检索结果 | 知识快照、查询、过滤条件、权限范围、检索配置相同 | 省去搜索开销；适合作为主要缓存对象 |
| 最终答案 | 上述条件之外，上下文、prompt、生成模型及参数也相同 | 收益大，但错误复用的影响直接到达用户 |
| 活动版本元数据 | 同一租户、同一知识库 | 体积小，却决定请求读哪份数据 |

Embedding 与检索结果通常更容易判断能否复用，可以先从这两处入手。检索缓存保存片段标识、分数和所属快照，取正文时据此定位文档。若缓存的是重排后的结果，重排模型和配置也会影响结果，需要一起进入 key。

两类缓存的 key 可以分别组织为：

```text
embedding:{tenant}:{embedding_revision}:{hash(preprocess,input)}
retrieval:{tenant}:{kb}:{snapshot}:{auth_scope}:{hash(query,filters,retrieval_config)}
```

`tenant` 隔离租户，`snapshot` 指向知识快照，`auth_scope` 区分经过授权服务确认的可见范围。哈希输入要稳定序列化，检索配置则包含模型版本、召回数量等会改变结果的参数。Embedding 的复用不依赖知识快照，但依赖输入预处理和模型修订版本。

最终答案的复用条件更多。追问中的“它”指代什么、采用哪版 prompt、生成参数是否变化，都可能影响答案。语义缓存还会把字面不同的问题归到一起；如果差异恰好是一个否定词或时间限定，相似度很高也可能答错。因此，答案缓存更适合上下文稳定、复用条件可验证的请求。

权限变更需要单独处理。用户失去某份文档的访问权后，即使缓存尚未过期，相关内容也不能再返回。命中缓存后应按当前授权状态核验片段；过滤后候选不足，就按当前范围重新检索。如果缓存的是整段答案，无法可靠剔除其中引用的失权内容，就应放弃复用。普通内容更新可以容忍的延迟，不能直接套到权限撤销上。

## 本地缓存与共享缓存如何配合

服务实例先访问本地 L1，未命中再访问共享 L2，仍未命中才调用向量服务或检索后端。缓存里的结果可以被丢弃，也可以重新计算；文档存储和向量索引则必须保留可供回源的数据。

在查结果之前，实例还得知道当前应该读哪份知识快照。这个活动指针保存在 Metadata DB 中，由 Redis 提供在线读取副本，实例本地再保留一份短期副本。它与检索结果分开管理：结果缓存失效只会多算一次，活动指针过时却会让整个请求继续读旧知识。

<figure class="rag-diagram" aria-labelledby="rag-architecture-caption">
  <div class="rag-diagram__heading"><span>01 / 整体架构</span><strong>结果缓存与活动版本的存储位置</strong></div>
  <div class="rag-architecture">
    <div class="rag-lane">
      <span class="rag-label">结果读取 · 实线</span>
      <div class="rag-node"><strong>多个 RAG 服务实例</strong><span>每个实例持有自己的 L1 热点缓存</span></div>
      <div class="rag-arrow">↓ 未命中时查询 · ↑ 命中后回填</div>
      <div class="rag-node rag-node--accent"><strong>L2 · 共享数据 Redis</strong><span>Embedding / 检索结果</span></div>
      <div class="rag-arrow">↓ 未命中时回源 · ↑ 写入计算结果</div>
      <div class="rag-node"><strong>计算与权威数据</strong><span>Embedding 服务 / 向量索引 / 文档快照</span></div>
    </div>
    <div class="rag-lane rag-lane--version">
      <span class="rag-label">版本传播 · 虚线</span>
      <div class="rag-node"><strong>Metadata DB</strong><span>活动快照 + 发布序号 + Outbox</span></div>
      <div class="rag-arrow">↓ 重试分发 / 定期校准</div>
      <div class="rag-node rag-node--accent"><strong>独立的元数据 Redis</strong><span>活动版本副本 / 更新通知</span></div>
      <div class="rag-arrow">↓ 通知加速 / 到期重读</div>
      <div class="rag-node"><strong>实例本地版本缓存</strong><span>请求入口固定快照，贯穿整个请求</span></div>
    </div>
  </div>
  <figcaption id="rag-architecture-caption">图 1：左侧是结果的读取与回填，右侧是活动版本从 DB 到各实例的传播。每个实例根据本地版本副本选择检索快照。</figcaption>
</figure>

请求进入服务后，先完成授权并取得活动版本，把快照标识保存在请求上下文里。后续查询 L1、L2 和执行检索都使用这个标识。回源成功后，先写 L2，再填 L1，让其他实例也能复用这次计算。这种由应用查询、回源和回填的方式称为 cache-aside。

<figure class="rag-diagram" aria-labelledby="rag-read-caption">
  <div class="rag-diagram__heading"><span>02 / 请求路径</span><strong>一次请求，只携带一个快照标识</strong></div>
  <ol class="rag-flow">
    <li><strong>授权与固定版本</strong><span>得到请求快照和可见范围</span></li>
    <li><strong>查询 L1</strong><span>命中 → 当前权限校验 → 使用结果</span></li>
    <li><strong>未命中：查询 L2</strong><span>命中 → 回填 L1 → 校验并使用</span></li>
    <li><strong>仍未命中：回源</strong><span>按请求快照检索 → 填 L2 / L1 → 校验并使用</span></li>
  </ol>
  <div class="rag-note">回填始终使用请求开始时的快照 key；即使活动版本已经变化，也不改写到新版本名下。</div>
  <figcaption id="rag-read-caption">图 2：图中展示检索缓存。Embedding 有自己的模型版本 key，不必跟随知识快照一起失效。</figcaption>
</figure>

L1 只留热点，并按字节限制容量。大对象不必在每个实例各存一份。缓存命中率也要分层看：L2 的命中率是针对穿过 L1 的请求统计的，不能把两个百分比直接相加。

## 用快照隔离更新中的请求

一种直觉上的更新办法是：修改索引，然后通知所有实例删除旧缓存。但删除缓存时，可能还有请求正在计算。它读的是更新前的数据，算完后照常回填，刚删掉的旧结果又回来了。即使通知没有丢，旧数据也可能重新进入缓存。

给索引和文档建立不可变快照，可以把这场竞争隔离开。构建任务在新的命名空间中准备数据，确认索引、文档和配置都可读之后，再把活动指针切过去。旧请求仍然读旧快照、写旧 key；新请求取得新指针后访问新的 key 空间。旧请求算得再慢，也不会把结果写到新版本名下。

<figure class="rag-diagram" aria-labelledby="rag-publish-caption">
  <div class="rag-diagram__heading"><span>03 / 发布时序</span><strong>知识快照的发布顺序</strong></div>
  <ol class="rag-timeline">
    <li><span class="rag-actor">构建任务</span><div><strong>准备待发布快照</strong><span>索引与文档就绪，验证可读性</span></div></li>
    <li><span class="rag-actor">Metadata DB</span><div><strong>事务切换活动指针</strong><span>递增发布序号，同时写入 Outbox</span></div></li>
    <li><span class="rag-actor">分发任务</span><div><strong>按发布序号更新 Redis</strong><span>原子比较后写入，可重试；成功后发送通知</span></div></li>
    <li><span class="rag-actor">服务实例</span><div><strong>更新本地版本副本</strong><span>后续请求选用新快照；在途请求继续使用旧快照</span></div></li>
    <li class="rag-timeline__recovery"><span class="rag-actor">漏收时</span><div><strong>到期重读 + 权威源校准</strong><span>本地重读 Redis；分发侧定期核对 DB 并修复 Redis</span></div></li>
  </ol>
  <figcaption id="rag-publish-caption">图 3：通知缩短传播时间，持久化事件与校准负责恢复。DB 提交完成不等于所有实例已经切换。</figcaption>
</figure>

活动版本记录需要区分两个字段：`snapshot_id` 指向数据，`publish_seq` 记录发布顺序。回滚时，数据可以指回旧快照，发布序号仍然递增。Redis 和本地副本只接受更新的发布序号，这样迟到的发布事件就不会覆盖后来的回滚决定。

这种方案允许不同请求短暂看到不同快照，但不允许同一请求拼接两份快照。若所用向量数据库只能原地更新、无法按快照路由，就不能仅靠给缓存 key 加版本号获得这个保证；需要先提供独立索引、命名空间或等价的快照读取能力。

接下来要处理的是指针传播。若先更新 DB，再写 Redis，进程可能在两次写入之间退出。可以在 DB 事务里同时更新活动指针，并向事件表写一条待分发记录，这就是事务 Outbox。后台任务读取记录、更新 Redis，失败就重试；重复投递由发布序号和幂等处理消化。Redis 丢失记录或恢复后，还要从 DB 重新校准，不能因为没有序号就接受任意旧事件。

Redis 更新后，可以通过 Pub/Sub 通知各实例刷新本地指针。不过，[Pub/Sub 采用至多一次投递](https://redis.io/docs/latest/develop/pubsub/)，断线期间的消息不会补发。实例需要在本地副本到期后重新读取 Redis，分发侧也要定期核对 DB 与 Redis，修复遗漏的更新。

这里有一个容易漏掉的细节：本地副本到期，不代表下一次就能读到最新版本。如果 Redis 还没同步，本地会再次读到旧指针。因此，更新延迟需要把分发、校准和本地缓存期限一起计算。版本记录应携带最近一次向 DB 确认的时间，普通缓存读取不能刷新这个时间。超过业务允许的陈旧期限，就需要受控访问权威源；仍无法确认版本时，请求应失败。

## 旧缓存什么时候回收

实例切换到新版本以后，旧 key 仍会占用内存。立即扫描删除它们通常没有必要：还在执行的旧请求可能继续使用这些结果，回滚后也可能再次命中。可以让旧缓存随着过期和容量淘汰逐渐退出。

<figure class="rag-diagram" aria-labelledby="rag-lifecycle-caption">
  <div class="rag-diagram__heading"><span>04 / 生命周期</span><strong>从版本切换到旧数据回收</strong></div>
  <div class="rag-lifecycle">
    <div class="rag-life"><span class="rag-label">发布前</span><strong>当前快照服务请求</strong><p>待发布快照完成构建与检查。</p></div>
    <div class="rag-life"><span class="rag-label">传播期间</span><strong>新旧快照短暂并存</strong><p>实例逐步切换；每个请求内部保持版本一致。</p></div>
    <div class="rag-life"><span class="rag-label">停止选用旧版后</span><strong>旧缓存逐渐回收</strong><p>TTL 到期或容量淘汰；迟到回填仍属于旧 key。</p></div>
    <div class="rag-life"><span class="rag-label">保留条件满足后</span><strong>旧快照退出存储</strong><p>无旧版请求、无有效引用，且回滚保留期结束。</p></div>
  </div>
  <figcaption id="rag-lifecycle-caption">图 4：缓存可以丢失并重建，知识快照却是回源依据。两者不能采用同一条删除规则。</figcaption>
</figure>

TTL 的选择也应按对象区分。Embedding 主要受模型和输入变化影响，检索结果与知识快照绑定，活动版本则承担更新传播职责。它们没有必要共享同一个过期配置。数据缓存过期会增加计算，版本缓存过期会触发重新确认，两类成本应分别测量。

三种机制各管一件事：版本切换改变后续请求的选择；TTL 限制条目的存活时间；容量淘汰在内存不足时腾空间。TTL 不是精确的内存释放时刻，也不保证条目一定活到期限结束。

L1 采用带容量上限的 LRU，让最近使用的热点留下。数据 Redis 采用 `allkeys-lfu`，在内存压力下倾向淘汰访问频率较低的 key；它是近似算法，仍需结合对象大小、租户配额和真实访问分布观察效果。[Redis 淘汰策略文档](https://redis.io/docs/latest/develop/reference/eviction/)解释了这些策略与内存上限的关系。

版本元数据使用独立 Redis 部署，配置容量监控与 `noeviction`，写入失败必须告警和重试。同一 Redis 内换一个逻辑 DB，并不能隔离内存淘汰压力。L1 从 L2 回填时保留剩余有效期，不重新赋予完整 TTL，避免副本不断延寿。

旧快照回收还要确认没有实例继续选择它。可以结合实例版本水位、请求最长执行时间和带租约的快照引用判断；只看“这台机器没有旧请求”不够。保留期至少覆盖允许的陈旧窗口、在途请求时间及回滚需要。过期缓存里即便仍有旧片段标识，也不能绕过快照可用性检查。

## 缓存失效时，后端能否接住

热点 key 同时失效，会把省下的工作一次性还给后端。实例内用 singleflight 合并同 key 请求；跨实例可用短租约选出回源者，其他请求限时等待并重查缓存。租约使用所有者令牌，释放时比较令牌，避免误删别人的锁。租约过期仍可能出现重复计算，因此它只用于减少工作，不能充当正确性保证。

TTL 加随机抖动能分散集中到期，却解决不了发布切换造成的集体冷启动。新版本可以预热少量热点，同时限制回源并发、等待队列和重试次数。空检索结果可以短期缓存，但必须按快照和权限隔离；上游故障不能伪装成正常空结果。

Redis 不可用时，仍在有效范围内的 L1 可以继续服务；未命中请求在限流保护下回源，写缓存失败不必让已经成功的计算失败。版本无法确认、权限服务不可用或回源容量耗尽时，应明确失败。不要静默跨版本找一个旧答案来填补空缺。

上线后至少分别观察 L1/L2 命中率、回源并发与延迟、内存淘汰、Outbox 积压、实例发布序号落后程度，以及最近权威确认时间。高命中率与长时间读旧完全可能同时发生。

## 这套设计换来了什么，又付出了什么

| 选择 | 得到的收益 | 承担的代价 |
| --- | --- | --- |
| L1 本地缓存 | 热点请求减少网络往返 | 多实例重复占内存，增加更新传播成本 |
| L2 共享缓存 | 跨实例复用计算 | 多一个网络依赖和容量规划问题 |
| 不可变快照与版本 key | 请求内部一致，迟到回填不污染新版 | 新旧数据并存，发布时命中率下降 |
| 通知与周期校准 | 正常时更新快，漏消息后能恢复 | 只能在约定条件下限制陈旧时间 |
| 独立版本存储与 Outbox | 故障可恢复，发布过程可追踪 | 多出分发任务、监控和运维成本 |

这些成本并不总是值得承担。如果 Redis 的访问延迟已经足够低、热点又不集中，增加 L1 可能只换来更多内存占用和维护工作。如果知识库更新频繁，每次切换都使大部分检索缓存失去复用机会，就要重新估算维护缓存是否划算。

同样，如果发布完成后所有新请求都必须立即读取新版，就要让请求读取权威版本，或在发布时等待服务实例完成切换。这会增加协调开销，也会让版本服务的故障更直接地影响请求。允许短暂读旧，换来的是更少的协调和更好的故障容忍；需要多新的数据，应由业务对答案的要求来决定。
