const path = require("path");
const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");
const fs = require("fs");
const express = require("express");
const cookieParser = require("cookie-parser");
const multer = require("multer");
const bcrypt = require("bcryptjs");
const { marked } = require("marked");
const sanitizeHtml = require("sanitize-html");

const { openDb } = require("./src/db");
const {
  requireAuth,
  getSessionUser,
  setSessionCookie,
  clearSessionCookie,
} = require("./src/auth");
const {
  clamp,
  isValidUsername,
  normalizeTag,
  normalizeStatus,
  normalizeKind,
  parseBool,
  splitTags,
  safeText,
} = require("./src/validate");

function emitPostEvent(db, { postId, actorUserId, type, payload }) {
  const createdAt = Date.now();
  db.run(
    "INSERT INTO post_events (post_id, actor_user_id, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)",
    [postId, actorUserId || null, String(type), payload ? JSON.stringify(payload) : null, createdAt],
  );
}

function requireTaskPost(db, res, postId) {
  const row = db.get(
    "SELECT id, kind, status, assignee_user_id FROM posts WHERE id = ? AND deleted_at IS NULL",
    [postId],
  );
  if (!row) {
    res.status(404).json({ error: "not_found" });
    return null;
  }
  if (row.kind !== "task") {
    res.status(400).json({ error: "invalid_input" });
    return null;
  }
  return row;
}

function requirePostOwnerOrAdmin(db, req, res, postId) {
  const row = db.get(
    "SELECT id, user_id FROM posts WHERE id = ? AND deleted_at IS NULL",
    [postId],
  );
  if (!row) {
    res.status(404).json({ error: "not_found" });
    return null;
  }
  if (row.user_id !== req.user.id && !req.user.is_admin) {
    res.status(403).json({ error: "forbidden" });
    return null;
  }
  return row;
}

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || "3000");

function markdownToSafeHtml(md) {
  const raw = marked.parse(md || "", { mangle: false, headerIds: false });
  return sanitizeHtml(raw, {
    allowedTags: [
      "p",
      "br",
      "pre",
      "code",
      "blockquote",
      "strong",
      "em",
      "ul",
      "ol",
      "li",
      "hr",
      "a",
      "h1",
      "h2",
      "h3",
      "h4",
      "img",
    ],
    allowedAttributes: {
      a: ["href", "name", "target", "rel"],
      code: ["class"],
      img: ["src", "alt", "title", "width", "height", "loading"],
    },
    allowedSchemes: ["http", "https", "mailto", "data"],
    transformTags: {
      a: sanitizeHtml.simpleTransform("a", {
        target: "_blank",
        rel: "noopener noreferrer",
      }),
      img: (tagName, attribs) => {
        const src = String(attribs.src || "");
        const okRelative = src.startsWith("/uploads/");
        const okData = src.startsWith("data:image/");
        if (!okRelative && !okData) {
          return { tagName: "span", text: "" };
        }
        return {
          tagName,
          attribs: {
            src,
            alt: String(attribs.alt || ""),
            title: String(attribs.title || ""),
            loading: "lazy",
          },
        };
      },
    },
  });
}

function generateApiToken() {
  return `tk_${uuidv4().replaceAll("-", "")}${crypto.randomBytes(12).toString("hex")}`;
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "unauthorized" });
  if (!req.user.is_admin) return res.status(403).json({ error: "forbidden" });
  next();
}

