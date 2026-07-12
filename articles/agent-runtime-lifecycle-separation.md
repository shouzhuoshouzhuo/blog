---
layout: article
title: "让执行归执行，让状态归状态：Agent Runtime 的生命周期分层"
date: 2026-07-12
tags:
  - Agent Runtime
  - 异步架构
  - 生命周期管理
  - 并发控制
  - 架构设计
description: "从共享状态竞争出发，拆解 Lifecycle Supervisor 与 Agent Runtime 的职责边界、消息契约和验证方法。"
primary_topic: ai-agents
topics:
  - ai-agents
  - engineering-practice
styles:
  - /assets/css/agent-runtime-lab.css
scripts:
  - /assets/js/agent-runtime-lab.js
published: true
---

# 让执行归执行，让状态归状态：Agent Runtime 的生命周期分层

一个 Agent 子任务通常同时涉及两类工作：一类是调用模型、执行工具、维护消息上下文，真正把任务做完；另一类是限制并发、监督超时、响应取消、记录最终状态，保证任务以可控方式开始和结束。

如果没有明确区分这两类职责，系统很容易演变成下面的结构：Scheduler 在超时时把任务写成 `TIMED_OUT`，Agent Runtime 在稍后完成时又把同一个对象写成 `COMPLETED`，父 Agent 则定时读取共享状态，猜测哪个结果才可信。为了修复竞争，代码继续加入锁、轮询、取消标记和状态覆盖保护，最后每个组件都知道一点生命周期，也都能修改一点状态。

问题不在于线程或异步本身，而在于没有回答一个更基本的问题：

> 谁拥有任务生命周期，谁只负责执行任务？

本文的讨论来自 DeerFlow 2.0 当前的 Subagent 实现，并不是一个虚构示例。DeerFlow 已经将任务调度与 LangGraph 执行放在不同线程中，但 Scheduler 和 Runtime 仍会更新同一个 `SubagentResult`，父侧则通过轮询读取进度。本文先还原这套实现，再进一步抽象 Lifecycle Supervisor 与 Agent Runtime 的职责边界。

## 一、DeerFlow 2.0 当前如何运行 Subagent

在 DeerFlow 2.0 中，Lead Agent 调用 `task` 工具后，实际会进入 `task_tool`。它创建 `SubagentExecutor`，调用 `execute_async()` 登记后台任务，再把执行交给 Scheduler 线程池。

```text
Lead Agent 的 ToolNode
  ↓
task_tool 调用 execute_async()
  ↓
Scheduler 线程池登记 RUNNING、监督超时
  ↓
常驻 Event Loop 线程运行 Subagent LangGraph
  ↓
Scheduler 与 Runtime 更新同一个 SubagentResult
  ↓
task_tool 每 5 秒读取共享任务表
  ↓
完成后返回 ToolMessage 给 Lead Agent
```

这套实现位于同一个 Python 进程中，但涉及三个执行位置：

- 主 Agent Event Loop 运行 `task_tool` 的轮询协程；
- Scheduler worker 在线程池中负责提交任务和同步等待超时；
- 常驻 Event Loop 位于独立线程，真正运行 Subagent 的 LangGraph、LLM 和工具；
- `_background_tasks[task_id]` 保存进程内共享的 `SubagentResult`。

表面上 Scheduler 和 Runtime 已经按执行位置分开，但共享对象又让职责边界混在一起：

- `execute_async()` 创建状态为 `PENDING` 的任务记录；
- Scheduler 会写 `RUNNING`、`started_at`、`TIMED_OUT` 和调度异常；
- Runtime 会写 `ai_messages`、`COMPLETED`、最终结果和执行异常；
- 父侧 `task_tool` 会读取状态、消息、结果和错误；
- 超时、取消与正常完成可能在相邻时刻发生。

假设总超时刚好触发时，Runtime 也刚生成最终答案：

```text
Scheduler                         Runtime
    │                                │
    ├─ status = TIMED_OUT             ├─ result = final_answer
    │                                └─ status = COMPLETED
    ↓
父侧可能已经对外报告超时
```

