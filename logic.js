const YES_WORDS = ["對", "对", "是", "好", "沒錯", "没错", "嗯對", "OK", "ok"];
const NO_WORDS = ["不對", "不对", "不是", "錯", "错", "重講", "重讲"];

// Separate negations (with "不") and check them first to avoid substring conflicts
const NEGATIONS = ["不對", "不对", "不是", "重講", "重讲"];
const NO_WORDS_SIMPLE = ["錯", "错"];

// Sort by length descending so longer phrases match before single characters
const YES_WORDS_SORTED = [...YES_WORDS].sort((a, b) => b.length - a.length);

export function pickConfirmationOutcome(transcript) {
  const t = transcript.trim();
  // Check negations first (phrases with "不" prefix)
  if (NEGATIONS.some((w) => t.includes(w))) return "reject";
  // Then check YES_WORDS (includes "没错" which contains "错")
  if (YES_WORDS_SORTED.some((w) => t.includes(w))) return "confirm";
  // Finally check remaining NO_WORDS
  if (NO_WORDS_SIMPLE.some((w) => t.includes(w))) return "reject";
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
