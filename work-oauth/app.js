import { validateConfig, parseAuthorizationId, emailRedirectUrl, verifiedIdentity, loadAuthorization, decideAuthorization } from "./logic.js";

export async function mountApp({ document, location, config, createClient }) {
  const ids = ["page", "status", "error", "login-form", "email", "password", "sign-in", "sign-up", "logout", "account", "identity", "consent", "client-name", "client-id", "scopes", "approve", "deny", "confirmation", "bootstrap-complete", "mode"];
  const ui = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
  let busy = true;
  let fatal = false;
  let userId = null;
  let consentReady = false;
  let authorizationId = null;
  let auth;

  function controls() {
    ui["sign-in"].disabled = fatal || busy || !!userId;
    ui["sign-up"].disabled = fatal || busy || !!userId || authorizationId !== null || !config?.allowBootstrapSignup;
    ui["sign-up"].hidden = authorizationId !== null || !config?.allowBootstrapSignup || !!userId;
    ui.email.disabled = fatal || busy || !!userId;
    ui.password.disabled = fatal || busy || !!userId;
    ui.logout.disabled = fatal || busy || !userId;
    ui.approve.disabled = fatal || busy || !consentReady;
    ui.deny.disabled = fatal || busy || !consentReady;
    ui.page.setAttribute("aria-busy", String(busy));
  }
  function error(message) {
    ui.error.textContent = message;
    ui.error.hidden = false;
  }
  function signedOut() {
    userId = null;
    consentReady = false;
    ui.identity.textContent = "";
    ui.account.hidden = true;
    ui.consent.hidden = true;
    ui["bootstrap-complete"].hidden = true;
    ui["login-form"].hidden = false;
    controls();
  }
  function redirect(url) {
    consentReady = false;
    controls();
    ui.status.textContent = "驗證完成，正在返回 ChatGPT…";
    location.assign(url);
  }
  async function refresh() {
    consentReady = false;
    ui.consent.hidden = true;
    let user;
    try { user = await verifiedIdentity(auth); } catch {
      signedOut();
      ui.status.textContent = "請由本人輸入電子郵件與密碼登入。";
      return;
    }
    userId = user.id;
    ui.identity.textContent = user.email;
    ui.account.hidden = false;
    ui["login-form"].hidden = true;
    if (authorizationId === null) {
      ui["bootstrap-complete"].hidden = false;
      ui.status.textContent = "已驗證登入身分。請回到這段對話，讓管理者完成測試帳號設定。";
      return;
    }
    const details = await loadAuthorization(auth, authorizationId, config);
    if (details.redirectUrl) { redirect(details.redirectUrl); return; }
    ui["client-name"].textContent = typeof details.client.name === "string" ? details.client.name : "已驗證的測試應用程式";
    ui["client-id"].textContent = details.client.id;
    ui.scopes.replaceChildren(...details.scopes.map((scope) => {
      const item = document.createElement("li");
      const meanings = { openid: "確認登入身分", email: "電子郵件", profile: "基本個人資料" };
      item.textContent = meanings[scope] ? `${meanings[scope]}（${scope}）` : scope;
      return item;
    }));
    if (details.scopes.length === 0) {
      const item = document.createElement("li");
      item.textContent = "此要求未列出額外範圍。";
      ui.scopes.replaceChildren(item);
    }
    consentReady = true;
    ui.consent.hidden = false;
    ui.status.textContent = "請檢查帳號、應用程式與要求範圍，再決定是否同意。";
  }
  async function run(message, operation, failureMessage) {
    if (busy || fatal) return;
    busy = true;
    ui.error.hidden = true;
    ui.status.textContent = message;
    controls();
    try { await operation(); } catch {
      consentReady = false;
      ui.consent.hidden = true;
      error(failureMessage);
      ui.status.textContent = "操作未完成。";
    } finally {
      ui.password.value = "";
      busy = false;
      controls();
    }
  }
  signedOut();
  ui.confirmation.hidden = true;
  ui.error.hidden = true;
  try {
    validateConfig(config);
    authorizationId = parseAuthorizationId(location.search);
    ui.mode.textContent = authorizationId === null ? "測試帳號登入／初次設定" : "ChatGPT 連線授權";
  } catch {
    fatal = true;
    busy = false;
    ui.status.textContent = "目前無法繼續。";
    error("網站設定或授權編號無效，已停用所有操作。請回到對話通知管理者，或從 ChatGPT 重新發起連線。");
    controls();
    return;
  }
  try {
    const client = await createClient(config.supabaseUrl, config.publishableKey, {
      auth: { flowType: "pkce", storageKey: "papaya-work-auth-v1", persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
    auth = client.auth;
    ui["login-form"].addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!ui["login-form"].reportValidity()) return;
      await run("正在驗證登入身分…", async () => {
        const result = await auth.signInWithPassword({ email: ui.email.value.trim(), password: ui.password.value });
        if (result.error) throw new Error("sign-in failed");
        ui.confirmation.hidden = true;
        await refresh();
      }, "登入未完成。請確認電子郵件、密碼及信箱驗證狀態後重試。");
    });
    ui["sign-up"].addEventListener("click", async () => {
      if (authorizationId !== null || !config.allowBootstrapSignup || !ui["login-form"].reportValidity()) return;
      await run("正在建立測試登入帳號…", async () => {
        const result = await auth.signUp({
          email: ui.email.value.trim(), password: ui.password.value,
          options: { emailRedirectTo: emailRedirectUrl(config, authorizationId) },
        });
        if (result.error) throw new Error("sign-up failed");
        if (!result.data?.session) {
          signedOut();
          ui.confirmation.hidden = false;
          ui.status.textContent = "尚未完成登入：請前往信箱，開啟驗證信中的連結。驗證後回到本頁登入。";
          return;
        }
        await refresh();
      }, "建立帳號未完成。請檢查輸入，稍後再試；若已有帳號，請直接登入。");
    });
    for (const decision of ["approve", "deny"]) {
      ui[decision].addEventListener("click", async () => {
        if (!consentReady) return;
        await run(decision === "approve" ? "正在重新驗證身分並送出同意…" : "正在送出拒絕…", async () => {
          const url = await decideAuthorization(auth, authorizationId, config, decision, userId);
          redirect(url);
        }, "授權要求未通過驗證或送出失敗。請重新登入，或從 ChatGPT 重新發起連線。");
      });
    }
    ui.logout.addEventListener("click", async () => {
      await run("正在登出…", async () => {
        const result = await auth.signOut();
        if (result.error) throw new Error("sign-out failed");
        signedOut();
        ui.status.textContent = "已登出。";
      }, "登出未完成，請稍後再試。");
    });
    auth.onAuthStateChange((event) => {
      // Never await Auth calls inside this SDK callback; it holds the session lock.
      if (event === "SIGNED_OUT") { signedOut(); return; }
      if (!busy && (event === "SIGNED_IN" || event === "TOKEN_REFRESHED")) {
        void run("正在重新驗證登入狀態…", refresh, "登入或授權驗證未完成，請重新登入。");
      }
    });
    await refresh();
  } catch {
    consentReady = false;
    ui.consent.hidden = true;
    error("登入服務或授權要求未通過驗證。請稍後重試，或從 ChatGPT 重新發起連線。");
    ui.status.textContent = "目前無法完成連線。";
    if (!auth) fatal = true;
  } finally {
    busy = false;
    controls();
  }
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  void mountApp({
    document, location: window.location, config: window.WORK_OAUTH_CONFIG,
    createClient: async (...args) => {
      const { createClient } = await import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.108.2/+esm");
      return createClient(...args);
    },
  });
}
