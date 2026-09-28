// web/app.js
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { pickConfirmationOutcome, formatReminderRow } from "./logic.js";

const SUPABASE_URL = "https://lgercluzqbxlcjbdhkcw.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_YzWeHCfTap6N6LALQhddkA_HQV0QwSx";
const FIXED_LOGIN_EMAIL = "papaya@papaya-reminder.local";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const el = (id) => document.getElementById(id);

// ---------- Auth ----------

el("login-button").addEventListener("click", async () => {
  const password = el("password-input").value;
  const { error } = await supabase.auth.signInWithPassword({
    email: FIXED_LOGIN_EMAIL,
    password,
  });
  if (error) {
    el("login-error").hidden = false;
    return;
  }
  el("login-error").hidden = true;
  showMain();
});

el("logout-button").addEventListener("click", async () => {
  await supabase.auth.signOut();
  el("main-screen").hidden = true;
  el("login-screen").hidden = false;
});

async function showMain() {
  el("login-screen").hidden = true;
  el("main-screen").hidden = false;
  await refreshReminderList();
}

// ---------- Reminder list ----------

async function refreshReminderList() {
  const { data, error } = await supabase
    .from("reminders")
    .select("id, message, remind_at, status, contacts(display_name)")
    .order("remind_at", { ascending: true });

  const list = el("reminder-list");
  list.innerHTML = "";
  if (error) {
    list.innerHTML = `<li class="status-failed">讀取提醒列表失敗:${error.message}</li>`;
    return;
  }
  for (const reminder of data) {
    const row = formatReminderRow(reminder);
    const li = document.createElement("li");
    li.innerHTML = `${row.text} <span class="${row.statusClass}">(${row.statusLabel})</span>`;
    list.appendChild(li);
  }
}

// ---------- Voice conversation ----------

const SpeechRecognitionImpl = window.SpeechRecognition || window.webkitSpeechRecognition;

function speak(text) {
  return new Promise((resolve) => {
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = "zh-TW";
    utter.onend = resolve;
    speechSynthesis.speak(utter);
  });
}

function listenOnce() {
  return new Promise((resolve, reject) => {
    if (!SpeechRecognitionImpl) {
      reject(new Error("這個瀏覽器不支援語音辨識,請改用電腦或手機的 Chrome"));
      return;
    }
    const recognition = new SpeechRecognitionImpl();
    recognition.lang = "zh-TW";
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.onresult = (event) => resolve(event.results[0][0].transcript);
    recognition.onerror = (event) => reject(new Error(event.error));
    recognition.start();
  });
}

let conversationActive = false;

el("mic-button").addEventListener("click", async () => {
  if (conversationActive) {
    conversationActive = false;
    el("mic-button").classList.remove("listening");
    el("conversation-status").textContent = "";
    return;
  }
  conversationActive = true;
  el("mic-button").classList.add("listening");
  await runConversation();
  conversationActive = false;
  el("mic-button").classList.remove("listening");
});

async function runConversation() {
  await speak("嗨,Papaya,有什麼我可以幫忙的?");
  await captureAndConfirm();
}

async function captureAndConfirm() {
  el("conversation-status").textContent = "聆聽中...";
  let transcript;
  try {
    transcript = await listenOnce();
  } catch (err) {
    el("conversation-status").textContent = `沒聽清楚:${err.message}`;
    return;
  }
  el("conversation-status").textContent = `你說:${transcript}`;

  const { data: contacts } = await supabase.from("contacts").select("id, display_name").not(
    "display_name",
    "is",
    null,
  );

  const parseRes = await fetch(`${SUPABASE_URL}/functions/v1/parse-reminder`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: transcript,
      contacts: contacts ?? [],
      nowIso: new Date().toISOString(),
    }),
  });
  const parsed = await parseRes.json();
  if (parsed.error) {
    el("conversation-status").textContent = `解析失敗:${parsed.error}`;
    return;
  }

  await speak(parsed.confirmationText);

  if (parsed.needsClarification) {
    await captureAndConfirm();
    return;
  }

  el("conversation-status").textContent = "請說「對」確認,或說「不對」重講";
  let reply;
  try {
    reply = await listenOnce();
  } catch (err) {
    el("conversation-status").textContent = `沒聽清楚:${err.message}`;
    return;
  }

  const outcome = pickConfirmationOutcome(reply);
  if (outcome === "confirm") {
    await saveReminder(parsed);
    await speak("好的,已經幫您建立提醒了。");
    await refreshReminderList();
  } else if (outcome === "reject") {
    await speak("好的,請再說一次。");
    await captureAndConfirm();
  } else {
    el("conversation-status").textContent = `聽不太懂「${reply}」,請說「對」或「不對」`;
  }
}

async function saveReminder(parsed) {
  await supabase.from("reminders").insert({
    target_contact_id: parsed.targetContactId,
    message: parsed.message,
    remind_at: parsed.remindAtIso,
  });
}

// ---------- Contacts screen ----------

el("nav-contacts").addEventListener("click", async () => {
  el("main-screen").hidden = true;
  el("contacts-screen").hidden = false;
  await refreshContactsList();
});

el("back-to-main").addEventListener("click", () => {
  el("contacts-screen").hidden = true;
  el("main-screen").hidden = false;
});

async function refreshContactsList() {
  const { data, error } = await supabase.from("contacts").select("id, display_name, is_self");
  const list = el("contacts-list");
  list.innerHTML = "";
  if (error) {
    list.innerHTML = `<li class="status-failed">讀取聯絡人失敗:${error.message}</li>`;
    return;
  }
  for (const contact of data) {
    const li = document.createElement("li");
    if (contact.display_name) {
      li.textContent = contact.is_self ? `${contact.display_name}(我自己)` : contact.display_name;
    } else {
      const input = document.createElement("input");
      input.placeholder = "偵測到新朋友,幫他取個名字";
      const button = document.createElement("button");
      button.textContent = "儲存";
      button.addEventListener("click", async () => {
        await supabase.from("contacts").update({ display_name: input.value }).eq("id", contact.id);
        await refreshContactsList();
      });
      li.appendChild(input);
      li.appendChild(button);
    }
    list.appendChild(li);
  }
}

// ---------- Boot ----------

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./service-worker.js");
}

const { data: { session } } = await supabase.auth.getSession();
if (session) {
  showMain();
}
