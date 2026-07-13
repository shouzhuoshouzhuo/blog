---
layout: article
title: "从 await 到取消：用事件循环理解 asyncio 的协程协作"
date: 2026-07-13
tags:
  - Python
  - asyncio
  - 协程
  - 事件循环
  - 并发控制
description: "从协程、Task 和等待队列出发，建立一套能解释网络 I/O、并发限制与任务取消的 asyncio 心智模型。"
primary_topic: engineering-practice
topics:
  - engineering-practice
  - ai-agents
published: true
---

# 从 await 到取消：用事件循环理解 asyncio 的协程协作

学习 `asyncio` 时，最容易卡住的往往不是语法：`async def`、`await`、`create_task()` 都能很快记住；真正难的是把它们放进同一张运行图里。

例如，`await` 以后究竟是谁继续执行？`create_task()` 创建后会不会立刻运行？取消任务是不是像杀掉一个线程？多个协程都想修改同一个变量时又该怎么办？

这些问题的答案都指向同一个核心：**事件循环如何管理 Task 的状态，并在合适的时机恢复它们。**

本文不讨论 CPython 源码实现，而是建立一套足以指导日常开发的模型。理解这套模型后，HTTP 请求、WebSocket、队列、限流和取消就不再是彼此独立的 API。

## 一、先放下一个误解：asyncio 不等于很多线程

一个典型的 `asyncio` 程序会在一个线程中运行一个事件循环。在这个事件循环线程里，任意时刻只有一个协程在执行 Python 代码。

它的并发来自协作，而不是同时执行：某个协程遇到需要等待的网络、定时器或队列事件时，主动暂停；事件循环趁这段等待时间去推进其他已经就绪的协程。

```text
一个 Event Loop 线程
    │
    ├─ Task A：等待网络响应
    ├─ Task B：等待定时器
    ├─ Task C：正在处理一条消息
    └─ Task D：等待队列中的任务
```

因此下面两句话可以同时成立：

- 同一时刻，只有一个协程在运行 Python 代码；
- 宏观上，很多协程可以交替推进，程序看起来像同时处理很多连接。

这也是 `asyncio` 特别适合网络 I/O 的原因。网络请求的大部分时间都在等待远端返回数据；如果等待时不占住线程，一个线程就能管理大量连接。

## 二、函数、协程对象与 Task 分别是什么

先区分三个经常混在一起的对象：

```python
async def get_user():
    await asyncio.sleep(1)
    return {"name": "小明"}

get_user                  # 协程函数
get_user()                # 协程对象
asyncio.create_task(get_user())  # Task 对象
```

`get_user()` 不会立即执行函数体，它只创建一个“将来可以运行”的协程对象。`Task` 则是事件循环对这个协程的调度包装：它保存运行状态、结果、异常和取消请求，并负责在协程可以继续时恢复它。

```python
async def main():
    task = asyncio.create_task(get_user())

    user = await task
    print(user)
```

这里 `await task` 的结果，就是 `get_user()` 最终 `return` 的值。若协程没有 `return`，结果是 `None`；若它抛出异常，`await task` 会重新抛出该异常。

## 三、await 不是“开始异步”，而是一个暂停点

`await` 后面必须是可等待对象，例如协程、Task 或 Future。它表达的是：

> 当前协程暂时不能继续，请事件循环在等待对象完成后再恢复我。

看一个最小例子：

```python
import asyncio

async def download_file():
    print("开始下载")
    await asyncio.sleep(1)
    print("下载完成")
    return "file-content"

async def main():
    content = await download_file()
    print(content)

asyncio.run(main())
```

执行到 `await download_file()` 时，不是 `main` 被某个后台线程替代了。事件循环会继续推进 `download_file()`；直到它执行到真正会等待的 `await asyncio.sleep(1)`，当前调用链才暂停。

```text
事件循环运行 main
    ↓
main 等待 download_file
    ↓
事件循环推进 download_file
    ↓
download_file 等待定时器
    ↓
事件循环去运行其他就绪 Task
    ↓
定时器到期，恢复 download_file
    ↓
download_file 返回结果，恢复 main
```

可以把事件循环粗略地看成维护两类集合：

