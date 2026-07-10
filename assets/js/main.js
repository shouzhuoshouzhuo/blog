(() => {
  const root = document.documentElement;
  const savedTheme = localStorage.getItem("blog-theme");
  if (savedTheme) root.dataset.theme = savedTheme;

  document.querySelector(".theme-toggle")?.addEventListener("click", () => {
    const next = root.dataset.theme === "dark" ? "light" : "dark";
    root.dataset.theme = next;
    localStorage.setItem("blog-theme", next);
  });

  const input = document.querySelector("#article-search");
  const cards = [...document.querySelectorAll(".article-card")];
  const noResults = document.querySelector("#no-results");

  const filterArticles = () => {
    const query = input.value.trim().toLocaleLowerCase("zh-CN");
    let visible = 0;
    cards.forEach((card) => {
      const match = card.dataset.search.toLocaleLowerCase("zh-CN").includes(query);
      card.hidden = !match;
      if (match) visible += 1;
    });
    if (noResults) noResults.hidden = visible !== 0;
  };

  input?.addEventListener("input", filterArticles);
  document.addEventListener("keydown", (event) => {
    if (event.key === "/" && input && document.activeElement !== input) {
      event.preventDefault();
      input.focus();
    }
  });

  const content = document.querySelector("#post-content");
  const toc = document.querySelector("#toc");
  if (content && toc) {
    const headings = [...content.querySelectorAll("h2, h3")];
    headings.forEach((heading, index) => {
      if (!heading.id) heading.id = `section-${index + 1}`;
      const link = document.createElement("a");
      link.href = `#${heading.id}`;
      link.textContent = heading.textContent;
      link.className = heading.tagName === "H3" ? "toc-sub" : "";
      toc.appendChild(link);
    });
    if (!headings.length) document.querySelector(".toc-panel")?.setAttribute("hidden", "");

    content.querySelectorAll("pre").forEach((pre) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "copy-code";
      button.textContent = "复制";
      button.addEventListener("click", async () => {
        await navigator.clipboard.writeText(pre.innerText);
        button.textContent = "已复制";
        window.setTimeout(() => (button.textContent = "复制"), 1400);
      });
      pre.appendChild(button);
    });
  }
})();

