// Negations are checked first: "不好" contains "好" and "不是" contains "是".
const NEGATIONS = ["不對", "不对", "不是", "不好", "不要", "重講", "重讲", "錯", "错"];
// "沒錯" contains "錯", so the yes check for it must come before the negation check.
const YES_OVERRIDES = ["沒錯", "没错"];
const YES_WORDS = ["對", "对", "是", "好", "OK", "ok", "可以"];

export function pickConfirmationOutcome(transcript) {
  const t = transcript.trim();
  if (YES_OVERRIDES.some((w) => t.includes(w))) return "confirm";
  if (NEGATIONS.some((w) => t.includes(w))) return "reject";
  if (YES_WORDS.some((w) => t.includes(w))) return "confirm";
  return "unclear";
}

const STATUS_LABELS = {
  pending: { label: "待發送", cls: "status-pending" },
  sent: { label: "已送出", cls: "status-sent" },
  failed: { label: "發送失敗", cls: "status-failed" },
};

export function formatReminderRow(reminder) {
  const who = reminder.contacts?.display_name ?? "我自己";
  const when = new Date(reminder.remind_at).toLocaleString("zh-TW", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const { label, cls } = STATUS_LABELS[reminder.status];
  return {
    text: `${when} 提醒 ${who}:${reminder.message}`,
    statusLabel: label,
    statusClass: cls,
  };
}

// Decides when the user has finished talking, from a stream of microphone
// loudness samples (RMS, 0..1). Returns "listening", "done" or "no-speech".
// The first calibrationMs of samples estimate background noise; the speech
// threshold is capped so a user who starts talking immediately is still heard.
export function createSpeechEndDetector({
  silenceMs = 1500,
  noSpeechTimeoutMs = 8000,
  maxMs = 20000,
  calibrationMs = 300,
  minThreshold = 0.015,
  maxThreshold = 0.06,
  noiseFactor = 3,
} = {}) {
  let startedAt = null;
  let noiseSum = 0;
  let noiseCount = 0;
  let threshold = null;
  let heardSpeech = false;
  let lastSpeechAt = 0;

  return function update(level, now) {
    if (startedAt === null) startedAt = now;
    const elapsed = now - startedAt;

    if (elapsed >= maxMs) return heardSpeech ? "done" : "no-speech";

    if (elapsed < calibrationMs) {
      noiseSum += level;
      noiseCount += 1;
      return "listening";
    }
    if (threshold === null) {
      const noise = noiseCount ? noiseSum / noiseCount : 0;
      threshold = Math.min(maxThreshold, Math.max(minThreshold, noise * noiseFactor));
    }

    if (level >= threshold) {
      heardSpeech = true;
      lastSpeechAt = now;
      return "listening";
    }
    if (heardSpeech && now - lastSpeechAt >= silenceMs) return "done";
    if (!heardSpeech && elapsed >= noSpeechTimeoutMs) return "no-speech";
    return "listening";
  };
}
