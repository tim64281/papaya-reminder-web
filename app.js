// web/app.js
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createSpeechEndDetector, formatReminderRow, pickConfirmationOutcome } from "./logic.js?v=20260930a";

const APP_VERSION = "20260930a";
const SUPABASE_URL = "https://lgercluzqbxlcjbdhkcw.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_YzWeHCfTap6N6LALQhddkA_HQV0QwSx";
const FIXED_LOGIN_EMAIL = "papaya@papaya-reminder.local";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const el = (id) => document.getElementById(id);

function setStatus(text) {
  el("conversation-status").textContent = text;
}

// Anything that slips past the handlers below still shows up on screen,
// since the user has no console on their phone.
window.addEventListener("error", (e) => setStatus(`發生未預期的錯誤:${e.error?.message ?? e.message}`));
window.addEventListener("unhandledrejection", (e) => setStatus(`發生未預期的錯誤:${e.reason?.message ?? e.reason}`));

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
  endConversation();
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
    const text = document.createElement("span");
    text.textContent = `${row.text} `;
    const status = document.createElement("span");
    status.className = row.statusClass;
    status.textContent = `(${row.statusLabel})`;
    li.append(text, status);
    list.appendChild(li);
  }
}

// ---------- Talking to the edge functions ----------

async function callFunction(name, body) {
  const { data: { session } } = await supabase.auth.getSession();
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session?.access_token ?? SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify(body),
  });
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(`伺服器回應格式錯誤 (${res.status})`);
  }
  if (!res.ok || data.error) {
    throw new Error(data.error ?? data.message ?? `伺服器錯誤 (${res.status})`);
  }
  return data;
}

// ---------- Voice ----------
//
// Speech-to-text normally uses the phone's own recognizer (on iPhone this is
// Siri dictation), which shows words as they are spoken and costs no AI quota.
// If the recognizer is missing or refuses to run, we fall back for the rest
// of the session to recording audio and having Gemini transcribe it, with
// end of speech detected locally from microphone loudness.

let audioCtx = null;
let currentUtterance = null; // iOS drops onend if the utterance is garbage-collected
let activeRecording = null;
let activeRecognition = null;
let speechRecognitionBroken = false;
let conversationActive = false;

const RECOGNIZER_FAILURES = new Set([
  "not-allowed",
  "service-not-allowed",
  "network",
  "audio-capture",
  "language-not-supported",
]);

function getRecognizer() {
  return window.SpeechRecognition || window.webkitSpeechRecognition;
}

// Resolves with the recognised text ("" if nothing was said) or null if
// cancelled; rejects if the recognizer itself can't work on this device.
function recognizeSpeech(onPartial) {
  return new Promise((resolve, reject) => {
    const Recognizer = getRecognizer();
    const rec = new Recognizer();
    rec.lang = "zh-TW";
    rec.interimResults = true;
    rec.continuous = false;
    rec.maxAlternatives = 1;

    let latestText = "";
    let cancelled = false;
    let failure = null;
    // Some iPhones never end on their own when nobody speaks.
    const noSpeechTimer = setTimeout(() => latestText || rec.stop(), 8000);
    const maxTimer = setTimeout(() => rec.stop(), 20000);

    rec.onresult = (event) => {
      let text = "";
      for (let i = 0; i < event.results.length; i++) text += event.results[i][0].transcript;
      latestText = text;
      onPartial(text);
    };
    rec.onerror = (event) => {
      if (RECOGNIZER_FAILURES.has(event.error)) failure = event.error;
    };
    rec.onend = () => {
      clearTimeout(noSpeechTimer);
      clearTimeout(maxTimer);
      activeRecognition = null;
      if (cancelled) resolve(null);
      else if (failure) reject(new Error(failure));
      else resolve(latestText.trim());
    };

    activeRecognition = {
      sendNow: () => rec.stop(),
      cancel: () => {
        cancelled = true;
        rec.abort();
      },
    };
    try {
      rec.start();
    } catch (err) {
      clearTimeout(noSpeechTimer);
      clearTimeout(maxTimer);
      activeRecognition = null;
      reject(err);
    }
  });
}

// Must run synchronously inside the tap handler: iOS only lets audio start from a user gesture.
let speechUnlocked = false;

function unlockAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state !== "running") audioCtx.resume();
  // iOS only lets speechSynthesis start from a tap; a silent utterance here
  // lets the later spoken confirmations play after async work.
  if (!speechUnlocked && "speechSynthesis" in window) {
    const silent = new SpeechSynthesisUtterance(" ");
    silent.volume = 0;
    speechSynthesis.speak(silent);
    speechUnlocked = true;
  }
}