DeerFlow 当前通过 `SubagentResult.try_set_terminal()` 为终态写入加锁，采用 first-writer-wins：第一个成功写入终态的执行方获胜，迟到的完成或超时不能覆盖它。这能避免状态反复变化，却没有消除根因——系统中仍有两个生命周期决策者。

更稳定的方向不是增加更多锁，而是让一个组件独占生命周期状态，另一个组件只报告执行事实。

## 二、先区分两种完全不同的职责

Lifecycle Supervisor 与 Agent Runtime 关注的问题并不相同。

| Lifecycle Supervisor | Agent Runtime |
| --- | --- |
| 任务能否开始 | 任务具体如何完成 |
| 全局并发是否允许 | 如何调用模型 |
| 截止时间是否到达 | 如何执行工具和外部服务 |
| 用户是否请求取消 | 如何维护本次消息上下文 |
| 最终对外状态是什么 | 产生了哪些进度与结果 |
| 何时释放资源 | 执行失败的原始原因是什么 |

可以把两侧的职责浓缩成两句话：

```text
Supervisor 决定任务是否继续存在
Runtime 决定任务具体如何完成
```

这里的“决定任务是否继续存在”包括并发许可、超时、取消、终态和清理；“具体如何完成”则包括 LangGraph、模型、工具、MCP、消息状态和输出文件。

这是一条架构边界，而不是线程边界。两者可以运行在同一个 Event Loop，也可以位于不同线程、不同进程甚至不同机器。

## 三、架构总览：控制侧、执行侧与消息桥

下面的图不是 DeerFlow 2.0 当前源码的原样结构，而是从现有实现进一步抽象出的目标架构：将职责分为控制侧与执行侧，中间的消息桥只传递任务、取消、进度和执行结果，不允许 Runtime 直接修改控制侧的任务记录。

![Lifecycle Supervisor 与 Agent Runtime 的职责分层图]({{ '/assets/images/agent-runtime-lifecycle-separation.png' | relative_url }})

图中有三个关键结论：

1. Lifecycle Supervisor 是任务状态的唯一所有者；
2. Agent Runtime 只返回事件、结果或异常；
3. 线程只是部署边界，不是职责边界。

只要这三点成立，底层通信可以从本地异步调用替换为线程安全队列、进程消息或远程 RPC，而不会改变上层语义。

## 四、Lifecycle Supervisor：任务状态的唯一所有者

Supervisor 首先创建任务记录：

```text
TaskRecord
├─ task_id
├─ status
├─ result
├─ error
├─ started_at
└─ completed_at
```

这个记录只允许 Supervisor 修改。Runtime 可以报告“执行完成”“工具失败”或“收到取消”，但不能直接把全局任务状态改成 `COMPLETED`、`FAILED` 或 `CANCELLED`。

Supervisor 维护的状态机可以保持很小：

```text
PENDING
   ↓
RUNNING
   ├─ COMPLETED
   ├─ FAILED
   ├─ CANCELLED
   └─ TIMED_OUT
```

所有终态都只能从非终态进入一次。一旦对外发布终态，任务记录就不能再次变化。

除了状态机，Supervisor 还负责四类策略。

### 1. 并发限制

任务提交不等于立即执行。Supervisor 先申请并发许可，只有获得许可后才把状态从 `PENDING` 改为 `RUNNING`。等待许可不应占用执行线程，也不应该伪装成正在运行。

### 2. 超时

超时是生命周期策略，不是 Runtime 的业务结果。Runtime 只感知取消，请求究竟因为总截止时间、用户操作还是上游终止而停止，由 Supervisor 解释并记录。

### 3. 取消

取消信号表达的是“请停止”，而 `CANCELLED` 是 Supervisor 对这次停止的最终分类。两者不能混为一谈，否则 Runtime 会被迫理解所有外部取消来源。

### 4. 清理与发布

无论执行成功、失败、超时还是取消，Supervisor 都必须释放并发许可、清理任务句柄，并向调用方发布一致的最终事件。

