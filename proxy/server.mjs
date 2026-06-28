import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

const PORT = Number(process.env.PORT || 3010);
const HOST = process.env.HOST || "127.0.0.1";
const SUB2API_BASE_URL = trimSlash(process.env.SUB2API_BASE_URL || "http://sub2api:8080");
const GATEWAY_BASE_URL = trimSlash(process.env.GATEWAY_BASE_URL || SUB2API_BASE_URL);
const COOKIE_NAME = process.env.COOKIE_NAME || "smallice_draw_token";
const KEY_COOKIE_NAME = process.env.KEY_COOKIE_NAME || "smallice_draw_key_id";
const COOKIE_MAX_AGE_SECONDS = Number(process.env.COOKIE_MAX_AGE_SECONDS || 86400);
const COOKIE_SECURE = String(process.env.COOKIE_SECURE || "auto").toLowerCase();
const COOKIE_SAME_SITE = normalizeSameSite(process.env.COOKIE_SAME_SITE || "Lax");
const PROFILE_CACHE_MS = Number(process.env.PROFILE_CACHE_MS || 30000);
const GATEWAY_REQUEST_TIMEOUT_MS = Number(process.env.GATEWAY_REQUEST_TIMEOUT_MS || 1800000);
const API_PREFIX = "/tools/draw-api";
const OPENAI_PREFIX = `${API_PREFIX}/v1`;
const SELECTED_KEY_HEADER_NAME = "x-smallice-draw-key-id";