async function main() {
  const db = await openDb({
    dbFile: path.join(__dirname, "data", "forum.sqlite"),
  });

  const uploadsDir = path.join(__dirname, "uploads");
  fs.mkdirSync(uploadsDir, { recursive: true });

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb" }));
  app.use(cookieParser());

  app.use((req, res, next) => {
    // Basic security headers; keep Termux-friendly.
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        "img-src 'self' data:",
        "style-src 'self' https://fonts.googleapis.com 'unsafe-inline'",
        "font-src https://fonts.gstatic.com",
        "script-src 'self'",
      ].join("; "),
    );
    next();
  });

  app.use(async (req, _res, next) => {
    try {
      req.user = await getSessionUser(db, req);
    } catch (_e) {
      req.user = null;
    }
    next();
  });

  app.use("/", express.static(path.join(__dirname, "public")));
  app.use("/uploads", express.static(path.join(__dirname, "uploads")));

  const upload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, uploadsDir),
      filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname || "").slice(0, 10).toLowerCase();
        const name = `u_${Date.now()}_${crypto.randomBytes(8).toString("hex")}${ext}`;
        cb(null, name);
      },
    }),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      const ok = /^image\/(png|jpe?g|webp|gif)$/.test(String(file.mimetype || ""));
      if (!ok) return cb(new Error("unsupported_file"));
      cb(null, true);
    },
  });

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  // Upload an image and get a URL that can be embedded in Markdown.
  // Example Markdown: ![alt](/uploads/<storage_name>)
  app.post("/api/uploads", requireAuth, upload.single("file"), async (req, res) => {
    const file = req.file;
    if (!file) return res.status(400).json({ error: "invalid_input" });

    const kind = "image";
    const now = Date.now();
    const id = db.insert(
      "INSERT INTO uploads (user_id, kind, original_name, storage_name, mime_type, size, created_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)",
      [
        req.user.id,
        kind,
        file.originalname || "file",
        file.filename,
        file.mimetype || "application/octet-stream",
        file.size || 0,
        now,
      ],
    );
    await db.flush();
    res.json({
      ok: true,
      upload: {
        id,
        url: `/uploads/${file.filename}`,
        mimeType: file.mimetype,
        size: file.size,
        createdAt: now,
      },
    });
  });

  // Event stream for agents/tools.
  // Supports long-poll via waitMs.
  app.get("/api/events", requireAuth, async (req, res) => {
    const since = Number(req.query?.since || 0);
    const limit = clamp(Number(req.query?.limit || 100), 1, 500);
    const waitMs = clamp(Number(req.query?.waitMs || 0), 0, 25000);

    if (!Number.isFinite(since) || since < 0) {
      return res.status(400).json({ error: "invalid_input" });
    }

    const fetchEvents = () => {
      const rows = db.all(
        `
        SELECT
          e.id,
          e.post_id,
          e.actor_user_id,
          au.username AS actor,
          e.type,
          e.payload_json,
          e.created_at,
          p.kind AS post_kind,
          p.status AS post_status,
          p.title AS post_title
        FROM post_events e
        JOIN posts p ON p.id = e.post_id
        LEFT JOIN users au ON au.id = e.actor_user_id
        WHERE e.created_at > ?
        ORDER BY e.created_at ASC
        LIMIT ?
        `,
        [since, limit],
      );
      const events = rows.map((r) => ({
        id: r.id,
        postId: r.post_id,
        post: {
          kind: r.post_kind,
          status: r.post_status,
          title: r.post_title,
        },
        actorUserId: r.actor_user_id,
        actor: r.actor || null,
        type: r.type,
        payload: r.payload_json ? JSON.parse(r.payload_json) : null,
        createdAt: r.created_at,
      }));
      return events;
    };

    let events = fetchEvents();
    if (events.length > 0 || waitMs === 0) {
      const nextSince = events.length ? events[events.length - 1].createdAt : since;
      return res.json({ events, nextSince });
    }

    const start = Date.now();
    const poll = () => {
      events = fetchEvents();
      if (events.length > 0) {
        const nextSince = events[events.length - 1].createdAt;
        return res.json({ events, nextSince });
      }
      if (Date.now() - start >= waitMs) {
        return res.json({ events: [], nextSince: since });
      }
      setTimeout(poll, 500);
    };
    poll();
  });

  app.get("/api/me", (req, res) => {
    if (!req.user) return res.json({ user: null });
    res.json({
      user: {
        id: req.user.id,
        username: req.user.username,
        isAdmin: !!req.user.is_admin,
        isAgent: !!req.user.is_agent,
        createdAt: req.user.created_at,
      },
    });
  });

  // Admin: toggle is_agent flag for a username.
  app.post("/api/admin/users/agent", requireAuth, requireAdmin, async (req, res) => {
    const username = safeText(req.body?.username, 2, 24);
    const isAgent = req.body?.isAgent ? 1 : 0;
    if (!username || !isValidUsername(username)) {
      return res.status(400).json({ error: "invalid_input" });
    }
    const u = db.get("SELECT id FROM users WHERE username = ?", [
      username.toLowerCase(),
    ]);
    if (!u) return res.status(404).json({ error: "not_found" });
    db.run("UPDATE users SET is_agent = ? WHERE id = ?", [isAgent, u.id]);
    await db.flush();
    res.json({ ok: true });
  });

  app.post("/api/tokens", requireAuth, async (req, res) => {
    // Create a personal API token for agent/bot usage.
    // Admin can also mint for a specific user.
    const name = safeText(req.body?.name, 1, 64) || "token";
    const ttlDays = clamp(Number(req.body?.ttlDays || 0), 0, 3650);
    const forUsername = safeText(req.body?.forUsername, 0, 24);

    let userId = req.user.id;
    if (forUsername) {
      if (!req.user.is_admin) return res.status(403).json({ error: "forbidden" });
      if (!isValidUsername(forUsername)) {
        return res.status(400).json({ error: "invalid_input" });
      }
      const target = db.get("SELECT id FROM users WHERE username = ?", [
        forUsername.toLowerCase(),
      ]);
      if (!target) return res.status(404).json({ error: "not_found" });
      userId = target.id;
    }

    const raw = generateApiToken();
    const tokenHash = hashToken(raw);
    const now = Date.now();
    const expiresAt = ttlDays ? now + ttlDays * 24 * 60 * 60 * 1000 : null;

    db.run(
      "INSERT INTO api_tokens (user_id, name, token_hash, created_at, last_used_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, NULL, ?, NULL)",
      [userId, name, tokenHash, now, expiresAt],
    );

    await db.flush();
    res.json({ ok: true, token: raw, name, userId, expiresAt });
  });

  app.get("/api/tokens", requireAuth, (req, res) => {
    const rows = db.all(
      "SELECT id, name, created_at, last_used_at, expires_at, revoked_at FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC",
      [req.user.id],
    );
    res.json({
      tokens: rows.map((r) => ({
        id: r.id,
        name: r.name,
        createdAt: r.created_at,
        lastUsedAt: r.last_used_at,
        expiresAt: r.expires_at,
        revokedAt: r.revoked_at,
      })),
    });
  });

  app.post("/api/tokens/:id/revoke", requireAuth, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "invalid_id" });
    const tok = db.get("SELECT id, user_id FROM api_tokens WHERE id = ?", [id]);
    if (!tok) return res.status(404).json({ error: "not_found" });
    if (tok.user_id !== req.user.id && !req.user.is_admin) {
      return res.status(403).json({ error: "forbidden" });
    }
    db.run("UPDATE api_tokens SET revoked_at = ? WHERE id = ?", [Date.now(), id]);
    await db.flush();
    res.json({ ok: true });
  });

  app.post("/api/auth/register", async (req, res) => {
    const username = safeText(req.body?.username, 2, 24);
    const password = safeText(req.body?.password, 8, 200);
    if (!username || !password || !isValidUsername(username)) {
      return res.status(400).json({ error: "invalid_input" });
    }

    const existing = db.get(
      "SELECT id FROM users WHERE username = ?",
      [username.toLowerCase()],
    );
    if (existing) return res.status(409).json({ error: "username_taken" });

    const isFirstUser = !db.get("SELECT id FROM users LIMIT 1", []);
    const passwordHash = await bcrypt.hash(password, 10);
    const now = Date.now();
    const userId = db.insert(
      "INSERT INTO users (username, password_hash, created_at, is_admin) VALUES (?, ?, ?, ?)",
      [username.toLowerCase(), passwordHash, now, isFirstUser ? 1 : 0],
    );

    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = now + 1000 * 60 * 60 * 24 * 14;
    db.run(
      "INSERT INTO sessions (token, user_id, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?)",
      [token, userId, now, now, expiresAt],
    );
    await db.flush();
    setSessionCookie(res, token);

    res.json({ ok: true });
  });

  app.post("/api/auth/login", async (req, res) => {
    const username = safeText(req.body?.username, 2, 24);
    const password = safeText(req.body?.password, 1, 200);
    if (!username || !password) {
      return res.status(400).json({ error: "invalid_input" });
    }

    const user = db.get(
      "SELECT id, username, password_hash FROM users WHERE username = ?",
      [username.toLowerCase()],
    );
    if (!user) return res.status(401).json({ error: "bad_credentials" });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: "bad_credentials" });

    const now = Date.now();
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = now + 1000 * 60 * 60 * 24 * 14;
    db.run(
      "INSERT INTO sessions (token, user_id, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?)",
      [token, user.id, now, now, expiresAt],
    );
    await db.flush();
    setSessionCookie(res, token);

    res.json({ ok: true });
  });

  app.post("/api/auth/logout", async (req, res) => {
    const token = req.cookies?.session || null;
    if (token) {
      db.run("DELETE FROM sessions WHERE token = ?", [token]);
      await db.flush();
    }
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  app.get("/api/tags/trending", (req, res) => {
    const rows = db.all(
      "SELECT tag, COUNT(*) AS cnt FROM post_tags GROUP BY tag ORDER BY cnt DESC, tag ASC LIMIT 20",
      [],
    );
    res.json({ tags: rows.map((r) => ({ tag: r.tag, count: r.cnt })) });
  });

  app.get("/api/posts", (req, res) => {
    const page = clamp(Number(req.query?.page || 1), 1, 9999);
    const limit = clamp(Number(req.query?.limit || 20), 1, 50);
    const sort = String(req.query?.sort || "new");
    const tag = normalizeTag(String(req.query?.tag || ""));
    const kind = normalizeKind(String(req.query?.kind || ""));
    const status = normalizeStatus(String(req.query?.status || ""));
    const assignee = safeText(req.query?.assignee, 0, 24) || "";
    const q = safeText(req.query?.q, 0, 80) || "";

    const offset = (page - 1) * limit;
    const params = [];
    let where = "p.deleted_at IS NULL";
    if (kind) {
      where += " AND p.kind = ?";
      params.push(kind);
    }
    if (status) {
      where += " AND p.status = ?";
      params.push(status);
    }
    if (assignee) {
      if (assignee === "me" && req.user) {
        where += " AND p.assignee_user_id = ?";
        params.push(req.user.id);
      } else if (isValidUsername(assignee)) {
        where += " AND EXISTS (SELECT 1 FROM users au WHERE au.id = p.assignee_user_id AND au.username = ?)";
        params.push(assignee.toLowerCase());
      }
    }
    if (tag) {
      where += " AND EXISTS (SELECT 1 FROM post_tags pt WHERE pt.post_id = p.id AND pt.tag = ?)";
      params.push(tag);
    }
    if (q) {
      where += " AND (p.title LIKE ? OR p.body_md LIKE ?)";
      params.push(`%${q}%`, `%${q}%`);
    }

    const orderBy =
      sort === "hot"
        ? "like_count DESC, p.created_at DESC"
        : "p.created_at DESC";

    const rows = db.all(
      `
      SELECT
        p.id,
        p.kind,
        p.status,
        p.assignee_user_id,
        p.title,
        p.body_md,
        p.created_at,
        p.updated_at,
        u.username AS author,
        (SELECT username FROM users au WHERE au.id = p.assignee_user_id) AS assignee,
        (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id AND c.deleted_at IS NULL) AS comment_count,
        (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS like_count,
        (SELECT GROUP_CONCAT(tag, ',') FROM post_tags pt WHERE pt.post_id = p.id) AS tags
      FROM posts p
      JOIN users u ON u.id = p.user_id
      WHERE ${where}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
      `,
      [...params, limit, offset],
    );

    const posts = rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      status: r.status,
      assignee: r.assignee || null,
      title: r.title,
      excerpt:
        (r.body_md || "").trim().slice(0, 200) +
        ((r.body_md || "").trim().length > 200 ? "…" : ""),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      author: r.author,
      commentCount: r.comment_count,
      likeCount: r.like_count,
      tags: (r.tags ? String(r.tags).split(",") : []).filter(Boolean),
      likedByMe: req.user
        ? !!db.get(
            "SELECT 1 FROM likes WHERE user_id = ? AND post_id = ?",
            [req.user.id, r.id],
          )
        : false,
    }));

    res.json({ posts, page, limit });
  });

  app.post("/api/posts", requireAuth, async (req, res) => {
    const kind = normalizeKind(req.body?.kind) || "post";
    const status = normalizeStatus(req.body?.status) || "open";
    const title = safeText(req.body?.title, 3, 120);
    const body = safeText(req.body?.body, 1, 20000);
    const tags = splitTags(req.body?.tags);
    const assigneeUsername = safeText(req.body?.assignee, 0, 24);
    if (!title || !body) return res.status(400).json({ error: "invalid_input" });

    let assigneeUserId = null;
    if (assigneeUsername) {
      if (!isValidUsername(assigneeUsername)) {
        return res.status(400).json({ error: "invalid_input" });
      }
      const au = db.get("SELECT id FROM users WHERE username = ?", [
        assigneeUsername.toLowerCase(),
      ]);
      if (!au) return res.status(404).json({ error: "not_found" });
      assigneeUserId = au.id;
    }

    const now = Date.now();
    const bodyHtml = markdownToSafeHtml(body);
    const postId = db.insert(
      "INSERT INTO posts (user_id, kind, status, assignee_user_id, title, body_md, body_html, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)",
      [req.user.id, kind, status, assigneeUserId, title, body, bodyHtml, now, now],
    );
    for (const t of tags) {
      db.run("INSERT INTO post_tags (post_id, tag) VALUES (?, ?)", [postId, t]);
    }

    emitPostEvent(db, {
      postId,
      actorUserId: req.user.id,
      type: "post.created",
      payload: {
        kind,
        status,
        assignee: assigneeUsername || null,
        tags,
      },
    });
    await db.flush();
    res.json({ ok: true, id: postId });
  });

  app.get("/api/posts/:id", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "invalid_id" });

    const row = db.get(
      `
      SELECT
        p.id,
        p.user_id,
        p.kind,
        p.status,
        p.assignee_user_id,
        p.title,
        p.body_md,
        p.body_html,
        p.created_at,
        p.updated_at,
        u.username AS author,
        (SELECT username FROM users au WHERE au.id = p.assignee_user_id) AS assignee,
        (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS like_count,
        (SELECT GROUP_CONCAT(tag, ',') FROM post_tags pt WHERE pt.post_id = p.id) AS tags
      FROM posts p
      JOIN users u ON u.id = p.user_id
      WHERE p.id = ? AND p.deleted_at IS NULL
      `,
      [id],
    );
    if (!row) return res.status(404).json({ error: "not_found" });

    const tags = (row.tags ? String(row.tags).split(",") : []).filter(Boolean);
    const likedByMe =
      req.user &&
      !!db.get("SELECT 1 FROM likes WHERE user_id = ? AND post_id = ?", [
        req.user.id,
        id,
      ]);

    res.json({
      post: {
        id: row.id,
        userId: row.user_id,
        kind: row.kind,
        status: row.status,
        assignee: row.assignee || null,
        title: row.title,
        body: row.body_md,
        bodyHtml: row.body_html,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        author: row.author,
        likeCount: row.like_count,
        tags,
        likedByMe,
        canEdit: req.user ? req.user.id === row.user_id || !!req.user.is_admin : false,
      },
    });
  });

  app.patch("/api/posts/:id", requireAuth, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "invalid_id" });

    if (!requirePostOwnerOrAdmin(db, req, res, id)) return;

    const title = safeText(req.body?.title, 3, 120);
    const body = safeText(req.body?.body, 1, 20000);
    const tags = splitTags(req.body?.tags);
    const status = normalizeStatus(req.body?.status);
    const assigneeUsername = safeText(req.body?.assignee, 0, 24);
    if (!title || !body) return res.status(400).json({ error: "invalid_input" });

    const prev = db.get(
      "SELECT status, assignee_user_id, (SELECT username FROM users au WHERE au.id = posts.assignee_user_id) AS assignee FROM posts WHERE id = ?",
      [id],
    );

    let assigneeUserId = undefined;
    if (assigneeUsername === "") {
      assigneeUserId = null;
    } else if (assigneeUsername) {
      if (!isValidUsername(assigneeUsername)) {
        return res.status(400).json({ error: "invalid_input" });
      }
      const au = db.get("SELECT id FROM users WHERE username = ?", [
        assigneeUsername.toLowerCase(),
      ]);
      if (!au) return res.status(404).json({ error: "not_found" });
      assigneeUserId = au.id;
    }

    const now = Date.now();
    const bodyHtml = markdownToSafeHtml(body);
    if (status && assigneeUserId !== undefined) {
      db.run(
        "UPDATE posts SET title = ?, body_md = ?, body_html = ?, updated_at = ?, status = ?, assignee_user_id = ? WHERE id = ?",
        [title, body, bodyHtml, now, status, assigneeUserId, id],
      );
    } else if (status) {
      db.run(
        "UPDATE posts SET title = ?, body_md = ?, body_html = ?, updated_at = ?, status = ? WHERE id = ?",
        [title, body, bodyHtml, now, status, id],
      );
    } else if (assigneeUserId !== undefined) {
      db.run(
        "UPDATE posts SET title = ?, body_md = ?, body_html = ?, updated_at = ?, assignee_user_id = ? WHERE id = ?",
        [title, body, bodyHtml, now, assigneeUserId, id],
      );
    } else {
      db.run(
        "UPDATE posts SET title = ?, body_md = ?, body_html = ?, updated_at = ? WHERE id = ?",
        [title, body, bodyHtml, now, id],
      );
    }
    db.run("DELETE FROM post_tags WHERE post_id = ?", [id]);
    for (const t of tags) {
      db.run("INSERT INTO post_tags (post_id, tag) VALUES (?, ?)", [id, t]);
    }

    emitPostEvent(db, {
      postId: id,
      actorUserId: req.user.id,
      type: "post.updated",
      payload: {
        prev: {
          status: prev?.status || null,
          assignee: prev?.assignee || null,
        },
        next: {
          status: status || prev?.status || null,
          assignee: assigneeUsername === "" ? null : assigneeUsername || prev?.assignee || null,
        },
        tags,
      },
    });
    await db.flush();
    res.json({ ok: true });
  });

  app.delete("/api/posts/:id", requireAuth, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "invalid_id" });

    if (!requirePostOwnerOrAdmin(db, req, res, id)) return;
    db.run("UPDATE posts SET deleted_at = ? WHERE id = ?", [Date.now(), id]);
    await db.flush();
    res.json({ ok: true });
  });

  app.get("/api/posts/:id/comments", (req, res) => {
    const postId = Number(req.params.id);
    if (!Number.isFinite(postId)) return res.status(400).json({ error: "invalid_id" });
    const page = clamp(Number(req.query?.page || 1), 1, 9999);
    const limit = clamp(Number(req.query?.limit || 50), 1, 100);
    const offset = (page - 1) * limit;

    const rows = db.all(
      `
      SELECT c.id, c.user_id, c.body_md, c.body_html, c.created_at, c.updated_at, u.username AS author
      FROM comments c
      JOIN users u ON u.id = c.user_id
      WHERE c.post_id = ? AND c.deleted_at IS NULL
      ORDER BY c.created_at ASC
      LIMIT ? OFFSET ?
      `,
      [postId, limit, offset],
    );

    res.json({
      comments: rows.map((r) => ({
        id: r.id,
        userId: r.user_id,
        author: r.author,
        body: r.body_md,
        bodyHtml: r.body_html,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        canEdit: req.user ? req.user.id === r.user_id || !!req.user.is_admin : false,
      })),
      page,
      limit,
    });
  });

  app.post("/api/posts/:id/comments", requireAuth, async (req, res) => {
    const postId = Number(req.params.id);
    if (!Number.isFinite(postId)) return res.status(400).json({ error: "invalid_id" });
    const body = safeText(req.body?.body, 1, 5000);
    if (!body) return res.status(400).json({ error: "invalid_input" });

    const post = db.get(
      "SELECT id FROM posts WHERE id = ? AND deleted_at IS NULL",
      [postId],
    );
    if (!post) return res.status(404).json({ error: "not_found" });

    const now = Date.now();
    const bodyHtml = markdownToSafeHtml(body);
    const id = db.insert(
      "INSERT INTO comments (post_id, user_id, body_md, body_html, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, NULL)",
      [postId, req.user.id, body, bodyHtml, now, now],
    );

    emitPostEvent(db, {
      postId,
      actorUserId: req.user.id,
      type: "comment.created",
      payload: { commentId: id },
    });
    await db.flush();
    res.json({ ok: true, id });
  });

  app.patch("/api/comments/:id", requireAuth, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "invalid_id" });

    const existing = db.get(
      "SELECT id, user_id FROM comments WHERE id = ? AND deleted_at IS NULL",
      [id],
    );
    if (!existing) return res.status(404).json({ error: "not_found" });
    if (existing.user_id !== req.user.id && !req.user.is_admin) {
      return res.status(403).json({ error: "forbidden" });
    }

    const body = safeText(req.body?.body, 1, 5000);
    if (!body) return res.status(400).json({ error: "invalid_input" });

    db.run(
      "UPDATE comments SET body_md = ?, body_html = ?, updated_at = ? WHERE id = ?",
      [body, markdownToSafeHtml(body), Date.now(), id],
    );
    await db.flush();
    res.json({ ok: true });
  });

  app.delete("/api/comments/:id", requireAuth, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "invalid_id" });

    const existing = db.get(
      "SELECT id, user_id FROM comments WHERE id = ? AND deleted_at IS NULL",
      [id],
    );
    if (!existing) return res.status(404).json({ error: "not_found" });
    if (existing.user_id !== req.user.id && !req.user.is_admin) {
      return res.status(403).json({ error: "forbidden" });
    }
    db.run("UPDATE comments SET deleted_at = ? WHERE id = ?", [Date.now(), id]);
    await db.flush();
    res.json({ ok: true });
  });

  app.post("/api/posts/:id/like", requireAuth, async (req, res) => {
    const postId = Number(req.params.id);
    if (!Number.isFinite(postId)) return res.status(400).json({ error: "invalid_id" });

    const post = db.get(
      "SELECT id FROM posts WHERE id = ? AND deleted_at IS NULL",
      [postId],
    );
    if (!post) return res.status(404).json({ error: "not_found" });

    const existing = db.get(
      "SELECT 1 FROM likes WHERE user_id = ? AND post_id = ?",
      [req.user.id, postId],
    );
    if (existing) {
      db.run("DELETE FROM likes WHERE user_id = ? AND post_id = ?", [
        req.user.id,
        postId,
      ]);
      emitPostEvent(db, {
        postId,
        actorUserId: req.user.id,
        type: "like.removed",
        payload: null,
      });
      await db.flush();
      return res.json({ ok: true, liked: false });
    }
    db.run("INSERT INTO likes (user_id, post_id, created_at) VALUES (?, ?, ?)", [
      req.user.id,
      postId,
      Date.now(),
    ]);
    emitPostEvent(db, {
      postId,
      actorUserId: req.user.id,
      type: "like.added",
      payload: null,
    });
    await db.flush();
    res.json({ ok: true, liked: true });
  });

  // Agents: atomically claim an open task.
  // If claim succeeds, assignee becomes current user and status becomes in_progress.
  app.post("/api/tasks/:id/claim", requireAuth, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "invalid_id" });
    const task = requireTaskPost(db, res, id);
    if (!task) return;

    if (task.status !== "open") {
      return res.status(409).json({ error: "not_claimable" });
    }

    // First-come-first-serve: any authenticated user can claim.

    // If already assigned, only that user can claim.
    if (task.assignee_user_id && task.assignee_user_id !== req.user.id) {
      return res.status(409).json({ error: "already_assigned" });
    }

    // Atomic compare-and-set.
    const ok = db.get(
      "SELECT 1 AS ok FROM posts WHERE id = ? AND kind = 'task' AND status = 'open' AND deleted_at IS NULL",
      [id],
    );
    if (!ok) return res.status(409).json({ error: "not_claimable" });

    db.run(
      "UPDATE posts SET status = 'in_progress', assignee_user_id = ?, updated_at = ? WHERE id = ? AND kind = 'task' AND status = 'open' AND deleted_at IS NULL",
      [req.user.id, Date.now(), id],
    );

    emitPostEvent(db, {
      postId: id,
      actorUserId: req.user.id,
      type: "task.claimed",
      payload: { assignee: req.user.username },
    });
    await db.flush();

    const updated = db.get(
      "SELECT id, status, (SELECT username FROM users au WHERE au.id = posts.assignee_user_id) AS assignee FROM posts WHERE id = ?",
      [id],
    );
    res.json({ ok: true, task: { id: updated.id, status: updated.status, assignee: updated.assignee } });
  });

  // Conversations / chat (agents and users)
  app.post("/api/conversations/dm", requireAuth, async (req, res) => {
    const username = safeText(req.body?.username, 2, 24);
    if (!username || !isValidUsername(username)) {
      return res.status(400).json({ error: "invalid_input" });
    }
    const other = db.get("SELECT id FROM users WHERE username = ?", [
      username.toLowerCase(),
    ]);
    if (!other) return res.status(404).json({ error: "not_found" });
    if (other.id === req.user.id) {
      return res.status(400).json({ error: "invalid_input" });
    }

    const a = Math.min(req.user.id, other.id);
    const b = Math.max(req.user.id, other.id);
    const dmKey = `dm:${a}:${b}`;

    let convo = db.get(
      "SELECT id, kind, title, created_at FROM conversations WHERE dm_key = ?",
      [dmKey],
    );
    const now = Date.now();
    if (!convo) {
      const convoId = db.insert(
        "INSERT INTO conversations (kind, title, dm_key, created_at) VALUES ('dm', NULL, ?, ?)",
        [dmKey, now],
      );
      db.run(
        "INSERT INTO conversation_members (conversation_id, user_id, joined_at) VALUES (?, ?, ?)",
        [convoId, req.user.id, now],
      );
      db.run(
        "INSERT INTO conversation_members (conversation_id, user_id, joined_at) VALUES (?, ?, ?)",
        [convoId, other.id, now],
      );
      await db.flush();
      convo = { id: convoId, kind: "dm", title: null, created_at: now };
    }

    // Ensure membership exists (in case of older DB edits).
    db.run(
      "INSERT OR IGNORE INTO conversation_members (conversation_id, user_id, joined_at) VALUES (?, ?, ?)",
      [convo.id, req.user.id, now],
    );
    await db.flush();

    res.json({
      conversation: {
        id: convo.id,
        kind: convo.kind,
        title: convo.title,
        createdAt: convo.created_at,
      },
    });
  });

  app.get("/api/conversations", requireAuth, (req, res) => {
    const rows = db.all(
      `
      SELECT c.id, c.kind, c.title, c.created_at
      FROM conversations c
      JOIN conversation_members m ON m.conversation_id = c.id
      WHERE m.user_id = ?
      ORDER BY c.created_at DESC
      `,
      [req.user.id],
    );
    res.json({
      conversations: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        title: r.title,
        createdAt: r.created_at,
      })),
    });
  });

  app.get("/api/conversations/:id/messages", requireAuth, (req, res) => {
    const convoId = Number(req.params.id);
    if (!Number.isFinite(convoId)) return res.status(400).json({ error: "invalid_id" });
    const limit = clamp(Number(req.query?.limit || 50), 1, 200);
    const beforeId = req.query?.beforeId ? Number(req.query.beforeId) : null;
    if (beforeId !== null && !Number.isFinite(beforeId)) {
      return res.status(400).json({ error: "invalid_input" });
    }

    const member = db.get(
      "SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?",
      [convoId, req.user.id],
    );
    if (!member) return res.status(403).json({ error: "forbidden" });

    const params = [convoId];
    let where = "m.conversation_id = ? AND m.deleted_at IS NULL";
    if (beforeId) {
      where += " AND m.id < ?";
      params.push(beforeId);
    }

    const rows = db.all(
      `
      SELECT m.id, m.user_id, u.username AS author, m.body_md, m.body_html, m.created_at
      FROM messages m
      JOIN users u ON u.id = m.user_id
      WHERE ${where}
      ORDER BY m.id DESC
      LIMIT ?
      `,
      [...params, limit],
    );

    res.json({
      messages: rows
        .map((r) => ({
          id: r.id,
          userId: r.user_id,
          author: r.author,
          body: r.body_md,
          bodyHtml: r.body_html,
          createdAt: r.created_at,
        }))
        .reverse(),
    });
  });

  app.post("/api/conversations/:id/messages", requireAuth, async (req, res) => {
    const convoId = Number(req.params.id);
    if (!Number.isFinite(convoId)) return res.status(400).json({ error: "invalid_id" });
    const body = safeText(req.body?.body, 1, 5000);
    if (!body) return res.status(400).json({ error: "invalid_input" });

    const member = db.get(
      "SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?",
      [convoId, req.user.id],
    );
    if (!member) return res.status(403).json({ error: "forbidden" });

    const now = Date.now();
    const id = db.insert(
      "INSERT INTO messages (conversation_id, user_id, body_md, body_html, created_at, deleted_at) VALUES (?, ?, ?, ?, ?, NULL)",
      [convoId, req.user.id, body, markdownToSafeHtml(body), now],
    );
    await db.flush();
    res.json({ ok: true, id });
  });

  app.listen(PORT, HOST, () => {
    console.log(`Forum listening on http://${HOST}:${PORT}`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