## 五、Agent Runtime：只负责把任务做完

Runtime 接收一份任务说明，然后运行 Agent 工作流：

```text
TaskSpec
  ↓
Agent Runtime
  ├─ 模型推理
  ├─ 工具调用
  ├─ MCP / 外部服务
  ├─ 消息上下文
  └─ 输出文件
```

执行过程中，Runtime 可以持续产生进度事件；完成后返回结果，失败时抛出异常，收到取消时结束当前执行。

Runtime 不应该知道以下信息：

- 系统最多允许多少个并发任务；
- 总任务超时时间如何配置；
- 前端使用 SSE、WebSocket 还是轮询；
- 任务记录存放在内存、数据库还是远程服务；
- 父 Agent 如何把结果封装成 ToolMessage；
- 同一个用户是否还有其他后台任务。

这使 Runtime 可以单独运行和测试。只要给它 TaskSpec、进度接收器和取消信号，就能观察它是否正确调用模型、工具并返回结果。

## 六、消息桥只需要四种契约

控制侧与执行侧不需要共享整个内部对象。它们只需交换四类消息。

### 1. 任务请求

方向是：

```text
Supervisor → Runtime
```

任务请求描述要做什么，以及 Runtime 真正需要的执行上下文。它最好是不可变数据，避免执行期间被控制侧悄悄修改。

### 2. 取消请求

方向是：

```text
Supervisor → Runtime
```

取消请求只要求 Runtime 尽快在安全边界停止。Runtime 不负责判断这是用户取消、总超时还是父任务终止。

### 3. 进度事件

方向是：

```text
Runtime → Supervisor
```

进度事件描述已经发生的事实，例如模型开始推理、工具开始执行、阶段性消息生成或输出文件完成。Supervisor 再决定哪些事件需要持久化、审计或推送给前端。

### 4. 执行结果

方向是：

```text
Runtime → Supervisor
```

执行结果可能是正常结果，也可能是异常或对取消的响应。它不是最终生命周期状态；Supervisor 需要结合自己的截止时间和取消原因完成最后分类。

## 七、执行结果如何转换成生命周期状态

下面这个小实验把两类信息并排展示：Runtime 产生的是“执行事实”，例如进度、结果和异常；Supervisor 才把这些事实与截止时间、用户意图结合，写入唯一的 `TaskRecord`。选择一种结局，可以观察消息如何越过边界，以及生命周期状态在哪里变化。

