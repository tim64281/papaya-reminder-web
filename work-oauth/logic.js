const PROJECT_URL = "https://soxixdwyqmhkqbpfqkug.supabase.co";
const CLIENT_ID = "5ea1bd3e-4eed-417e-ab9a-865ff1857486";
const CALLBACK = "https://chatgpt.com/connector/oauth/eCrXCe2VBSeo";
const PAGE_URL = "https://tim64281.github.io/papaya-reminder-web/work-oauth/";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function reject(message = "授權資訊無法驗證，已停止操作。") {
  throw new Error(message);
}

export function parseAuthorizationId(search) {
  const values = new URLSearchParams(search).getAll("authorization_id");
  if (values.length === 0) return null;
  if (values.length !== 1 || !UUID.test(values[0])) reject("授權編號無效，請從 ChatGPT 重新發起連線。");
  return values[0].toLowerCase();
}

export function normalizeScopes(scope) {
  if (typeof scope !== "string") reject();
  const scopes = [...new Set(scope.split(/[\t\r\n ]+/).filter(Boolean))];
  if (scopes.some((value) => !/^[\x21\x23-\x5b\x5d-\x7e]+$/.test(value))) reject();
  return scopes;
}

export function validateConfig(config) {
  if (!config || config.supabaseUrl !== PROJECT_URL || config.allowedClientId !== CLIENT_ID ||
      config.pageUrl !== PAGE_URL || typeof config.allowBootstrapSignup !== "boolean" ||
      typeof config.publishableKey !== "string" || !/^sb_publishable_[A-Za-z0-9_-]+$/.test(config.publishableKey) ||
      !Array.isArray(config.allowedRedirectUris) || config.allowedRedirectUris.length !== 1 ||
      config.allowedRedirectUris[0] !== CALLBACK) {
    reject("網站設定尚未完成或不符，所有操作已停用。請回到對話通知管理者。");
  }
  return config;
}

function destination(value) {
  if (typeof value !== "string" || /[\s\\#]/.test(value)) reject("回跳網址未通過安全檢查，已停止跳轉。");
  let url;
  try { url = new URL(value); } catch { reject("回跳網址未通過安全檢查，已停止跳轉。"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) reject();
  return url;
}

export function validateRedirect(value, allowlist) {
  if (!Array.isArray(allowlist) || allowlist.length === 0) reject();
  const approved = allowlist.map((entry) => {
    const url = destination(entry);
    if (url.search || entry !== url.href || entry.includes("?") || entry.includes("*")) reject();
    return url;
  });
  const candidate = destination(value);
  // Check the literal destination too: URL parsing must not normalize an unregistered path.
  const literalDestination = value.split("?", 1)[0];
  if (!approved.some((url) => candidate.origin === url.origin && candidate.pathname === url.pathname && literalDestination === url.href)) {
    reject("回跳網址未通過安全檢查，已停止跳轉。");
  }
  return value;
}

export function validateClient(client, allowedId) {
  if (allowedId !== CLIENT_ID || !client || client.id !== allowedId) reject("提出要求的應用程式不在允許名單，已停止授權。");
  return client;
}

export function emailRedirectUrl(config, authorizationId) {
  validateConfig(config);
  if (authorizationId === null) return config.pageUrl;
  const parsed = parseAuthorizationId("?authorization_id=" + encodeURIComponent(authorizationId));
  return config.pageUrl + "?authorization_id=" + parsed;
}

export async function verifiedIdentity(auth) {
  const userResult = await auth.getUser();
  const user = userResult.data?.user;
  if (userResult.error || !user || !UUID.test(user.id) || !user.email || !user.email_confirmed_at || user.is_anonymous === true) {
    reject("請先登入並完成電子郵件驗證，再繼續操作。");
  }
  const claimsResult = await auth.getClaims();
  if (claimsResult.error || claimsResult.data?.claims?.sub !== user.id) reject("登入驗證失敗，請重新登入。");
  return user;
}

export async function loadAuthorization(auth, authorizationId, config) {
  validateConfig(config);
  const id = parseAuthorizationId("?authorization_id=" + encodeURIComponent(authorizationId));
  const user = await verifiedIdentity(auth);
  const result = await auth.oauth.getAuthorizationDetails(id);
  if (result.error || !result.data) reject("無法取得授權要求，請從 ChatGPT 重新發起連線。");
  if (result.data.redirect_url) return { user, redirectUrl: validateRedirect(result.data.redirect_url, config.allowedRedirectUris) };
  const client = validateClient(result.data.client, config.allowedClientId);
  if (result.data.authorization_id !== id || result.data.user?.id !== user.id) reject("授權帳號或編號與目前要求不同，請重新登入。");
  if (!config.allowedRedirectUris.includes(result.data.redirect_uri)) reject("此應用程式的回跳網址不在允許名單。");
  return { user, client, scopes: normalizeScopes(result.data.scope), redirectUrl: null };
}

export async function decideAuthorization(auth, authorizationId, config, decision, displayedUserId) {
  validateConfig(config);
  if (decision !== "approve" && decision !== "deny") reject();
  const details = await loadAuthorization(auth, authorizationId, config);
  if (details.user.id !== displayedUserId) reject("登入帳號已變更，請重新檢查授權內容。");
  if (details.redirectUrl) return details.redirectUrl;
  const method = decision === "approve" ? "approveAuthorization" : "denyAuthorization";
  const id = parseAuthorizationId("?authorization_id=" + encodeURIComponent(authorizationId));
  const result = await auth.oauth[method](id, { skipBrowserRedirect: true });
  if (result.error || !result.data) reject("授權操作未完成，請稍後重新嘗試。");
  return validateRedirect(result.data.redirect_url, config.allowedRedirectUris);
}
