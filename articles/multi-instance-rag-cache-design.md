---
layout: article
title: "多实例 RAG 系统的缓存设计"
date: 2026-09-30
tags: [RAG, 缓存, 分布式系统, 架构设计]
description: "从重复计算与知识更新出发，讲清本地缓存、共享缓存、版本一致性和旧数据回收之间的关系。"
primary_topic: engineering-practice
topics: [ai-agents, engineering-practice]
styles:
  - /assets/css/rag-cache-diagrams.css
published: true
---

## 缓存加上之后，问题才刚开始

一次 RAG 请求通常要把问题转成向量，检索候选片段，重排，再交给模型生成答案。相同的问题反复出现时，每次都走完这条链路，既浪费计算，也增加等待时间。缓存因此很自然地进入设计。

单实例时，把常用结果放进内存，往往就能看到收益。部署成多个实例以后，情况开始变化：请求被分到不同机器，同一份结果可能重复计算；某个实例更新了缓存，其他实例仍然保留旧值；知识库发布时，一次请求可能检索到旧片段，却读取了新文档。

共享 Redis 能减少重复工作，却不能自动回答这些问题。设计之前，需要先约定：**普通内容更新允许短暂读旧，但一次请求必须使用同一份知识快照；权限撤销不能等缓存自然过期。** 下文围绕这个边界展开，不承诺发布瞬间所有实例同时切换。

## 先决定哪些结果值得缓存

缓存对象不同，复用条件也不同。不能拿一个问题文本的哈希，覆盖整条 RAG 链路。

| 对象 | 复用条件 | 主要收益与限制 |
| --- | --- | --- |
| Query embedding | 输入及预处理相同，模型修订版本相同 | 省去向量计算；通常不随知识库更新失效 |
| 检索结果 | 知识快照、查询、过滤条件、权限范围、检索配置相同 | 省去搜索开销；适合作为主要缓存对象 |
| 最终答案 | 上述条件之外，上下文、prompt、生成模型及参数也相同 | 收益大，但错误复用的影响直接到达用户 |
| 活动版本元数据 | 同一租户、同一知识库 | 体积小，却决定请求读哪份数据 |

本文把 embedding 和检索结果作为默认缓存范围。检索缓存保存片段标识、分数及快照标识，取正文时也必须访问同一快照。若缓存重排后的结果，key 还要包含重排模型和配置。

一个简化的 key 可以写成：

```text
embedding:{tenant}:{embedding_revision}:{hash(preprocess,input)}
retrieval:{tenant}:{kb}:{snapshot}:{auth_scope}:{hash(query,filters,retrieval_config)}
```

这里的哈希输入需要稳定序列化；检索配置包含影响结果的模型版本、召回数量等参数。`auth_scope` 表示经过授权服务确认的可见范围，必要时包含策略修订号。命中缓存后，返回片段前仍要核验当前权限；最终答案无法安全剔除其中的失权内容时，应放弃复用。

答案缓存适合条件明确、上下文稳定的请求。语义缓存则多了一层假设：问法相近意味着答案可以复用。否定词、时间限定或权限差异都可能打破这个假设，不能只凭向量相似度直接返回答案。

缓存检索结果时，还要留意“先取候选、再做权限过滤”的位置。如果候选集来自更宽的权限范围，过滤后可能凑不齐所需片段；这时应按当前范围重新检索，不能拿被过滤后的少量结果冒充完整召回。权限范围进入 key，既是隔离要求，也关系到检索质量。

## 两条链路：读取结果，确定版本

结果缓存采用两级结构：实例内的 L1 节省网络往返，共享 Redis 中的 L2 让不同实例复用计算。文档存储、向量索引和元数据 DB 提供权威数据，不把它们称为“第三级缓存”。

<figure class="rag-diagram" aria-labelledby="rag-architecture-caption">
  <div class="rag-diagram__heading"><span>01 / 整体架构</span><strong>结果向上复用，版本向下传播</strong></div>
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
  <figcaption id="rag-architecture-caption">图 1：版本元数据决定读哪个命名空间，结果缓存决定是否需要重新计算。两条链路各有自己的失效规则。</figcaption>
</figure>

请求入口先完成授权，读取活动版本，固定本次使用的快照。随后依次查询 L1、L2，全部未命中才执行检索，结果先写 L2，再填 L1。这就是 cache-aside：由应用负责查缓存和补缓存。

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

## 知识更新时，如何避免读乱

如果更新知识时直接覆盖现有索引，再广播“删除缓存”，就会遇到竞争：删除之后，一个早已开始的请求可能把旧结果重新写回来。多实例越多，越难靠删除时机把窗口堵住。

