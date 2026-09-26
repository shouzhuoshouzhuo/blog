(() => {
  const root = document.documentElement;
  const themeToggle = document.querySelector(".theme-toggle");
  const syncTheme = () => {
    const dark = root.dataset.theme === "dark";
    themeToggle?.setAttribute("aria-pressed", String(dark));
    themeToggle?.setAttribute("aria-label", dark ? "切换到浅色主题" : "切换到深色主题");
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#19211e" : "#faf9f6");
  };
  syncTheme();
  themeToggle?.addEventListener("click", () => {
    root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
    try { localStorage.setItem("blog-theme", root.dataset.theme); } catch (_) { /* The toggle also works without storage. */ }
    syncTheme();
  });

  // Mark the most specific matching navigation item, including article pages.
  const navLinks = [...document.querySelectorAll(".site-nav a")];
  const currentPath = window.location.pathname;
  const activeLink = navLinks.slice(1).find((link) => currentPath.startsWith(new URL(link.href).pathname)) || navLinks[0];
  activeLink?.setAttribute("aria-current", "page");

  const input = document.querySelector("#article-search");
  const cards = [...document.querySelectorAll(".article-card")];
  const noResults = document.querySelector("#no-results");
  const status = document.querySelector("#search-status");

  if (input) {
    document.querySelector(".search-box").hidden = false;
    const filterArticles = () => {
      const words = input.value.trim().toLocaleLowerCase("zh-CN").split(/\s+/).filter(Boolean);
      let visible = 0;
      cards.forEach((card) => {
        const matchesSearch = words.every((word) => card.dataset.search.toLocaleLowerCase("zh-CN").includes(word));
        card.hidden = !matchesSearch;
        if (!card.hidden) visible += 1;
      });
      noResults.hidden = visible !== 0 || cards.length === 0;
      status.textContent = `找到 ${visible} 篇文章`;
      document.querySelector(".article-total").textContent = words.length ? `${visible} / ${cards.length} 篇记录` : `${cards.length} 篇记录`;
      document.querySelector(".catalog-end").hidden = visible === 0;
    };
    input.addEventListener("input", filterArticles);
    document.querySelector("#reset-search")?.addEventListener("click", () => {
      input.value = "";
      filterArticles();
      input.focus();
    });
    document.addEventListener("keydown", (event) => {
      const editing = event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
      if (event.key === "/" && !editing && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        input.focus();
      }
      if (event.key === "Escape" && event.target === input) {
        input.value = "";
        filterArticles();
        input.blur();
      }
    });
  }

  const shuffle = document.querySelector("#shuffle-article");
  const randomLink = document.querySelector("#random-article");
  if (shuffle && randomLink && cards.length > 1) {
    const stack = document.querySelector(".reading-note");
    const front = stack.querySelector(".reading-note-front");
    const note = document.querySelector("#random-note");
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let switching = false;
    shuffle.hidden = false;
    shuffle.addEventListener("click", async () => {
      if (switching) return;
      const otherCards = cards.filter((card) => card.querySelector(".article-title").href !== randomLink.href);
      const picked = otherCards[Math.floor(Math.random() * otherCards.length)];
      const link = picked.querySelector(".article-title");
      const showNext = () => {
        randomLink.href = link.href;
        randomLink.textContent = link.textContent;
        document.querySelector("#random-date").textContent = picked.querySelector("time").textContent;
      };
      if (reducedMotion.matches || !front.animate) {
        showNext();
        return;
      }

      switching = true;
      shuffle.setAttribute("aria-disabled", "true");
      note.setAttribute("aria-busy", "true");
      stack.classList.add("is-switching");
      const restingTransform = getComputedStyle(front).transform;
      let leaving;
      let arriving;
      try {
        leaving = front.animate([
          { transform: restingTransform, opacity: 1 },
          { transform: "translate(-32px, -18px) rotate(-7deg)", opacity: 0 }
        ], { duration: 200, easing: "cubic-bezier(.4, 0, 1, 1)", fill: "forwards" });
        await leaving.finished;
        // Change the title and destination only after the old sheet has left.
        showNext();
        arriving = front.animate([
          { transform: "translate(7px, 14px) rotate(4deg) scale(.97)", opacity: 0 },
          { transform: restingTransform, opacity: 1 }
        ], { duration: 320, easing: "cubic-bezier(.16, 1, .3, 1)", fill: "forwards" });
        leaving.cancel();
        await arriving.finished;
      } catch (_) {
        // If a browser interrupts an animation, keep the next article usable.
        showNext();
      } finally {
        leaving?.cancel();
        arriving?.cancel();
        stack.classList.remove("is-switching");
        shuffle.removeAttribute("aria-disabled");
        note.removeAttribute("aria-busy");
        switching = false;
      }
    });
  }

  const copyText = async (button, text) => {
    const original = button.textContent;
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = "已复制";
    } catch (_) {
      button.textContent = "复制失败，请手动选择";
    }
    window.setTimeout(() => { button.textContent = original; }, 1800);
  };
  const content = document.querySelector("#post-content");
  const toc = document.querySelector("#toc");
  if (content && toc) {
    const headings = [...content.querySelectorAll("h2, h3")];
    const links = headings.map((heading, index) => {
      if (!heading.id) heading.id = `section-${index + 1}`;
      const link = document.createElement("a");
      link.href = `#${encodeURIComponent(heading.id)}`;
      link.textContent = heading.textContent;
      link.className = heading.tagName === "H3" ? "toc-sub" : "";
      toc.appendChild(link);
      return link;
    });
    if (!headings.length) document.querySelector(".toc-panel")?.setAttribute("hidden", "");
    let queued = false;
    const updateReading = () => {
      const end = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
      document.querySelector(".reading-progress").style.transform = `scaleX(${Math.min(1, Math.max(0, window.scrollY / end))})`;
      let active = 0;
      headings.forEach((heading, index) => { if (heading.getBoundingClientRect().top <= 140) active = index; });
      links.forEach((link, index) => {
        if (index === active) link.setAttribute("aria-current", "location");
        else link.removeAttribute("aria-current");
      });
      queued = false;
    };
    const scheduleReading = () => { if (!queued) { queued = true; requestAnimationFrame(updateReading); } };
    window.addEventListener("scroll", scheduleReading, { passive: true });
    window.addEventListener("resize", scheduleReading);
    updateReading();
    content.querySelectorAll("pre").forEach((pre) => {
      // Capture code before adding the button so its label is never copied.
      const text = (pre.querySelector("code") || pre).textContent;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "copy-code";
      button.textContent = "复制";
      button.setAttribute("aria-label", "复制代码");
      button.addEventListener("click", () => copyText(button, text));
      pre.appendChild(button);
    });
  }
})();