const profileCache = new Map();
const keyCache = new Map();

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url || "/", "http://smallice.local");

    if (requestUrl.pathname === "/health" || requestUrl.pathname === `${API_PREFIX}/health`) {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (!requestUrl.pathname.startsWith(API_PREFIX)) {
      sendJson(res, 404, { error: { code: "not_found", message: "Draw API endpoint not found." } });
      return;
    }

    if (requestUrl.pathname === `${API_PREFIX}/session/bootstrap` && req.method === "POST") {
      await bootstrapSession(req, res);
      return;
    }

    if (requestUrl.pathname === `${API_PREFIX}/session` && req.method === "GET") {
      await sendSession(req, res);
      return;
    }

    if (requestUrl.pathname === `${API_PREFIX}/keys` && req.method === "GET") {
      await sendKeys(req, res);
      return;
    }

    if (requestUrl.pathname === `${API_PREFIX}/keys/select` && req.method === "POST") {
      await selectKey(req, res);
      return;
    }

    if (requestUrl.pathname.startsWith(`${OPENAI_PREFIX}/`)) {
      await proxyGateway(req, res, requestUrl);
      return;
    }

    sendJson(res, 404, { error: { code: "not_found", message: "Draw API endpoint not found." } });
  } catch (error) {
    console.error("[smallice-draw-proxy] request failed", error);
    if (!res.headersSent) {
      sendJson(res, 502, { error: { code: "proxy_failed", message: "Smallice Draw proxy error." } });
    } else {
      res.end();
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[smallice-draw-proxy] listening on ${HOST}:${PORT}`);
});

async function bootstrapSession(req, res) {
  const body = await readJsonBody(req);
  const token = cleanToken(body?.token);
  if (!token) {
    sendJson(res, 401, { error: { code: "session_expired", message: "未获取到登录信息，请返回 Smallice AI 主站登录后再打开 Draw。" } });
    return;
  }

  const profile = await validateSub2Token(token);
  if (!profile) {
    clearCookie(req, res, COOKIE_NAME);
    clearCookie(req, res, KEY_COOKIE_NAME);
    sendJson(res, 401, { error: { code: "session_expired", message: "登录状态已失效，请返回 Smallice AI 主站重新登录后再打开 Draw。" } });
    return;
  }

  setCookie(req, res, COOKIE_NAME, token);
  sendJson(res, 200, buildSessionPayload(profile, getCookie(req.headers.cookie, KEY_COOKIE_NAME)));
}

async function sendSession(req, res) {
  const session = await getSession(req, res, false);
  if (!session) {
    sendJson(res, 401, { authenticated: false, user: null, selectedKeyId: null });
    return;
  }

  const keys = await listUserKeys(session.token, { forceRefresh: true }).catch(() => []);
  const selectedKeyId = await getValidSelectedKeyId(session.token, req.headers.cookie, keys);
  sendJson(res, 200, buildSessionPayload(session.profile, selectedKeyId));
}

async function sendKeys(req, res) {
  const session = await getSession(req, res);
  if (!session) return;

  const forceRefresh = new URL(req.url || "/", "http://smallice.local").searchParams.get("refresh") === "1";
  const keys = await listUserKeys(session.token, { forceRefresh });
  const selectedKeyId = await getValidSelectedKeyId(session.token, req.headers.cookie, keys);
  if (!selectedKeyId && keys.length === 1) {
    setCookie(req, res, KEY_COOKIE_NAME, keys[0].id);
  }

  sendJson(res, 200, {
    items: keys.map(publicKey),
    selectedKeyId: selectedKeyId || keys[0]?.id || null,
  });
}

async function selectKey(req, res) {
  const session = await getSession(req, res);
  if (!session) return;

  const body = await readJsonBody(req);
  const keyId = String(body?.keyId || "").trim();
  if (!keyId) {
    sendJson(res, 400, { error: { code: "invalid_key", message: "请选择一个 API Key。" } });
    return;
  }

  const keys = await listUserKeys(session.token, { forceRefresh: true });
  const selected = keys.find((key) => key.id === keyId);
  if (!selected) {
    clearCookie(req, res, KEY_COOKIE_NAME);
    sendJson(res, 403, { error: { code: "invalid_key", message: "该 API Key 不存在或不属于当前用户。" } });
    return;
  }

  setCookie(req, res, KEY_COOKIE_NAME, selected.id);
  sendJson(res, 200, { ok: true, selectedKeyId: selected.id });
}

async function proxyGateway(clientReq, clientRes, requestUrl) {
  const session = await getSession(clientReq, clientRes);
  if (!session) return;

  let keys = await listUserKeys(session.token).catch((error) => {
    console.error("[smallice-draw-proxy] key list failed", error);
    return [];
  });
  if (!keys.length) {
    sendOpenAIError(clientRes, 403, "no_api_key", "当前账号没有可用的 Smallice API Key。");
    return;
  }

  const requestedKeyId = getHeaderString(clientReq.headers, SELECTED_KEY_HEADER_NAME);
  const cookieKeyId = getCookie(clientReq.headers.cookie, KEY_COOKIE_NAME);
  let selected = keys.find((key) => key.id === requestedKeyId) || keys.find((key) => key.id === cookieKeyId);
  if ((requestedKeyId || cookieKeyId) && !selected) {
    keys = await listUserKeys(session.token, { forceRefresh: true }).catch(() => keys);
    selected = keys.find((key) => key.id === requestedKeyId) || keys.find((key) => key.id === cookieKeyId);
  }
  if (requestedKeyId && (!selected || selected.id !== requestedKeyId)) {
    sendOpenAIError(clientRes, 403, "invalid_key", "该 API Key 不存在或不属于当前用户，请刷新 Key 列表后重试。");
    return;
  }
  selected ||= keys[0];
  if (!cookieKeyId || selected.id !== cookieKeyId) {
    setCookie(clientReq, clientRes, KEY_COOKIE_NAME, selected.id);
  }

  const targetPath = requestUrl.pathname.replace(API_PREFIX, "") + requestUrl.search;
  const target = new URL(targetPath, GATEWAY_BASE_URL);
  const headers = buildGatewayHeaders(clientReq.headers, selected.key, target);
  const requester = target.protocol === "https:" ? https : http;

  const upstreamReq = requester.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === "https:" ? 443 : 80),
      method: clientReq.method,
      path: target.pathname + target.search,
      headers,
    },
    (upstreamRes) => {
      const headers = { ...upstreamRes.headers };
      normalizeProxyResponseHeaders(headers);
      clientRes.writeHead(upstreamRes.statusCode || 502, headers);
      upstreamRes.pipe(clientRes);
    },
  );

  upstreamReq.on("error", (error) => {
    console.error("[smallice-draw-proxy] gateway request failed", error);
    if (clientRes.headersSent) return;
    sendOpenAIError(clientRes, 502, "gateway_failed", "Smallice API 网关请求失败。");
  });

  upstreamReq.setTimeout(GATEWAY_REQUEST_TIMEOUT_MS, () => {
    console.error("[smallice-draw-proxy] gateway request timeout", {
      timeout_ms: GATEWAY_REQUEST_TIMEOUT_MS,
      path: target.pathname,
      host: target.host,
    });
    upstreamReq.destroy(new Error("gateway request timeout"));
  });

  clientReq.on("aborted", () => upstreamReq.destroy(new Error("client request aborted")));
  clientRes.on("close", () => {
    if (!clientRes.writableEnded) upstreamReq.destroy(new Error("client response closed"));
  });

  clientReq.pipe(upstreamReq);
}

async function getSession(req, res, sendError = true) {
  const token = cleanToken(getCookie(req.headers.cookie, COOKIE_NAME));
  if (!token) {
    if (sendError) {
      sendJson(res, 401, { error: { code: "session_expired", message: "未获取到登录信息，请返回 Smallice AI 主站登录后再打开 Draw。" } });
    }
    return null;
  }

  const profile = await validateSub2Token(token);
  if (!profile) {
    clearCookie(req, res, COOKIE_NAME);
    clearCookie(req, res, KEY_COOKIE_NAME);
    if (sendError) {
      sendJson(res, 401, { error: { code: "session_expired", message: "登录状态已失效，请返回 Smallice AI 主站重新登录后再打开 Draw。" } });
    }
    return null;
  }

  return { token, profile };
}

async function validateSub2Token(token) {
  const cached = profileCache.get(token);
  if (cached && cached.expiresAt > Date.now()) return cached.profile;

  const response = await fetchJson(`${SUB2API_BASE_URL}/api/v1/user/profile`, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
    },
  }).catch((error) => {
    console.error("[smallice-draw-proxy] token validation failed", error);
    return null;
  });

  const data = unwrapEnvelope(response);
  if (!data?.email) return null;

  const profile = {
    id: String(data.id || ""),
    email: String(data.email).toLowerCase(),
    name: displayName(data),
    role: data.role === "admin" ? "admin" : "user",
  };

  profileCache.set(token, { profile, expiresAt: Date.now() + PROFILE_CACHE_MS });
  return profile;
}

async function listUserKeys(token, options = {}) {
  const cacheKey = token;
  const cached = keyCache.get(cacheKey);
  if (!options.forceRefresh && cached && cached.expiresAt > Date.now()) return cached.keys;

  const eligibleKeys = await fetchImageEligibleKeys(token);
  const eligibleIds = new Set(eligibleKeys.map((item) => String(item.id)));
  if (!eligibleIds.size) {
    keyCache.set(cacheKey, { keys: [], expiresAt: Date.now() + 10000 });
    return [];
  }

  const payload = await fetchJson(`${SUB2API_BASE_URL}/api/v1/keys?page=1&page_size=100`, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
    },
  });
  const data = unwrapEnvelope(payload);
  const items = Array.isArray(data?.items) ? data.items : [];
  const keys = items
    .filter((item) => item?.key && eligibleIds.has(String(item.id)) && item.status === "active" && (!item.group?.status || item.group.status === "active"))
    .map((item, index) => ({
      id: String(item.id || item.key || index),
      name: String(eligibleKeys.find((key) => String(key.id) === String(item.id))?.name || item.name || `API Key ${index + 1}`),
      key: String(item.key),
      groupName: String(eligibleKeys.find((key) => String(key.id) === String(item.id))?.group_name || item.group?.name || ""),
      status: String(item.status || "active"),
      imageEligible: true,
    }));

  keyCache.set(cacheKey, { keys, expiresAt: Date.now() + 10000 });
  return keys;
}

async function fetchImageEligibleKeys(token) {
  const payload = await fetchJson(`${SUB2API_BASE_URL}/api/v1/canvas/image-keys`, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
    },
  });
  const data = unwrapEnvelope(payload);
  return Array.isArray(data?.items) ? data.items.filter((item) => item?.image_eligible !== false) : [];
}

async function getValidSelectedKeyId(token, rawCookie, providedKeys = null) {
  const selectedKeyId = getCookie(rawCookie, KEY_COOKIE_NAME);
  if (!selectedKeyId) return "";
  const keys = providedKeys || await listUserKeys(token).catch(() => []);
  return keys.some((key) => key.id === selectedKeyId) ? selectedKeyId : "";
}

function publicKey(key) {
  return {
    id: key.id,
    name: key.name,
    groupName: key.groupName,
    status: key.status,
    imageEligible: true,
  };
}

function buildSessionPayload(profile, selectedKeyId) {
  return {
    authenticated: true,
    user: profile,
    selectedKeyId: selectedKeyId || null,
  };
}

function buildGatewayHeaders(sourceHeaders, apiKey, target) {
  const headers = sanitizeHeaders(sourceHeaders);
  headers.host = target.host;
  headers.authorization = `Bearer ${apiKey}`;
  headers["x-api-key"] = apiKey;
  return headers;
}

function sanitizeHeaders(sourceHeaders) {
  const headers = { ...sourceHeaders };
  delete headers.host;
  delete headers.cookie;
  delete headers.authorization;
  delete headers["x-api-key"];
  delete headers["x-goog-api-key"];
  delete headers["accept-encoding"];
  delete headers["x-user-email"];
  delete headers["x-user-name"];
  delete headers["x-user-role"];
  delete headers[SELECTED_KEY_HEADER_NAME];
  delete headers["cf-connecting-ip"];
  delete headers["cf-ipcountry"];
  delete headers["cf-ray"];
  return headers;
}

function getHeaderString(headers, name) {
  const value = headers[name];
  const raw = Array.isArray(value) ? value[0] : value;
  return String(raw || "").trim().slice(0, 128);
}

function normalizeProxyResponseHeaders(headers) {
  delete headers["content-security-policy"];
  delete headers["content-security-policy-report-only"];
  delete headers["content-encoding"];
  headers["cache-control"] = "no-store";
}

async function fetchJson(url, init = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.SUB2API_FETCH_TIMEOUT_MS || 10000));
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : null;
    if (!response.ok) {
      throw new Error(payload?.message || payload?.error?.message || text || `HTTP ${response.status}`);
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

function unwrapEnvelope(payload) {
  if (payload && typeof payload === "object" && "code" in payload) return payload.data;
  return payload?.data || payload;
}

async function readJsonBody(req) {
  const text = await readRequestBody(req);
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendOpenAIError(res, status, code, message) {
  sendJson(res, status, {
    error: {
      message,
      type: "smallice_draw_proxy_error",
      code,
    },
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function setCookie(req, res, name, value) {
  appendSetCookie(
    res,
    buildCookie(req, name, encodeURIComponent(value), `Max-Age=${COOKIE_MAX_AGE_SECONDS}`),
  );
}

function clearCookie(req, res, name) {
  appendSetCookie(res, buildCookie(req, name, "", "Max-Age=0"));
}

function appendSetCookie(res, value) {
  const existing = res.getHeader("set-cookie");
  if (!existing) {
    res.setHeader("set-cookie", value);
  } else if (Array.isArray(existing)) {
    res.setHeader("set-cookie", [...existing, value]);
  } else {
    res.setHeader("set-cookie", [existing, value]);
  }
}

function getCookie(rawCookie, name) {
  if (!rawCookie) return "";
  const parts = rawCookie.split(";");
  for (const part of parts) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (rawName === name) return decodeURIComponent(rawValue.join("=") || "");
  }
  return "";
}

function buildCookie(req, name, value, maxAgePart) {
  const parts = [`${name}=${value}`, "Path=/", maxAgePart, "HttpOnly", `SameSite=${COOKIE_SAME_SITE}`];
  if (shouldUseSecureCookie(req)) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

function shouldUseSecureCookie(req) {
  if (COOKIE_SECURE === "true" || COOKIE_SECURE === "1") return true;
  if (COOKIE_SECURE === "false" || COOKIE_SECURE === "0") return false;

  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
  if (forwardedProto) return forwardedProto === "https";

  const forwardedSsl = String(req.headers["x-forwarded-ssl"] || "").toLowerCase();
  if (forwardedSsl === "on") return true;

  return Boolean(req.socket?.encrypted);
}

function normalizeSameSite(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "none") return "None";
  if (normalized === "strict") return "Strict";
  return "Lax";
}

function cleanToken(value) {
  if (typeof value !== "string") return "";
  const token = value.trim();
  if (!token || token.length > 4096 || /[\s<>]/.test(token)) return "";
  return token;
}

function displayName(data) {
  const explicit = data.name || data.username || data.display_name || data.email;
  return String(explicit || "Smallice User");
}

function trimSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}