function speak(text) {
  return new Promise((resolve) => {
    if (!text || !("speechSynthesis" in window)) return resolve();
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = "zh-TW";
    // Fallback in case the browser never fires onend (seen on iOS and in some desktop browsers).
    const timer = setTimeout(done, 2000 + text.length * 400);
    function done() {
      clearTimeout(timer);
      resolve();
    }
    utter.onend = done;
    utter.onerror = done;
    currentUtterance = utter;
    speechSynthesis.speak(utter);
  });
}

function pickRecorderMimeType() {
  for (const type of ["audio/mp4", "audio/webm;codecs=opus", "audio/webm", "audio/ogg"]) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return "";
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(new Error("讀取錄音失敗"));
    reader.readAsDataURL(blob);
  });
}

// Records one utterance. Resolves with { outcome, blob, mimeType } where
// outcome is "speech" (user talked, or tapped to send), "no-speech" or "cancelled".
async function recordUtterance() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    throw new Error("這個瀏覽器不支援錄音,請改用手機的 Safari 或 Chrome");
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    throw new Error(`無法使用麥克風,請允許麥克風權限(${err.message})`);
  }

  unlockAudio();
  const source = audioCtx.createMediaStreamSource(stream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);
  const floatSamples = new Float32Array(analyser.fftSize);
  const byteSamples = new Uint8Array(analyser.fftSize);
  const readLevel = () => {
    let sum = 0;
    if (analyser.getFloatTimeDomainData) {
      analyser.getFloatTimeDomainData(floatSamples);
      for (const v of floatSamples) sum += v * v;
    } else {
      analyser.getByteTimeDomainData(byteSamples);
      for (const s of byteSamples) sum += ((s - 128) / 128) ** 2;
    }
    return Math.sqrt(sum / analyser.fftSize);
  };
  const detect = createSpeechEndDetector();
  let peakLevel = 0;

  const preferred = pickRecorderMimeType();
  const recorder = preferred ? new MediaRecorder(stream, { mimeType: preferred }) : new MediaRecorder(stream);
  const chunks = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  return new Promise((resolve, reject) => {
    let outcome = null;
    const timer = setInterval(() => {
      const level = readLevel();
      peakLevel = Math.max(peakLevel, level);
      const state = detect(level, performance.now());
      if (state === "done") finish("speech");
      // If the loudness meter never saw any signal, it isn't working on this
      // device; send the audio anyway and let the AI decide instead of
      // wrongly claiming the user said nothing.
      else if (state === "no-speech") finish(peakLevel > 0.0001 ? "no-speech" : "speech");
    }, 100);

    function finish(result) {
      if (outcome) return;
      outcome = result;
      clearInterval(timer);
      if (recorder.state !== "inactive") recorder.stop();
    }

    recorder.onstop = () => {
      source.disconnect();
      stream.getTracks().forEach((track) => track.stop());
      activeRecording = null;
      const mimeType = (recorder.mimeType || preferred || "audio/mp4").split(";")[0];
      resolve({ outcome, blob: new Blob(chunks, { type: mimeType }), mimeType });
    };
    recorder.onerror = (e) => {
      clearInterval(timer);
      stream.getTracks().forEach((track) => track.stop());
      activeRecording = null;
      reject(new Error(`錄音失敗:${e.error?.message ?? "未知錯誤"}`));
    };

    activeRecording = {
      sendNow: () => finish("speech"),
      cancel: () => finish("cancelled"),
    };
    recorder.start();
  });
}

// ---------- Conversation ----------

el("mic-button").addEventListener("click", () => {
  unlockAudio();
  const listening = activeRecognition ?? activeRecording;
  if (listening) {
    listening.sendNow();
    return;
  }
  if (conversationActive) {
    endConversation("已結束對話");
    return;
  }
  runConversation().catch((err) => {
    endConversation(`發生錯誤:${err.message}`);
  });
});

function endConversation(message) {
  conversationActive = false;
  activeRecognition?.cancel();
  activeRecording?.cancel();
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  el("mic-button").classList.remove("listening");
  if (message !== undefined) setStatus(message);
}