```text
就绪队列：现在就能继续运行的 Task
等待集合：正在等网络、定时器、锁、事件或队列数据的 Task
```

等待的事件到达后，对应 Task 会重新进入就绪队列。事件循环并不是严格地对所有任务全局先进先出；谁先从网络、定时器或同步原语的等待中恢复，谁通常就先有机会继续运行。

## 四、create_task() 何时真正执行

`create_task()` 会立刻把协程注册给当前事件循环，但不会在当前这一行强行插队执行。

```python
async def worker():
    print("worker 开始")
    await asyncio.sleep(1)
    print("worker 结束")

async def main():
    task = asyncio.create_task(worker())
    print("main 创建任务")

    await asyncio.sleep(3)
    print("main 等待结束")

asyncio.run(main())
```

典型输出是：

```text
main 创建任务
worker 开始
worker 结束
main 等待结束
```

原因是 `main` 到达 `await asyncio.sleep(3)` 后让出控制权，事件循环才开始调度已经就绪的 `worker`。

这也解释了一个常见问题：如果创建 Task 后马上做很久的同步计算，后台 Task 并不会真的并行运行。

```python
task = asyncio.create_task(worker())

for _ in range(10**9):
    pass  # 没有 await，事件循环没有机会运行 worker
```

`asyncio` 的协作式调度要求开发者主动保留暂停点。耗时的 CPU 计算应改用进程池，或按实际情况交给线程池；不要期待 `create_task()` 自动突破单线程的执行边界。

## 五、HTTP 与 WebSocket：为什么长连接适合 asyncio

以 `aiohttp` 为例：

```python
async with aiohttp.ClientSession() as session:
    async with session.get("https://example.com/api/users") as response:
        data = await response.json()
```

`ClientSession` 可以看成一组可复用的 HTTP 客户端资源。多个请求使用同一个 session 时，向同一协议、主机和端口发起的请求通常可以复用已有 TCP 连接，避免重复建立连接和 HTTPS 的 TLS 握手。

`session.get()` 得到的是响应对象；`await response.json()` 或 `await response.text()` 才是读取响应正文。正文可能尚未完全到达，因此读取也需要成为一个可暂停的 I/O 操作。

WebSocket 更符合这种模型。一条聊天连接大部分时间都在等下一条消息：

```python
async def handle_client(websocket):
    async for message in websocket:
        await websocket.send(f"收到：{message}")
```

客户端没有消息时，协程会停在等待网络数据的位置，不需要持续占用线程。成千上万个“多数时间都在等待”的连接，便可以由少量事件循环线程管理。

不过，收到消息后若立即做长时间 CPU 计算，仍会阻塞事件循环。异步 I/O 不会自动让计算变快。

## 六、四个同步工具分别在等什么

协程会交替运行，因此共享数据依然可能出现竞态。`asyncio` 提供的同步原语，本质上都是把 Task 放进不同的等待队列。

| 工具 | 当前协程在等什么 | 常见用途 |
| --- | --- | --- |
| `Lock` | 独占访问权 | 避免并发修改同一份状态 |
| `Event` | 一次通知 | 等初始化完成、通知关闭 |
| `Queue` | 数据或任务 | 生产者—消费者、后台工作队列 |
| `Semaphore` | 有限名额 | 限制并发请求、数据库连接数 |

### 1. Lock：保护一段不能交错的操作

下面的“读—等待—写”不是原子操作：

```python
balance = 100

async def withdraw():
    global balance
    current = balance
    await asyncio.sleep(0)
    balance = current - 10
```

两个协程都可能读到 `100`，最后各自写回 `90`。使用锁后，只有一个协程能进入临界区：

```python
lock = asyncio.Lock()

async def withdraw():
    global balance
    async with lock:
        current = balance
        await asyncio.sleep(0)
        balance = current - 10
```

锁等待不会阻塞线程；拿不到锁的 Task 会进入这个锁的等待队列。离开 `async with` 后，锁会自动释放，即使代码块中发生异常也不会把其他 Task 永久卡住。

### 2. Event：通知一批等待者

```python
event = asyncio.Event()

async def waiter():
    await event.wait()
    print("初始化完成，可以继续")

async def initializer():
    await load_config()
    event.set()
```