<section class="runtime-lab" data-runtime-lab aria-labelledby="runtime-lab-title">
  <div class="runtime-lab__header">
    <div>
      <p class="runtime-lab__eyebrow">交互实验</p>
      <p class="runtime-lab__title" id="runtime-lab-title"><strong>从执行事实到生命周期状态</strong></p>
    </div>
    <p class="runtime-lab__hint">约每 500ms 推进一步；切换场景会重新开始。</p>
  </div>

  <div class="runtime-lab__controls" role="group" aria-label="选择任务结局">
    <button type="button" data-scenario="success" aria-pressed="false">成功</button>
    <button type="button" data-scenario="timeout" aria-pressed="false">总超时</button>
    <button type="button" data-scenario="cancel" aria-pressed="false">用户取消</button>
    <button type="button" data-scenario="error" aria-pressed="false">Runtime 异常</button>
  </div>

  <div class="runtime-lab__planes">
    <section class="runtime-lab__plane runtime-lab__plane--control" data-node="control" aria-label="控制侧">
      <p class="runtime-lab__plane-tag">Control Plane</p>
      <p class="runtime-lab__plane-title"><strong>Lifecycle Supervisor</strong></p>
      <p>接收执行事实，结合截止时间和用户意图，决定唯一终态。</p>
      <div class="runtime-lab__triggers" aria-label="控制侧策略输入">
        <span data-event="deadline">Deadline</span>
        <span data-event="user-cancel">User Cancel</span>
      </div>
      <div class="runtime-lab__record" data-node="record">
        <span>唯一状态所有者 · TaskRecord</span>
        <strong data-task-status>PENDING</strong>
        <dl>
          <div><dt>result</dt><dd data-task-result>—</dd></div>
          <div><dt>error</dt><dd data-task-error>—</dd></div>
        </dl>
      </div>
    </section>

    <section class="runtime-lab__plane runtime-lab__plane--bridge" data-node="bridge" aria-label="消息桥">
      <p class="runtime-lab__plane-tag">Message Bridge</p>
      <p class="runtime-lab__plane-title"><strong>跨边界消息</strong></p>
      <div class="runtime-lab__events" aria-label="可能经过消息桥的消息">
        <span data-event="task">TaskSpec →</span>
        <span data-event="cancel">Cancellation →</span>
        <span data-event="progress">← ProgressEvent</span>
        <span data-event="result">← TaskResult</span>
        <span data-event="exception">← Exception</span>
      </div>
      <p class="runtime-lab__legend"><span>→ 控制命令</span><span>← 执行事实</span></p>
    </section>

    <section class="runtime-lab__plane runtime-lab__plane--runtime" data-node="runtime" aria-label="执行侧">
      <p class="runtime-lab__plane-tag">Execution Plane</p>
      <p class="runtime-lab__plane-title"><strong>Agent Runtime</strong></p>
      <p>运行 Agent 工作流、模型与工具；只返回事件、结果或异常。</p>
      <div class="runtime-lab__workflow" data-node="workflow">
        <span>Agent workflow</span>
        <small>LLM · Tools · Context</small>
      </div>
      <p class="runtime-lab__boundary">不直接修改 TaskRecord</p>
    </section>
  </div>

  <div class="runtime-lab__readout">
    <span class="runtime-lab__pulse" aria-hidden="true"></span>
    <p data-runtime-lab-live aria-live="polite">选择一个场景，观察状态迁移。</p>
  </div>
  <noscript><p class="runtime-lab__noscript">JavaScript 已关闭。下方状态机、伪代码与文字仍完整说明四条转换路径。</p></noscript>
</section>

Supervisor 可以使用一个集中式的控制结构完成转换：

```python
try:
    result = await runtime.run(task)
except TotalDeadlineExceeded:
    mark_timed_out()
except ParentCancelled:
    mark_cancelled()
except Exception as error:
    mark_failed(error)
else:
    mark_completed(result)
finally:
    release_resources()
```

这段伪代码表达的不是具体 Python API，而是控制权归属：

- Runtime 正常返回，Supervisor 转换为 `COMPLETED`；
- 总截止时间到达，Supervisor 转换为 `TIMED_OUT`；
- 父任务或用户取消，Supervisor 转换为 `CANCELLED`；
- Runtime 抛出其他异常，Supervisor 转换为 `FAILED`；
- 无论哪条路径，资源都由 Supervisor 统一释放。

“转换”不只是修改一个枚举值，还包括填写结果或错误、记录完成时间、发布终态事件，以及阻止后续写入覆盖已经对外承诺的终态。

## 八、为什么单一状态所有者比 first-writer-wins 更容易推理

first-writer-wins 解决的是两个写入者之间的竞争：谁先获得锁，谁决定终态。它适合保护已有共享模型，但仍要求读者理解多个线程、多个写入路径和迟到结果。

单一所有者模型则将问题改写为：

```text
Runtime 报告事实
  ↓
Supervisor 串行处理事实
  ↓
TaskRecord 发生一次合法状态迁移
```

这样带来几个直接收益：

- 不再存在 Runtime 与 Scheduler 同时修改终态；
- 父侧不需要读取一组可能不一致的字段；
- 进度事件与生命周期状态不再混用；
- 状态迁移可以集中记录和审计；
- 测试可以穷举每种输入事件对应的终态；
- Runtime 可以替换，而不影响任务管理协议。

锁可能仍然存在，例如保护任务表或跨线程队列，但锁不再承担“决定业务真相”的职责。

## 九、线程是部署边界，不是职责边界

Supervisor 与 Runtime 可以采用多种部署方式。

### 同一个 Event Loop