这里选择不可变快照。每份快照绑定索引、文档和相关配置；新快照准备完成、通过可读性检查以后，再发布为活动版本。请求拿到快照标识后，后续检索、取文档和回填都沿用它，不能中途重新读取活动指针来切换数据。

<figure class="rag-diagram" aria-labelledby="rag-publish-caption">
  <div class="rag-diagram__heading"><span>03 / 发布时序</span><strong>先让数据可读，再让请求看见它</strong></div>
  <ol class="rag-timeline">
    <li><span class="rag-actor">构建任务</span><div><strong>准备待发布快照</strong><span>索引与文档就绪，验证可读性</span></div></li>
    <li><span class="rag-actor">Metadata DB</span><div><strong>事务切换活动指针</strong><span>递增发布序号，同时写入 Outbox</span></div></li>
    <li><span class="rag-actor">分发任务</span><div><strong>按发布序号更新 Redis</strong><span>原子比较后写入，可重试；成功后发送通知</span></div></li>
    <li><span class="rag-actor">服务实例</span><div><strong>更新本地版本副本</strong><span>后续请求选用新快照；在途请求继续使用旧快照</span></div></li>
    <li class="rag-timeline__recovery"><span class="rag-actor">漏收时</span><div><strong>到期重读 + 权威源校准</strong><span>本地重读 Redis；分发侧定期核对 DB 并修复 Redis</span></div></li>
  </ol>
  <figcaption id="rag-publish-caption">图 3：通知缩短传播时间，持久化事件与校准负责恢复。DB 提交完成不等于所有实例已经切换。</figcaption>
</figure>

活动版本记录包含 `snapshot_id` 和单调递增的 `publish_seq`。快照标识回答“读哪份数据”，发布序号回答“哪个发布决策更新”。回滚时可以重新指向旧快照，但必须产生新的发布序号。Redis 和实例本地都按序号更新，避免延迟到达的事件把状态退回去。

这种方案允许不同请求短暂看到不同快照，但不允许同一请求拼接两份快照。若所用向量数据库只能原地更新、无法按快照路由，就不能仅靠给缓存 key 加版本号获得这个保证；需要先提供独立索引、命名空间或等价的快照读取能力。

DB 与 Redis 不能靠两个普通写操作组成事务。Outbox 将活动指针与待分发事件写在同一 DB 事务里，分发任务失败后重试，消费端保持幂等。Redis 丢失记录或恢复后，要从 DB 重新校准，不能把缺失的发布序号当作允许任意旧事件写入。

Redis Pub/Sub 是至多一次投递，断线期间的消息可能永久丢失，因此通知只能加速收敛，不能承担全部一致性保证。[Redis 官方文档](https://redis.io/docs/latest/develop/pubsub/)明确说明了这一点。

本地版本到期后，即使成功读取 Redis，也可能拿到尚未同步的副本。**总体陈旧窗口取决于分发延迟、校准周期和本地版本缓存期限，而非单个 TTL。** 系统还需要记录最近一次权威确认时间，不能因为层层缓存命中就把这个时间刷新。超过业务允许的陈旧期限后，应受控查询权威源；无法确认时停止这类请求，而不是无限使用旧版本。

## 不再读取，和真正删除，是两回事

切换活动版本以后，新请求转到新的 key 空间，旧 key 并没有马上消失。这是有意保留的：在途请求还可能使用它，回滚也可能重新命中它。

<figure class="rag-diagram" aria-labelledby="rag-lifecycle-caption">
  <div class="rag-diagram__heading"><span>04 / 生命周期</span><strong>先切换读取，再分别回收</strong></div>
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

不需要为了“生产就绪”把所有结果都缓存。可以先缓存复用条件明确的 embedding 和检索结果，再根据回源开销决定是否值得增加 L1；答案缓存则等复用边界可验证以后再加入。

如果业务要求发布完成后所有新请求立即读取新版，这套允许短暂陈旧的协议就不够了，需要权威读取或发布屏障，并重新权衡延迟和故障时的可用性。缓存方案是否合适，最终取决于系统愿意承诺什么，以及承诺失效时能否及时发现。

---

本文由一段关于 [active version 存储位置的讨论](https://chatgpt.com/share/6abd1e65-9614-83ee-b3db-f8ebfd1cbb5b)展开。分享页可见内容提出了 Metadata DB、Redis 与本地版本缓存的分层；本文中的快照发布协议、淘汰和故障处理属于补充设计。
