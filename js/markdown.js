(() => {
  function escapeHtml(text) {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function inline(text) {
    return escapeHtml(text)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
      .replace(/`([^`\n]+)`/g, "<code>$1</code>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a class="md-link" data-url="$2">$1</a>');
  }

  function hasMarkdown(text) {
    return /```|`[^`\n]+`|\*\*|^#{1,3}\s|^[-*]\s|\]\(https?:/m.test(text);
  }

  function render(container, text) {
    container.classList.add("md");
    const parts = text.split(/```(\w*)\n?/);
    for (let i = 0; i < parts.length; i += 1) {
      if (i % 2 === 1) {
        const lang = parts[i];
        const code = parts[i + 1] || "";
        i += 1;
        const block = document.createElement("div");
        block.className = "md-code";
        const head = document.createElement("div");
        head.className = "md-code-head";
        const langLabel = document.createElement("span");
        langLabel.textContent = lang || "code";
        const copyBtn = document.createElement("button");
        copyBtn.type = "button";
        copyBtn.textContent = "copy";
        copyBtn.addEventListener("click", async () => {
          await navigator.clipboard.writeText(code);
          copyBtn.textContent = "copied";
          setTimeout(() => { copyBtn.textContent = "copy"; }, 1400);
        });
        head.append(langLabel, copyBtn);
        const pre = document.createElement("pre");
        pre.textContent = code.replace(/\n$/, "");
        block.append(head, pre);
        container.appendChild(block);
        continue;
      }
      const chunk = parts[i];
      if (!chunk.trim()) continue;
      const html = chunk
        .split("\n")
        .map((line) => {
          const h = line.match(/^(#{1,3})\s+(.*)$/);
          if (h) return `<div class="md-h${h[1].length}">${inline(h[2])}</div>`;
          const li = line.match(/^[-*]\s+(.*)$/);
          if (li) return `<div class="md-li">${inline(li[1])}</div>`;
          return inline(line);
        })
        .join("\n");
      const span = document.createElement("span");
      span.innerHTML = html;
      container.appendChild(span);
    }
    for (const link of container.querySelectorAll(".md-link")) {
      link.addEventListener("click", () => window.zeno.openExternal(link.dataset.url));
    }
  }

  window.ZenoMd = { hasMarkdown, render };
})();
