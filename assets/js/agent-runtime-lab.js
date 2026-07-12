(() => {
  const scenarios = {
    success: [
      { status: "PENDING", event: "task", node: "bridge", message: "Supervisor 发送 TaskSpec；TaskRecord 仍为 PENDING。" },
      { status: "RUNNING", node: "runtime", message: "Runtime 接受任务；Supervisor 将 TaskRecord 更新为 RUNNING。" },
      { status: "RUNNING", event: "progress", node: "runtime", message: "Runtime 返回 ProgressEvent：这是执行事实，不是生命周期终态。" },
      { status: "RUNNING", event: "result", node: "bridge", message: "Runtime 返回 TaskResult，等待 Supervisor 分类。" },
      { status: "COMPLETED", node: "record", result: "任务结果已返回", message: "Supervisor 接收结果，将唯一 TaskRecord 更新为 COMPLETED。", final: true },
    ],
    timeout: [
      { status: "PENDING", event: "task", node: "bridge", message: "Supervisor 发送 TaskSpec；TaskRecord 仍为 PENDING。" },
      { status: "RUNNING", node: "runtime", message: "Runtime 开始执行；Supervisor 记录 RUNNING。" },
      { status: "RUNNING", event: "deadline", node: "control", message: "Supervisor 观察到总截止时间到达。" },
      { status: "RUNNING", event: "cancel", node: "bridge", message: "Supervisor 发送 Cancellation，通知 Runtime 协作停止。" },
      { status: "TIMED_OUT", node: "record", error: "超过总截止时间", message: "Supervisor 根据取消原因，将 TaskRecord 更新为 TIMED_OUT。", final: true },
    ],
    cancel: [
      { status: "PENDING", event: "task", node: "bridge", message: "Supervisor 发送 TaskSpec；TaskRecord 仍为 PENDING。" },
      { status: "RUNNING", node: "runtime", message: "Runtime 开始执行；Supervisor 记录 RUNNING。" },
      { status: "RUNNING", event: "user-cancel", node: "control", message: "Supervisor 收到用户取消请求。" },
      { status: "RUNNING", event: "cancel", node: "bridge", message: "Supervisor 发送 Cancellation，Runtime 协作停止。" },
      { status: "CANCELLED", node: "record", error: "调用方取消任务", message: "Supervisor 根据用户意图，将 TaskRecord 更新为 CANCELLED。", final: true },
    ],
    error: [
      { status: "PENDING", event: "task", node: "bridge", message: "Supervisor 发送 TaskSpec；TaskRecord 仍为 PENDING。" },
      { status: "RUNNING", node: "runtime", message: "Runtime 开始执行；Supervisor 记录 RUNNING。" },
      { status: "RUNNING", event: "exception", node: "bridge", message: "Runtime 返回 Exception：这是执行失败事实。" },
      { status: "FAILED", node: "record", error: "Runtime 执行失败", message: "Supervisor 接收异常，将 TaskRecord 更新为 FAILED。", final: true },
    ],
  };

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  document.querySelectorAll("[data-runtime-lab]").forEach((lab) => {
    const buttons = [...lab.querySelectorAll("[data-scenario]")];
    const status = lab.querySelector("[data-task-status]");
    const result = lab.querySelector("[data-task-result]");
    const error = lab.querySelector("[data-task-error]");
    const live = lab.querySelector("[data-runtime-lab-live]");
    let timers = [];

    const clearRun = () => {
      timers.forEach(window.clearTimeout);
      timers = [];
      lab.classList.remove("is-running");
      lab.querySelectorAll(".is-active").forEach((element) => element.classList.remove("is-active"));
    };

    const render = (step) => {
      lab.querySelectorAll("[data-event].is-active, [data-node].is-active").forEach((element) => element.classList.remove("is-active"));
      if (step.event) lab.querySelector(`[data-event="${step.event}"]`)?.classList.add("is-active");
      if (step.node) lab.querySelector(`[data-node="${step.node}"]`)?.classList.add("is-active");
      status.textContent = step.status;
      result.textContent = step.result || "—";
      error.textContent = step.error || "—";
      live.textContent = step.message;
      lab.classList.toggle("is-running", !step.final);
    };

    const run = (name) => {
      clearRun();
      buttons.forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.scenario === name)));
      status.textContent = "PENDING";
      result.textContent = "—";
      error.textContent = "—";
      live.textContent = "场景已重置，准备提交任务。";
      lab.classList.add("is-running");

      const delay = reducedMotion.matches ? 80 : 500;
      scenarios[name].forEach((step, index) => {
        timers.push(window.setTimeout(() => render(step), index * delay));
      });
    };

    buttons.forEach((button) => button.addEventListener("click", () => run(button.dataset.scenario)));
  });
})();