两者都是异步协程，通过 await、Task 和 Queue 通信。这是依赖最少的方式，适合所有调用链都能异步化的系统。

### 不同线程

控制线程维持 Gateway 和父 Agent，执行线程维护长期存活的 Runtime Event Loop。双方通过线程安全消息桥交换任务、取消、进度和结果。

### 不同进程或机器

消息桥可以替换为进程队列、消息中间件或 RPC。Supervisor 仍然拥有生命周期，Runtime 仍然只负责执行。

因此架构不应该绑定为“一个线程管状态，另一个线程跑 Agent”。更准确的表达是：

> 一个组件拥有生命周期，一个组件拥有执行逻辑；线程只是它们当前所在的位置。

## 十、常见错误与判断方法

### Runtime 直接修改全局任务状态

现象：Runtime 结束时写 `COMPLETED`，Scheduler 超时时写 `TIMED_OUT`。

判断：同一个状态字段是否存在两个写入者。如果有，状态所有权尚未收口。

### 把取消信号当成最终状态

现象：Runtime 收到取消后直接决定任务是 `CANCELLED`。

问题：它无法判断信号来自用户、总超时还是父任务终止。Runtime 应报告停止事实，由 Supervisor 分类。

### 进度事件直接绑定前端协议

现象：Runtime 内部直接发送 SSE 或拼装 UI 数据。

问题：执行逻辑被具体传输协议绑定。Runtime 应产生 ProgressEvent，由控制侧适配外部协议。

### 为简单调用过早引入完整任务平台

如果任务很短、不需要后台运行、没有进度、取消和并发策略，直接 await Runtime 可能已经足够。职责分层不等于必须引入复杂基础设施。

## 十一、如何验证职责边界真的成立

可以使用以下清单审查设计：

- Runtime 是否直接修改全局 TaskRecord？
- 是否存在两个组件决定最终状态？
- 任务取消的原因是否只由 Supervisor 解释？
- 进度事件是否独立于生命周期状态？
- 前端协议是否侵入 Runtime？
- 替换线程、进程或远程 Worker 后，四种消息契约是否仍然成立？
- Supervisor 是否能在不启动模型的情况下测试全部状态迁移？
- Runtime 是否能在没有 Gateway 的情况下独立运行？
- 任一终态对外发布后，是否保证不再变化？

如果这些问题都有明确答案，说明生命周期和执行逻辑已经真正分开，而不只是被放进了两个不同文件或线程。

## 十二、可复用的决策流程

设计新的 Agent 后台任务时，可以按下面的顺序判断：

```text
任务是否需要超时、取消、并发限制或后台运行？
├─ 否 → 直接调用 Runtime，保持简单
└─ 是
   ↓
谁是 TaskRecord 的唯一写入者？
├─ 不明确 → 先收口生命周期状态
└─ Supervisor
   ↓
Runtime 是否只返回事件、结果或异常？
├─ 否 → 移除对全局状态和外部协议的依赖
└─ 是
   ↓
定义 TaskSpec、Cancellation、ProgressEvent、TaskResult
   ↓
最后再选择同线程、跨线程、跨进程或远程 Worker
```

这个顺序很重要：先确定职责与契约，再选择并发和部署技术。反过来从线程池、锁或消息队列出发，通常只会把已有职责混乱搬到新的基础设施中。

## 结语

Agent 后台任务的稳定性，不只取决于模型和工具是否能运行，还取决于系统能否明确回答：谁允许任务开始，谁决定任务结束，谁拥有最终状态。

最值得保留的四条原则是：

```text
状态只能有一个所有者
执行侧只返回事实，不决定对外状态
组件通过消息通信，不共享可变内部状态
线程是部署选择，职责边界才是架构
```

当 Lifecycle Supervisor 和 Agent Runtime 之间只剩任务、取消、进度和结果四类契约时，系统才能在不改变核心语义的前提下，从单 Event Loop 演进到多线程、进程池或远程 Worker。让执行归执行，让状态归状态，复杂并发问题才会重新变得可推理、可测试、可验证。
