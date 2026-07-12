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

  document.querySelectorAll("[data-runtime-lab]").forEach((lab) => {
    const buttons = [...lab.querySelectorAll("[data-scenario]")];
    const status = lab.querySelector("[data-task-status]");
    const result = lab.querySelector("[data-task-result]");
    const error = lab.querySelector("[data-task-error]");
    const live = lab.querySelector("[data-runtime-lab-live]");
    const nextButton = lab.querySelector("[data-next-step]");
    const stepCount = lab.querySelector("[data-step-count]");
    let selectedScenario = null;
    let stepIndex = 0;

    const clearRun = () => {
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

    const selectScenario = (name) => {
      clearRun();
      selectedScenario = name;
      stepIndex = 0;
      buttons.forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.scenario === name)));
      status.textContent = "PENDING";
      result.textContent = "—";
      error.textContent = "—";
      live.textContent = "场景已选择。点击“下一步”提交任务。";
      stepCount.textContent = `步骤 0/${scenarios[name].length}`;
      nextButton.disabled = false;
      nextButton.textContent = "下一步";
    };

    const advance = () => {
      if (!selectedScenario) return;
      const steps = scenarios[selectedScenario];
      const step = steps[stepIndex];
      if (!step) return;
      render(step);
      stepIndex += 1;
      stepCount.textContent = `步骤 ${stepIndex}/${steps.length}`;
      if (stepIndex === steps.length) {
        nextButton.disabled = true;
        nextButton.textContent = "已完成";
      }
    };

    buttons.forEach((button) => button.addEventListener("click", () => selectScenario(button.dataset.scenario)));
    nextButton.addEventListener("click", advance);
  });
})();