// Resolves with { silent: true }, { text } from the phone's recognizer,
// { audioBase64, mimeType } from the recording fallback, or null if cancelled.
async function listen(prompt) {
  // Let the speaker fall quiet first so the AI's own voice isn't picked up.
  await new Promise((resolve) => setTimeout(resolve, 300));
  if (!conversationActive) return null;
  setStatus(prompt);

  if (getRecognizer() && !speechRecognitionBroken) {
    try {
      const text = await recognizeSpeech((partial) => setStatus(`你說:「${partial}」`));
      if (!conversationActive || text === null) return null;
      if (!text) return { silent: true };
      setStatus(`你說:「${text}」,思考中…`);
      return { silent: false, text };
    } catch {
      speechRecognitionBroken = true;
      if (!conversationActive) return null;
      setStatus(prompt);
    }
  }

  const recording = await recordUtterance();
  if (!conversationActive || recording.outcome === "cancelled") return null;
  if (recording.outcome === "no-speech") return { silent: true };
  setStatus("思考中…");
  return { silent: false, audioBase64: await blobToBase64(recording.blob), mimeType: recording.mimeType };
}

async function runConversation() {
  conversationActive = true;
  el("mic-button").classList.add("listening");
  let silentTries = 0;
  for (let round = 0; round < 5 && conversationActive; round++) {
    const heard = await listen("聆聽中…說完會自動送出(也可以再按一次麥克風送出)");
    if (!heard) return;
    if (heard.silent) {
      if (++silentTries >= 2) break;
      await speak("我沒聽到聲音,可以再說一次嗎?");
      continue;
    }

    const speech = heard.text !== undefined
      ? { text: heard.text }
      : { audioBase64: heard.audioBase64, mimeType: heard.mimeType };
    const parsed = await callFunction("parse-reminder", { ...speech, contacts: await namedContacts() });
    if (!conversationActive) return;
    if (parsed.transcript) setStatus(`你說:「${parsed.transcript}」`);

    await speak(parsed.confirmationText);
    if (!conversationActive) return;
    if (parsed.unknownContactName) {
      endConversation(parsed.confirmationText);
      return;
    }
    if (parsed.needsClarification) continue;

    const decision = await askForConfirmation();
    if (!conversationActive) return;
    if (decision === "confirm") {
      if (parsed.intent === "morning_image") {
        await sendMorningImageNow();
        await speak("好的,已經幫您發送早安圖了。");
        endConversation("已發送早安圖 ✅");
      } else {
        await saveReminder(parsed);
        await refreshReminderList();
        await speak("好的,已經幫您建立提醒了。");
        endConversation("已建立提醒 ✅");
      }
      return;
    }
    if (decision === "reject") {
      await speak("好的,請再說一次。");
      continue;
    }
    await speak("沒關係,需要時再按麥克風叫我。");
    endConversation("");
    return;
  }
  if (conversationActive) {
    endConversation(silentTries >= 2 ? "沒有聽到聲音,需要時再按麥克風" : "需要時再按麥克風叫我");
  }
}

async function askForConfirmation() {
  for (let attempt = 0; attempt < 2; attempt++) {
    const heard = await listen("請說「對」或「不對」");
    if (!heard) return null;
    if (!heard.silent) {
      const transcript = heard.text ??
        (await callFunction("transcribe", { audioBase64: heard.audioBase64, mimeType: heard.mimeType })).transcript;
      const outcome = pickConfirmationOutcome(transcript);
      if (outcome !== "unclear") return outcome;
    }
    if (!conversationActive) return null;
    if (attempt === 0) await speak("請說對,或是不對。");
  }
  return null;
}

async function namedContacts() {
  const { data, error } = await supabase
    .from("contacts")
    .select("id, display_name")
    .eq("is_self", false)
    .not("display_name", "is", null);
  if (error) throw new Error(`讀取聯絡人失敗:${error.message}`);
  return data;
}

async function sendMorningImageNow() {
  await callFunction("morning-image", {});
}

async function saveReminder(parsed) {
  let targetId = parsed.targetContactId;
  if (!targetId) {
    const { data: self, error } = await supabase.from("contacts").select("id").eq("is_self", true).maybeSingle();
    if (error) throw new Error(`讀取聯絡人失敗:${error.message}`);
    if (!self) throw new Error("找不到「我自己」的 LINE 帳號,請先掃 QR code 加官方帳號好友");
    targetId = self.id;
  }
  const { error } = await supabase.from("reminders").insert({
    target_contact_id: targetId,
    message: parsed.message,
    remind_at: parsed.remindAtIso,
  });
  if (error) throw new Error(`儲存提醒失敗:${error.message}`);
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

el("app-version").textContent = `版本 ${APP_VERSION}`;

// An earlier release installed a cache-first service worker that kept serving
// stale code; remove any leftover registration so updates always show up.
navigator.serviceWorker?.getRegistrations().then((regs) => regs.forEach((r) => r.unregister()));

const { data: { session } } = await supabase.auth.getSession();
if (session) {
  showMain();
}
