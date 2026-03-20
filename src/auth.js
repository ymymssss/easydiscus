const crypto = require("crypto");

function setSessionCookie(res, token) {
  res.cookie("session", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: false,
    maxAge: 1000 * 60 * 60 * 24 * 14,
    path: "/",
  });
}

function clearSessionCookie(res) {
  res.cookie("session", "", {
    httpOnly: true,
    sameSite: "lax",
    secure: false,
    maxAge: 0,
    path: "/",
  });
}

async function getSessionUser(db, req) {
  const authz = req.headers?.authorization || req.headers?.Authorization || "";
  if (typeof authz === "string" && authz.startsWith("Bearer ")) {
    const token = authz.slice("Bearer ".length).trim();
    if (token) {
      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
      const now = Date.now();
      const tok = db.get(
        "SELECT id, user_id, expires_at, revoked_at FROM api_tokens WHERE token_hash = ?",
        [tokenHash],
      );
      if (tok && !tok.revoked_at && (!tok.expires_at || tok.expires_at > now)) {
        db.run("UPDATE api_tokens SET last_used_at = ? WHERE id = ?", [now, tok.id]);
        const user = db.get(
          "SELECT id, username, created_at, is_admin, is_agent FROM users WHERE id = ?",
          [tok.user_id],
        );
        return user || null;
      }
    }
  }

  const token = req.cookies?.session || null;
  if (!token) return null;
  const now = Date.now();
  const sess = db.get(
    "SELECT token, user_id, expires_at FROM sessions WHERE token = ?",
    [token],
  );
  if (!sess) return null;
  if (sess.expires_at && sess.expires_at < now) {
    db.run("DELETE FROM sessions WHERE token = ?", [token]);
    await db.flush();
    return null;
  }
  db.run("UPDATE sessions SET last_seen_at = ? WHERE token = ?", [now, token]);

  const user = db.get(
    "SELECT id, username, created_at, is_admin, is_agent FROM users WHERE id = ?",
    [sess.user_id],
  );
  return user || null;
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "unauthorized" });
  next();
}

module.exports = {
  setSessionCookie,
  clearSessionCookie,
  getSessionUser,
  requireAuth,
};
