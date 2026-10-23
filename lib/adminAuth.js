const crypto = require("node:crypto");

const COOKIE_NAME = "desiAdmin";
const SESSION_TTL_SECONDS = 8 * 60 * 60;

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  return leftBuffer.length === rightBuffer.length &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function getSecret() {
  const secret = process.env.ADMIN_SESSION_SECRET || "";
  if (secret.length < 32) {
    throw new Error("ADMIN_SESSION_SECRET must be at least 32 characters.");
  }
  return secret;
}

function sign(payload, secret) {
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

function readCookie(req, name) {
  const cookie = (req.headers.cookie || "")
    .split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${name}=`));
  return cookie ? decodeURIComponent(cookie.slice(name.length + 1)) : "";
}

function createToken() {
  const payload = Buffer.from(JSON.stringify({
    admin: true,
    expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000
  })).toString("base64url");
  return `${payload}.${sign(payload, getSecret())}`;
}

function isAdmin(req) {
  try {
    const [payload, providedSignature, extra] = readCookie(req, COOKIE_NAME).split(".");
    if (!payload || !providedSignature || extra !== undefined) return false;
    if (!safeEqual(sign(payload, getSecret()), providedSignature)) return false;

    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return session.admin === true &&
      Number.isSafeInteger(session.expiresAt) &&
      session.expiresAt > Date.now();
  } catch {
    return false;
  }
}

function setSessionCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_TTL_SECONDS * 1000,
    path: "/"
  });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/"
  });
}

module.exports = {
  clearSessionCookie,
  createToken,
  isAdmin,
  safeEqual,
  setSessionCookie
};
