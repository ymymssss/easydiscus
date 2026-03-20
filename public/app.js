function el(id) {
  return document.getElementById(id);
}

async function api(path, opts) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || "request_failed");
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function apiForm(path, opts) {
  const res = await fetch(path, {
    credentials: "include",
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || "request_failed");
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function fmtTime(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

const state = {
  me: null,
  sort: "new",
  kind: "",
  status: "",
  tag: "",
  q: "",
  page: 1,
  posts: [],
  openPostId: null,
  openPost: null,
  openConvoId: null,
  eventsSince: 0,
  eventsTimer: null,
  eventsBackoffMs: 700,
  notifiedEventIds: new Set(),
  _qTimer: null,
};

function safeTrim(v) {
  return String(v || "").trim();
}

function isValidUsername(u) {
  return /^[a-zA-Z0-9_]{2,24}$/.test(String(u || ""));
}

function showInline(node, on) {
  if (!node) return;
  node.style.display = on ? "" : "none";
}

function show(node, on) {
  if (!node) return;
  node.hidden = !on;
}

function parseNum(v, fallback) {
  const n = Number(String(v || "").trim());
  return Number.isFinite(n) ? n : fallback;
}

function toast(title, sub, opts) {
  const host = el("toastStack");
  if (!host) return;

  const o = opts || {};
  const kind = o.kind || "info";
  const ttlMs = Number.isFinite(o.ttlMs) ? o.ttlMs : 7000;

  const node = document.createElement("div");
  node.className = `toast ${kind === "warn" ? "toast--warn" : ""}`.trim();
  node.innerHTML = `
    <div class="toast__title">${escapeHtml(title)}</div>
    ${sub ? `<div class="toast__sub">${escapeHtml(sub)}</div>` : ""}
    <div class="toast__tools"></div>
  `;

  const tools = node.querySelector(".toast__tools");
  const actions = Array.isArray(o.actions) ? o.actions : [];
  for (const a of actions) {
    const b = document.createElement("button");
    b.className = "btn btn--tiny btn--ghost";
    b.type = "button";
    b.textContent = a.label || "打开";
    b.addEventListener("click", async () => {
      try {
        if (typeof a.onClick === "function") await a.onClick();
      } finally {
        try {
          node.remove();
        } catch (_e) {
          // ignore
        }
      }
    });
    tools.appendChild(b);
  }

  host.prepend(node);
  if (ttlMs > 0) {
    setTimeout(() => {
      try {
        node.remove();
      } catch (_e) {
        // ignore
      }
    }, ttlMs);
  }
}

function shouldNotifyEvent(ev) {
  // Avoid flooding: only notify for some event types.
  const t = String(ev.type || "");
  if (t === "post.created") return true;
  if (t === "comment.created") return true;
  if (t === "task.claimed") return true;
  return false;
}

function notifyEvent(ev) {
  const id = Number(ev.id);
  if (!Number.isFinite(id)) return;
  if (state.notifiedEventIds.has(id)) return;
  state.notifiedEventIds.add(id);

  const actor = ev.actor ? `@${ev.actor}` : "有人";
  const title = (ev.post && ev.post.title) || "";
  const kind = ev.post && ev.post.kind;
  const status = ev.post && ev.post.status;

  let head = "新动态";
  let sub = title;
  if (ev.type === "post.created") {
    head = kind === "task" ? "新任务" : "新帖子";
    sub = `${actor}：${title}`;
  } else if (ev.type === "comment.created") {
    head = "新评论";
    sub = `${actor}：${title}`;
  } else if (ev.type === "task.claimed") {
    head = "任务被领取";
    sub = `${actor}：${title}${status ? ` · ${statusLabel(status)}` : ""}`;
  }

  toast(head, sub, {
    kind: kind === "task" ? "warn" : "info",
    ttlMs: 9000,
    actions: [
      {
        label: "打开",
        onClick: async () => {
          await openPost(ev.postId);
        },
      },
    ],
  });
}

async function eventsLoop() {
  if (!state.me) return;
  // Lazy init
  if (!state.eventsSince) state.eventsSince = Date.now();

  const url = `/api/events?since=${encodeURIComponent(String(state.eventsSince))}&limit=200&waitMs=25000`;
  try {
    const data = await api(url, { method: "GET" });
    const events = data.events || [];
    for (const ev of events) {
      if (shouldNotifyEvent(ev)) notifyEvent(ev);
    }
    state.eventsSince = Number(data.nextSince || state.eventsSince);
    state.eventsBackoffMs = 700;

    // Keep UI in sync with background changes.
    if (events.length) {
      try {
        await loadTags();
        await loadPosts();
        if (state.openPostId) {
          await openPost(state.openPostId);
        }
      } catch (_e) {
        // ignore
      }
    }

    // Next long-poll immediately.
    state.eventsTimer = setTimeout(eventsLoop, 50);
  } catch (_err) {
    // Backoff on network/auth errors.
    state.eventsTimer = setTimeout(eventsLoop, state.eventsBackoffMs);
    state.eventsBackoffMs = Math.min(Math.floor(state.eventsBackoffMs * 1.7 + 50), 15000);
  }
}

function startEventsIfNeeded() {
  if (state.eventsTimer) return;
  state.eventsSince = Date.now();
  state.notifiedEventIds = new Set();
  state.eventsBackoffMs = 700;
  state.eventsTimer = setTimeout(eventsLoop, 200);
}

function stopEvents() {
  if (state.eventsTimer) {
    clearTimeout(state.eventsTimer);
    state.eventsTimer = null;
  }
}

function statusLabel(s) {
  const map = {
    open: "待领取",
    in_progress: "进行中",
    blocked: "阻塞",
    done: "已完成",
    closed: "已关闭",
  };
  return map[String(s || "")] || "";
}

function statusChipClass(s) {
  const map = {
    open: "chip--status-open",
    in_progress: "chip--status-progress",
    blocked: "chip--status-blocked",
    done: "chip--status-done",
    closed: "chip--status-closed",
  };
  return map[String(s || "")] || "";
}

function kindLabel(k) {
  return String(k || "") === "task" ? "任务" : "帖子";
}

function setModal(modalId, open) {
  const m = el(modalId);
  if (!m) return;
  m.setAttribute("aria-hidden", open ? "false" : "true");
  document.body.style.overflow = open ? "hidden" : "";
  if (open) {
    try {
      const first = m.querySelector(
        "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])",
      );
      first && first.focus && first.focus();
    } catch (_e) {
      // ignore
    }
  }
}

function chip(text, hot) {
  return `<span class="chip ${hot ? "chip--hot" : ""}">${escapeHtml(text)}</span>`;
}

function chip2(text, extraClass) {
  const cls = extraClass ? `chip ${extraClass}` : "chip";
  return `<span class="${cls}">${escapeHtml(text)}</span>`;
}

function postCardHtml(p, idx) {
  const delay = 18 * idx;
  const tags = (p.tags || []).slice(0, 2);
  const tagsHtml = tags.map((t) => chip(`#${t}`, false)).join("");
  const heat = chip2(`${p.likeCount} 赞`, "chip--hot");
  const metaA = chip2(`${p.commentCount} 评论`, "");
  const metaK = p.kind ? chip2(kindLabel(p.kind), "chip--kind") : "";
  const metaS = p.status ? chip2(statusLabel(p.status), statusChipClass(p.status)) : "";
  const metaAsg = p.assignee ? chip2(`@${p.assignee}`, "chip--assignee") : "";
  const meta = `${heat}${metaA}${metaK}${metaS}${metaAsg}${tagsHtml}`;
  const cardClass = p.kind === "task" ? "card card--task" : "card";
  const when = p.createdAt ? fmtTime(p.createdAt) : "";
  return `
    <article class="${cardClass}" tabindex="0" role="button" data-open="post" data-id="${p.id}" style="animation-delay:${delay}ms">
      <div class="card__hdr" aria-hidden="true">
        <div class="card__hdrLeft">#${escapeHtml(String(p.id))}</div>
        <div class="card__hdrRight">${escapeHtml(when)}</div>
      </div>
      <div class="card__info">
        <div class="card__title"><span class="card__tag">@${escapeHtml(p.author)}</span>${escapeHtml(p.title)}</div>
        <div class="card__desc">${escapeHtml(p.excerpt || "")}</div>
        <div class="card__meta">${meta}</div>
      </div>
    </article>
  `;
}

function renderGrid() {
  const grid = el("grid");
  if (!state.posts.length) {
    grid.innerHTML = '<div class="empty">没有内容</div>';
    return;
  }
  grid.innerHTML = state.posts.map(postCardHtml).join("");
}

async function refreshMe() {
  const data = await api("/api/me", { method: "GET" });
  state.me = data.user;
  el("brandSub").textContent = state.me
    ? `已登录：${state.me.username}${state.me.isAdmin ? " · 管理员" : ""}`
    : "未登录 · 可浏览，登录后可发帖/评论/点赞";
  el("authBtn").textContent = state.me ? "账号" : "登录";

  const authTitle = el("authTitle");
  const authSub = el("authSub");
  if (state.me) {
    if (authTitle) authTitle.textContent = "账号";
    if (authSub) authSub.textContent = "Tokens / 私信 / Events";
  } else {
    if (authTitle) authTitle.textContent = "登录 / 注册";
    if (authSub) authSub.textContent = "首个注册用户自动成为管理员";
  }

  showInline(el("adminTab"), !!(state.me && state.me.isAdmin));
  showInline(el("adminMintRow"), !!(state.me && state.me.isAdmin));

  if (state.me) {
    startEventsIfNeeded();
  } else {
    stopEvents();
  }
}

async function loadTags() {
  const data = await api("/api/tags/trending", { method: "GET" });
  const sel = el("tagSelect");
  const cur = sel.value;
  const options = [
    '<option value="" selected>全部标签</option>',
    ...data.tags.map((t) => {
      return `<option value="${escapeHtml(t.tag)}">#${escapeHtml(t.tag)} (${t.count})</option>`;
    }),
  ].join("");
  sel.innerHTML = options;
  sel.value = cur;
}

async function loadPosts() {
  const qs = new URLSearchParams();
  qs.set("sort", state.sort);
  if (state.kind) qs.set("kind", state.kind);
  if (state.status) qs.set("status", state.status);
  if (state.tag) qs.set("tag", state.tag);
  if (state.q) qs.set("q", state.q);
  qs.set("page", String(state.page));
  qs.set("limit", "20");

  const data = await api(`/api/posts?${qs.toString()}`, { method: "GET" });
  state.posts = data.posts;
  renderGrid();

  const info = el("pageInfo");
  if (info) {
    const hasPrev = state.page > 1;
    const hasNext = (data.posts || []).length >= 20;
    info.textContent = `第 ${state.page} 页${state.q ? " · 搜索" : ""}${state.tag ? " · #" + state.tag : ""}`;
    if (el("prevPage")) el("prevPage").disabled = !hasPrev;
    if (el("nextPage")) el("nextPage").disabled = !hasNext;
  }
}

async function openPost(id) {
  const data = await api(`/api/posts/${id}`, { method: "GET" });
  state.openPostId = id;
  state.openPost = data.post;

  el("modalWho").textContent = data.post.author;
  el("modalMeta").textContent = `${fmtTime(data.post.createdAt)} · ${data.post.likeCount} 赞`;
  el("modalTitle").textContent = data.post.title;
  el("modalBody").innerHTML = data.post.bodyHtml;
  el("modalChips").innerHTML = (data.post.tags || []).slice(0, 6).map((t) => chip(`#${t}`, false)).join("");

  el("likeBtn").textContent = data.post.likedByMe ? "已赞" : "点赞";
  el("editBtn").style.display = data.post.canEdit ? "inline-flex" : "none";
  el("deleteBtn").style.display = data.post.canEdit ? "inline-flex" : "none";

  const canClaim =
    state.me &&
    data.post.kind === "task" &&
    String(data.post.status) === "open" &&
    (!data.post.assignee || String(data.post.assignee) === String(state.me.username));
  const claimBtn = el("claimBtn");
  if (claimBtn) {
    claimBtn.style.display = canClaim ? "inline-flex" : "none";
    claimBtn.textContent = "领取";
  }

  el("editor").hidden = true;
  await loadComments();
  setModal("modal", true);
  try {
    // Reset scroll for mobile full-screen modal.
    const body = el("modal").querySelector(".modal__body");
    if (body) body.scrollTop = 0;
  } catch (_e) {
    // ignore
  }
}

function setAcctPane(name) {
  const map = {
    tokens: el("paneTokens"),
    chat: el("paneChat"),
    events: el("paneEvents"),
    admin: el("paneAdmin"),
  };
  Object.entries(map).forEach(([k, n]) => {
    if (!n) return;
    n.hidden = k !== name;
  });
  try {
    el("accountPanel")
      .querySelectorAll(".accountTabs [data-acct]")
      .forEach((b) => b.classList.toggle("tab--active", b.getAttribute("data-acct") === name));
  } catch (_e) {
    // ignore
  }
}

function renderTokens(tokens) {
  const list = el("tokenList");
  if (!list) return;
  if (!tokens || !tokens.length) {
    list.innerHTML = '<div class="empty">暂无 Token</div>';
    return;
  }
  list.innerHTML = tokens
    .map((t) => {
      const exp = t.expiresAt ? fmtTime(t.expiresAt) : "永不过期";
      const used = t.lastUsedAt ? fmtTime(t.lastUsedAt) : "未使用";
      return `
        <div class="row">
          <div class="row__main">
            <div class="row__title">${escapeHtml(t.name)} <span class="muted">#${escapeHtml(String(t.id))}</span></div>
            <div class="row__sub">创建：${escapeHtml(fmtTime(t.createdAt))} · 最近：${escapeHtml(used)} · 过期：${escapeHtml(exp)}</div>
          </div>
          <div class="row__tools">
            <button class="btn btn--tiny btn--danger" data-token-revoke="${escapeHtml(String(t.id))}">撤销</button>
          </div>
        </div>
      `;
    })
    .join("");
}

async function refreshTokens() {
  const raw = el("tokenRaw");
  if (raw) raw.style.display = "none";
  const data = await api("/api/tokens", { method: "GET" });
  renderTokens(data.tokens || []);
}

function renderConvos(convos) {
  const list = el("convoList");
  if (!list) return;
  if (!convos || !convos.length) {
    list.innerHTML = '<div class="empty">暂无对话</div>';
    return;
  }
  list.innerHTML = convos
    .map((c) => {
      const title = c.kind === "dm" ? `DM #${c.id}` : c.title || `Group #${c.id}`;
      const hot = state.openConvoId === c.id;
      return `<button class="row row--btn ${hot ? "row--hot" : ""}" type="button" data-open-convo="${escapeHtml(String(c.id))}">
        <div class="row__main">
          <div class="row__title">${escapeHtml(title)}</div>
          <div class="row__sub">创建：${escapeHtml(fmtTime(c.createdAt))}</div>
        </div>
      </button>`;
    })
    .join("");
}

function renderMsgs(msgs) {
  const box = el("convoMsgs");
  if (!box) return;
  if (!msgs || !msgs.length) {
    box.innerHTML = '<div class="empty">暂无消息</div>';
    return;
  }
  box.innerHTML = msgs
    .map((m) => {
      const who = `<span class="cName">${escapeHtml(m.author)}</span>`;
      const when = `<span class="cTime">${escapeHtml(fmtTime(m.createdAt))}</span>`;
      return `<div class="commentBox"><div class="cHead">${who}${when}</div><div class="md">${m.bodyHtml}</div></div>`;
    })
    .join("");
  try {
    box.scrollTop = box.scrollHeight;
  } catch (_e) {
    // ignore
  }
}

async function refreshConvos() {
  const data = await api("/api/conversations", { method: "GET" });
  renderConvos(data.conversations || []);
}

async function openConvo(id) {
  state.openConvoId = id;
  const data = await api(`/api/conversations/${id}/messages?limit=200`, { method: "GET" });
  el("convoTitle").textContent = `对话 #${id}`;
  renderMsgs(data.messages || []);
  await refreshConvos();
}

function renderEvents(events) {
  const list = el("eventsList");
  if (!list) return;
  if (!events || !events.length) {
    list.innerHTML = '<div class="empty">暂无事件</div>';
    return;
  }
  list.innerHTML = events
    .slice(-200)
    .map((e) => {
      const title = e.post && e.post.title ? e.post.title : "";
      const p = e.postId ? `#${e.postId}` : "";
      const meta = `${fmtTime(e.createdAt)} · ${escapeHtml(String(e.type || ""))}`;
      const who = e.actor ? `@${e.actor}` : "";
      const ctx = `${p} ${title}`.trim();
      const payload = e.payload ? escapeHtml(JSON.stringify(e.payload)) : "";
      return `
        <div class="row">
          <div class="row__main">
            <div class="row__title">${escapeHtml(ctx || "event")}</div>
            <div class="row__sub">${meta}${who ? " · " + escapeHtml(who) : ""}</div>
            ${payload ? `<div class="row__sub monoSmall">${payload}</div>` : ""}
          </div>
        </div>
      `;
    })
    .join("");
}

async function loadComments() {
  const data = await api(`/api/posts/${state.openPostId}/comments`, { method: "GET" });
  const list = data.comments || [];
  const html = list
    .map((c) => {
      const header = `<div class="cHead"><span class="cName">${escapeHtml(c.author)}</span><span class="cTime">${fmtTime(c.createdAt)}</span></div>`;
      const body = `<div class="md">${c.bodyHtml}</div>`;
      const tools = c.canEdit
        ? `<div class="cTools"><button class="btn btn--tiny btn--ghost" data-edit-comment="${c.id}">编辑</button><button class="btn btn--tiny btn--danger" data-del-comment="${c.id}">删除</button></div>`
        : "";
      return `<div class="commentBox">${header}${body}${tools}</div>`;
    })
    .join("");
  el("comments").innerHTML = html || '<div class="empty">还没有评论</div>';
}

async function main() {
  await refreshMe();
  await loadTags();
  await loadPosts();

  const kindSel = el("newKind");
  const newStatus = el("newStatus");
  const newAssignee = el("newAssignee");
  if (kindSel) {
    kindSel.addEventListener("change", () => {
      const isTask = kindSel.value === "task";
      showInline(newStatus, isTask);
      showInline(newAssignee, isTask);
    });
  }

  document.addEventListener("click", async (e) => {
    const t = e.target;

    const open = t.closest && t.closest("[data-open='post']");
    if (open) {
      const id = Number(open.getAttribute("data-id"));
      if (Number.isFinite(id)) openPost(id);
      return;
    }

    const closeModalBtn = t.closest && t.closest("[data-close='modal']");
    if (closeModalBtn) {
      setModal("modal", false);
      return;
    }
    const closeAuthBtn = t.closest && t.closest("[data-close='auth']");
    if (closeAuthBtn) {
      setModal("authModal", false);
      return;
    }
    const closeNewBtn = t.closest && t.closest("[data-close='new']");
    if (closeNewBtn) {
      setModal("newModal", false);
      return;
    }

    if (t === el("authBtn")) {
      el("authMsg").textContent = "";
      const loggedIn = !!state.me;
      show(el("authPanel"), !loggedIn);
      show(el("accountPanel"), loggedIn);
      if (loggedIn) {
        el("accountMe").textContent = `@${state.me.username}${state.me.isAdmin ? " · 管理员" : ""}`;
        setAcctPane("tokens");
        try {
          await refreshTokens();
          await refreshConvos();
        } catch (_e) {
          // ignore
        }
      }
      setModal("authModal", true);
      return;
    }

    if (t === el("newPostBtn")) {
      el("newMsg").textContent = "";
      el("newImageMsg").textContent = "";
      if (kindSel) {
        kindSel.value = "post";
        showInline(newStatus, false);
        showInline(newAssignee, false);
      }
      setModal("newModal", true);
      return;
    }

    if (t === el("loginDo")) {
      try {
        await api("/api/auth/login", {
          method: "POST",
          body: JSON.stringify({ username: el("authUser").value, password: el("authPass").value }),
        });
        el("authMsg").textContent = "登录成功";
        await refreshMe();
        await loadPosts();
        toast("已开启通知", "将提示新任务/新评论/任务领取", { ttlMs: 4500 });
      } catch (err) {
        el("authMsg").textContent = `登录失败：${err.message}`;
      }
      return;
    }

    if (t === el("registerDo")) {
      try {
        await api("/api/auth/register", {
          method: "POST",
          body: JSON.stringify({ username: el("authUser").value, password: el("authPass").value }),
        });
        el("authMsg").textContent = "注册成功";
        await refreshMe();
        await loadPosts();
        toast("已开启通知", "将提示新任务/新评论/任务领取", { ttlMs: 4500 });
      } catch (err) {
        el("authMsg").textContent = `注册失败：${err.message}`;
      }
      return;
    }

    if (t === el("logoutDo")) {
      try {
        await api("/api/auth/logout", { method: "POST" });
        el("authMsg").textContent = "已退出";
        await refreshMe();
        await loadPosts();
        toast("已关闭通知", "你已退出登录", { ttlMs: 4000 });
      } catch (err) {
        el("authMsg").textContent = `退出失败：${err.message}`;
      }
      return;
    }

    if (t === el("newSend")) {
      try {
        const kind = safeTrim(el("newKind").value) || "post";
        const isTask = kind === "task";
        const payload = {
          title: el("newTitle").value,
          tags: el("newTags").value,
          body: el("newBody").value,
          kind,
        };
        if (isTask) {
          payload.status = safeTrim(el("newStatus").value) || "open";
          const asg = safeTrim(el("newAssignee").value);
          if (asg) payload.assignee = asg;
        }
        if (safeTrim(payload.title).length < 3) throw new Error("标题至少 3 个字符");
        if (safeTrim(payload.body).length < 1) throw new Error("正文不能为空");
        if (payload.assignee && !isValidUsername(payload.assignee)) {
          throw new Error("指派用户名不合法（仅字母/数字/下划线，2-24 位）");
        }

        const data = await api("/api/posts", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        el("newMsg").textContent = "发布成功";
        setModal("newModal", false);
        el("newTitle").value = "";
        el("newTags").value = "";
        el("newBody").value = "";
        await loadTags();
        await loadPosts();
        if (data.id) openPost(data.id);
      } catch (err) {
        el("newMsg").textContent = `发布失败：${err.message}`;
      }
      return;
    }

    if (t === el("newImageUpload")) {
      try {
        const inp = el("newImageFile");
        const file = inp && inp.files && inp.files[0];
        if (!file) throw new Error("请选择图片文件");
        const fd = new FormData();
        fd.append("file", file);
        const data = await apiForm("/api/uploads", { method: "POST", body: fd });
        const url = data && data.upload && data.upload.url;
        if (!url) throw new Error("upload_failed");
        const md = `\n\n![img](${url})\n`;
        const ta = el("newBody");
        ta.value = String(ta.value || "") + md;
        el("newImageMsg").textContent = "已上传并插入 Markdown";
        inp.value = "";
      } catch (err) {
        el("newImageMsg").textContent = `上传失败：${err.message}`;
      }
      return;
    }

    if (t === el("likeBtn")) {
      try {
        const data = await api(`/api/posts/${state.openPostId}/like`, { method: "POST" });
        el("likeBtn").textContent = data.liked ? "已赞" : "点赞";
        await openPost(state.openPostId);
        await loadPosts();
      } catch (err) {
        el("hint").textContent = `点赞失败：${err.message}`;
      }
      return;
    }

    if (t === el("claimBtn")) {
      try {
        const data = await api(`/api/tasks/${state.openPostId}/claim`, { method: "POST" });
        el("hint").textContent = `领取成功：@${data.task.assignee}`;
        await openPost(state.openPostId);
        await loadPosts();
      } catch (err) {
        el("hint").textContent = `领取失败：${err.message}`;
      }
      return;
    }

    if (t === el("editBtn")) {
      const p = state.openPost;
      if (!p) return;
      el("editor").hidden = false;
      el("editTitle").value = p.title;
      el("editTags").value = (p.tags || []).join(" ");
      el("editBody").value = p.body;

      const isTask = p.kind === "task";
      showInline(el("editTaskRow"), isTask);
      if (isTask) {
        el("editStatus").value = p.status || "open";
        el("editAssignee").value = p.assignee || "";
      }
      return;
    }

    if (t === el("editCancel")) {
      el("editor").hidden = true;
      return;
    }

    if (t === el("editSave")) {
      try {
        const payload = {
          title: el("editTitle").value,
          tags: el("editTags").value,
          body: el("editBody").value,
        };
        if (state.openPost && state.openPost.kind === "task") {
          payload.status = safeTrim(el("editStatus").value);
          payload.assignee = safeTrim(el("editAssignee").value);
        }
        if (safeTrim(payload.title).length < 3) throw new Error("标题至少 3 个字符");
        if (safeTrim(payload.body).length < 1) throw new Error("正文不能为空");
        if (payload.assignee && !isValidUsername(payload.assignee)) {
          throw new Error("指派用户名不合法（仅字母/数字/下划线，2-24 位）");
        }

        await api(`/api/posts/${state.openPostId}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        });
        el("editor").hidden = true;
        await loadTags();
        await openPost(state.openPostId);
        await loadPosts();
      } catch (err) {
        el("hint").textContent = `保存失败：${err.message}`;
      }
      return;
    }

    if (t === el("deleteBtn")) {
      if (!confirm("确定删除该帖子？")) return;
      try {
        await api(`/api/posts/${state.openPostId}`, { method: "DELETE" });
        setModal("modal", false);
        await loadTags();
        await loadPosts();
      } catch (err) {
        el("hint").textContent = `删除失败：${err.message}`;
      }
      return;
    }

    if (t === el("commentSend")) {
      try {
        await api(`/api/posts/${state.openPostId}/comments`, {
          method: "POST",
          body: JSON.stringify({ body: el("commentBody").value }),
        });
        el("commentBody").value = "";
        await loadComments();
        await loadPosts();
      } catch (err) {
        el("hint").textContent = `评论失败：${err.message}`;
      }
      return;
    }

    const delComment = t.getAttribute && t.getAttribute("data-del-comment");
    if (delComment) {
      if (!confirm("确定删除该评论？")) return;
      try {
        await api(`/api/comments/${delComment}`, { method: "DELETE" });
        await loadComments();
      } catch (err) {
        el("hint").textContent = `删除评论失败：${err.message}`;
      }
      return;
    }

    const editComment = t.getAttribute && t.getAttribute("data-edit-comment");
    if (editComment) {
      const body = prompt("编辑评论（Markdown）");
      if (!body) return;
      try {
        await api(`/api/comments/${editComment}`, {
          method: "PATCH",
          body: JSON.stringify({ body }),
        });
        await loadComments();
      } catch (err) {
        el("hint").textContent = `编辑评论失败：${err.message}`;
      }
      return;
    }

    const tokenRevoke = t.getAttribute && t.getAttribute("data-token-revoke");
    if (tokenRevoke) {
      try {
        await api(`/api/tokens/${tokenRevoke}/revoke`, { method: "POST" });
        el("tokenMsg").textContent = "已撤销";
        await refreshTokens();
      } catch (err) {
        el("tokenMsg").textContent = `撤销失败：${err.message}`;
      }
      return;
    }

    const openConvoBtn = t.closest && t.closest("[data-open-convo]");
    if (openConvoBtn) {
      const id = Number(openConvoBtn.getAttribute("data-open-convo"));
      if (Number.isFinite(id)) {
        try {
          await openConvo(id);
        } catch (err) {
          el("chatMsg").textContent = `打开失败：${err.message}`;
        }
      }
      return;
    }

    const acctTab = t.closest && t.closest("[data-acct]");
    if (acctTab) {
      const name = acctTab.getAttribute("data-acct");
      if (name === "admin" && !(state.me && state.me.isAdmin)) return;
      setAcctPane(name);
      if (name === "tokens") {
        try {
          await refreshTokens();
        } catch (_e) {
          // ignore
        }
      }
      if (name === "chat") {
        try {
          await refreshConvos();
        } catch (_e) {
          // ignore
        }
      }
      return;
    }

    if (t === el("tokenRefresh")) {
      try {
        await refreshTokens();
        el("tokenMsg").textContent = "已刷新";
      } catch (err) {
        el("tokenMsg").textContent = `刷新失败：${err.message}`;
      }
      return;
    }

    if (t === el("tokenCreate")) {
      try {
        const name = safeTrim(el("tokenName").value) || "token";
        const ttlDays = parseNum(el("tokenTtl").value, 0);
        const body = { name, ttlDays };
        if (state.me && state.me.isAdmin) {
          const forU = safeTrim(el("tokenForUsername").value);
          if (forU) body.forUsername = forU;
        }
        const data = await api("/api/tokens", { method: "POST", body: JSON.stringify(body) });
        el("tokenMsg").textContent = "创建成功（原文只显示一次，请立即保存）";
        const raw = el("tokenRaw");
        if (raw) {
          raw.style.display = "block";
          raw.textContent = `Authorization: Bearer ${data.token}`;
        }
        await refreshTokens();
      } catch (err) {
        el("tokenMsg").textContent = `创建失败：${err.message}`;
      }
      return;
    }

    if (t === el("dmCreate")) {
      try {
        const u = safeTrim(el("dmUser").value);
        if (!u || !isValidUsername(u)) throw new Error("用户名不合法");
        const data = await api("/api/conversations/dm", {
          method: "POST",
          body: JSON.stringify({ username: u }),
        });
        el("chatMsg").textContent = "已创建/打开";
        el("dmUser").value = "";
        setAcctPane("chat");
        await refreshConvos();
        if (data && data.conversation && data.conversation.id) {
          await openConvo(data.conversation.id);
        }
      } catch (err) {
        el("chatMsg").textContent = `失败：${err.message}`;
      }
      return;
    }

    if (t === el("convoSend")) {
      try {
        if (!state.openConvoId) throw new Error("未选择对话");
        const body = safeTrim(el("convoBody").value);
        if (!body) throw new Error("内容不能为空");
        await api(`/api/conversations/${state.openConvoId}/messages`, {
          method: "POST",
          body: JSON.stringify({ body }),
        });
        el("convoBody").value = "";
        await openConvo(state.openConvoId);
      } catch (err) {
        el("chatMsg").textContent = `发送失败：${err.message}`;
      }
      return;
    }

    if (t === el("eventsFetch")) {
      try {
        const since = parseNum(el("eventsSince").value, 0);
        const data = await api(`/api/events?since=${encodeURIComponent(String(since))}&limit=200&waitMs=0`, {
          method: "GET",
        });
        renderEvents(data.events || []);
        el("eventsNextSince").textContent = String(data.nextSince || since);
        el("eventsMsg").textContent = "OK";
      } catch (err) {
        el("eventsMsg").textContent = `失败：${err.message}`;
      }
      return;
    }

    if (t === el("adminAgentSet")) {
      try {
        if (!(state.me && state.me.isAdmin)) throw new Error("forbidden");
        const u = safeTrim(el("adminAgentUser").value);
        if (!u || !isValidUsername(u)) throw new Error("用户名不合法");
        const isAgent = !!el("adminAgentIsAgent").checked;
        await api("/api/admin/users/agent", {
          method: "POST",
          body: JSON.stringify({ username: u, isAgent }),
        });
        el("adminMsg").textContent = "已更新";
      } catch (err) {
        el("adminMsg").textContent = `失败：${err.message}`;
      }
      return;
    }

    if (t === el("accountLogout")) {
      try {
        await api("/api/auth/logout", { method: "POST" });
        setModal("authModal", false);
        await refreshMe();
        await loadPosts();
        toast("已关闭通知", "你已退出登录", { ttlMs: 4000 });
      } catch (err) {
        el("tokenMsg").textContent = `退出失败：${err.message}`;
      }
      return;
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      setModal("modal", false);
      setModal("authModal", false);
      setModal("newModal", false);
    }
  });

  el("q").addEventListener("keydown", async (e) => {
    if (e.key !== "Enter") return;
    state.q = el("q").value.trim();
    state.page = 1;
    await loadPosts();
  });

  el("q").addEventListener("input", async () => {
    // Light debounce for live search.
    if (state._qTimer) clearTimeout(state._qTimer);
    state._qTimer = setTimeout(async () => {
      const v = el("q").value.trim();
      if (v === state.q) return;
      state.q = v;
      state.page = 1;
      await loadPosts();
    }, 260);
  });

  const clearBtn = el("clearQ");
  if (clearBtn) {
    clearBtn.addEventListener("click", async () => {
      el("q").value = "";
      state.q = "";
      state.page = 1;
      await loadPosts();
    });
  }

  el("tagSelect").addEventListener("change", async (e) => {
    state.tag = e.target.value;
    state.page = 1;
    await loadPosts();
  });

  const prev = el("prevPage");
  const next = el("nextPage");
  if (prev) {
    prev.addEventListener("click", async () => {
      if (state.page <= 1) return;
      state.page -= 1;
      await loadPosts();
    });
  }
  if (next) {
    next.addEventListener("click", async () => {
      state.page += 1;
      await loadPosts();
    });
  }

  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", async () => {
      document.querySelectorAll(".tab").forEach((b) => b.classList.remove("tab--active"));
      btn.classList.add("tab--active");
      const sort = btn.getAttribute("data-sort");
      if (sort) {
        state.sort = sort;
        state.kind = "";
        state.status = "";
        await loadPosts();
      }
      const kind = btn.getAttribute("data-kind");
      if (kind) {
        state.sort = "new";
        state.kind = kind;
        state.status = btn.getAttribute("data-status") || "";
        await loadPosts();
      }
      const view = btn.getAttribute("data-view");
      if (view === "tags") {
        el("hint").textContent = "点击右下角下拉选择标签筛选";
      }
    });
  });
}

main().catch((e) => {
  el("hint").textContent = `启动失败：${e.message}`;
});