若 Event 尚未触发，`event.wait()` 会把当前 Task 放进 Event 的等待队列。`event.set()` 会唤醒当前所有等待者，并让它们重新进入事件循环的就绪队列。

Event 会保持“已触发”状态，所以之后再执行 `wait()` 的协程会直接通过；需要重新进入等待状态时，使用 `event.clear()`。

### 3. Queue：在协程之间传递工作

```python
queue = asyncio.Queue()

async def producer():
    for url in urls:
        await queue.put(url)

async def consumer():
    while True:
        url = await queue.get()
        try:
            await fetch(url)
        finally:
            queue.task_done()
```

队列为空时，消费者在 `queue.get()` 处等待；有新数据放入时，一个等待的消费者可以继续。队列将“谁生产工作”和“谁处理工作”解耦，适合爬取、消息消费和批处理。

### 4. Semaphore：限制同时在做的事

```python
sem = asyncio.Semaphore(5)

async def fetch_limited(url):
    async with sem:
        return await fetch(url)
```

这里不是只创建五个任务，而是允许很多 Task 存在，但同一时刻最多五个进入请求区域。其他 Task 在 Semaphore 的等待队列中等待名额释放。

这比无节制地同时请求所有 URL 更稳妥：它能保护远端接口，也能避免本地连接池、文件描述符或数据库连接被耗尽。

## 七、取消任务是请求，不是强杀

取消一个 Task 使用：

```python
task.cancel()
```

这不会像终止操作系统线程那样立刻停止任意一行 Python 代码。它向该 Task 标记一个取消请求；Task 通常会在下一次暂停或恢复的边界收到 `asyncio.CancelledError`。

```python
async def worker():
    try:
        while True:
            print("工作中")
            await asyncio.sleep(1)
    except asyncio.CancelledError:
        await close_resources()
        raise
```

若 `worker` 正在等待 `sleep(1)`，调用 `cancel()` 后它会很快从这一行抛出 `CancelledError`。捕获异常的目的通常是关闭连接、刷新缓冲或记录状态；清理完成后应继续 `raise`，让 Task 保持“已取消”状态。

取消方也应等待任务真正结束：

```python
task.cancel()

try:
    await task
except asyncio.CancelledError:
    print("任务已完成清理并取消")
```

如果协程一直运行同步代码、没有任何 `await`，它既无法及时响应取消，也会阻塞整个事件循环。这再次说明：协程的可取消性和可并发性，都依赖明确的协作边界。

## 八、用一张状态图收束整个模型

日常开发不必追踪事件循环的每个内部细节，但可以把一个 Task 想成在以下状态之间移动：

```text
create_task()
    ↓
就绪：等待事件循环执行
    ↓
运行：执行 Python 代码
    ├─ 遇到 await，进入等待状态
    │      ↓
    │   网络、定时器、Queue、Lock、Event 或 Semaphore 就绪
    │      ↓
    └──回到就绪队列

运行结束 → 返回结果 / 抛出异常 / 被取消
```

围绕这张图，许多 API 的行为就能自然解释：

- `await`：从运行转为等待；
- `create_task()`：创建并登记一个可调度 Task；
- `Queue.get()`：等待数据；
- `Lock.acquire()`：等待独占权；
- `Semaphore.acquire()`：等待名额；
- `Event.wait()`：等待通知；
- `task.cancel()`：请求 Task 在下一个安全边界处理取消。

## 九、最后的判断标准

当你想判断某段代码是否适合 `asyncio` 时，可以问三个问题：

1. 它是否会频繁等待网络、磁盘、队列或外部服务？
2. 等待期间是否可以让其他工作继续？
3. 每次恢复后，是否能在较短时间内再次到达下一个 `await`？

三个答案大多为“是”时，`asyncio` 往往很合适。反之，如果主要工作是长时间 CPU 计算，应优先考虑进程池、专门的计算服务或其他并行模型。

异步编程的关键不是记住更多 API，而是始终知道：**当前 Task 在运行、在等待什么，以及谁会让它再次就绪。**理解这一点后，复杂的并发控制就不再只是“给代码加几个 await”。
