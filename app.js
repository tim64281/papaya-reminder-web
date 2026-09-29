// web/app.js
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { pickConfirmationOutcome, formatReminderRow } from "./logic.js";

const SUPABASE_URL = "https://lgercluzqbxlcjbdhkcw.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_YzWeHCfTap6N6LALQhddkA_HQV0QwSx";
const FIXED_LOGIN_EMAIL = "papaya@papaya-reminder.local";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const el = (id) => document.getElementById(id);

// Safety net: surface any otherwise-silent error on screen instead of it
// just vanishing into the console (which the user has no way to see on
// their phone).
function showFatalError(err) {
  const status = el("conversation-status");
  if (status) status.textContent = `發生未預期的錯誤:${err?.message ?? err}`;
  console.error(err);
}
window.addEventListener("error", (e) => showFatalError(e.error ?? e.message));
window.addEventListener("unhandledrejection", (e) => showFatalError(e.reason));

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
//
// iOS Safari has never implemented the Web Speech API's SpeechRecognition
// (speech-to-text), only speechSynthesis (text-to-speech). Since this app
// must work on iPhone, speech-to-text is done by recording audio with
// MediaRecorder (supported on iOS Safari 14.3+) and sending the clip to
// Gemini for understanding, instead of relying on browser speech
// recognition.

function speak(text) {
  return new Promise((resolve) => {
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = "zh-TW";
    utter.onend = resolve;
    speechSynthesis.speak(utter);
  });
}

function pickSupportedMimeType() {
  const candidates = ["audio/mp4", "audio/webm", "audio/ogg"];
  for (const type of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(type)) return type;
  }
  return "";
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result.split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

let activeRecorder = null;

// Starts recording immediately and returns a promise that resolves with
// { blob, mimeType } once stopRecording() is called.
async function startRecording() {
  if (!navigator.mediaDevices || !window.MediaRecorder) {
    throw new Error("這個瀏覽器不支援錄音功能");
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mimeType = pickSupportedMimeType();
  const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
  const chunks = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  const stopped = new Promise((resolve) => {
    recorder.onstop = () => {
      stream.getTracks().forEach((track) => track.stop());
      const blob = new Blob(chunks, { type: recorder.mimeType });
      resolve({ blob, mimeType: recorder.mimeType });
    };
  });

  recorder.start();
  activeRecorder = recorder;
  return stopped;
}

function stopRecording() {
  if (activeRecorder && activeRecorder.state !== "inactive") {
    activeRecorder.stop();
  }
  activeRecorder = null;
}

async function authHeaders() {
  const { data: { session } } = await supabase.auth.getSession();
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${session?.access_token ?? SUPABASE_ANON_KEY}`,
  };
}

async function transcribeAudio(blob, mimeType) {
  const audioBase64 = await blobToBase64(blob);
  const res = await fetch(`${SUPABASE_URL}/functions/v1/transcribe`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({ audioBase64, mimeType }),
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error ?? data.message ?? String(res.status));
  return data.transcript;
}

// phase: 'idle' | 'awaiting-request' | 'awaiting-confirmation'
let phase = "idle";
let pendingParsed = null;
let currentRecordingPromise = null;

el("mic-button").addEventListener("click", async () => {
  try {
    if (phase === "idle") {
      await beginConversation();
    } else if (phase === "awaiting-request") {
      await finishRequestRecording();
    } else if (phase === "awaiting-confirmation") {
      await finishConfirmationRecording();
    }
  } catch (err) {
    el("conversation-status").textContent = `發生錯誤:${err.message}`;
    console.error(err);
    resetConversation();
  }
});

async function beginConversation() {
  el("mic-button").classList.add("listening");
  await speak("嗨,Papaya,有什麼我可以幫忙的?");
  await beginRequestRecording();
}

async function beginRequestRecording() {
  el("conversation-status").textContent = "錄音中,說完後再按一次麥克風";
  try {
    currentRecordingPromise = await startRecording();
    phase = "awaiting-request";
  } catch (err) {
    el("conversation-status").textContent = `無法錄音:${err.message}`;
    resetConversation();
  }
}

async function finishRequestRecording() {
  el("conversation-status").textContent = "處理中...";
  stopRecording();
  const result = await currentRecordingPromise;
  phase = "idle";

  const { data: contacts } = await supabase.from("contacts").select("id, display_name").not(
    "display_name",
    "is",
    null,
  );

  const audioBase64 = await blobToBase64(result.blob);
  const parseRes = await fetch(`${SUPABASE_URL}/functions/v1/parse-reminder`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({
      audioBase64,
      mimeType: result.mimeType,
      contacts: contacts ?? [],
      nowIso: new Date().toISOString(),
    }),
  });
  const parsed = await parseRes.json();
  if (!parseRes.ok || parsed.error) {
    el("conversation-status").textContent = `解析失敗:${parsed.error ?? parsed.message ?? parseRes.status}`;
    resetConversation();
    return;
  }

  await speak(parsed.confirmationText);

  if (parsed.needsClarification) {
    await beginRequestRecording();
    return;
  }

  pendingParsed = parsed;
  el("conversation-status").textContent = "請說「對」確認,或說「不對」重講(再按一次麥克風結束錄音)";
  currentRecordingPromise = startRecording();
  phase = "awaiting-confirmation";
}

async function finishConfirmationRecording() {
  el("conversation-status").textContent = "處理中...";
  stopRecording();
  const result = await currentRecordingPromise;
  phase = "idle";
  el("mic-button").classList.remove("listening");

  let reply;
  try {
    reply = await transcribeAudio(result.blob, result.mimeType);
  } catch (err) {
    el("conversation-status").textContent = `沒聽清楚:${err.message}`;
    resetConversation();
    return;
  }

  const outcome = pickConfirmationOutcome(reply);
  if (outcome === "confirm") {
    await saveReminder(pendingParsed);
    await speak("好的,已經幫您建立提醒了。");
    await refreshReminderList();
    resetConversation();
  } else if (outcome === "reject") {
    await speak("好的,請再說一次。");
    el("mic-button").classList.add("listening");
    await beginRequestRecording();
  } else {
    el("conversation-status").textContent = `聽不太懂「${reply}」,請說「對」或「不對」`;
    resetConversation();
  }
}

function resetConversation() {
  phase = "idle";
  pendingParsed = null;
  currentRecordingPromise = null;
  el("mic-button").classList.remove("listening");
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
