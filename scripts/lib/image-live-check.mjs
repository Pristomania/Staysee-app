// Helpers for scripts/image-attachments-live-check.mjs: reading a test picture and printing the cost table that
// is compared with the OpenRouter dashboard. The table holds numbers only, never pictures or descriptions.

/** Same budget as the server (supabase/functions/_shared/imageAttachments.ts MAX_IMAGE_BASE64_CHARS). */
export const MAX_PICTURE_BASE64_CHARS = 1_000_000;

function sniffMime(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  const text = (from, to) => Buffer.from(bytes.slice(from, to)).toString("latin1");
  if (text(0, 4) === "RIFF" && text(8, 12) === "WEBP") return "image/webp";
  return null;
}

export function pictureFromBytes(name, bytes) {
  const mime = sniffMime(bytes);
  if (!mime) throw new Error(`${name}: not a JPEG, PNG or WebP picture`);
  const data = Buffer.from(bytes).toString("base64");
  if (data.length > MAX_PICTURE_BASE64_CHARS) {
    throw new Error(`${name}: too big (${data.length} base64 characters, the limit is ${MAX_PICTURE_BASE64_CHARS})`);
  }
  return { mime, data };
}

const pad = (value, width) => String(value).padEnd(width);
const padLeft = (value, width) => String(value).padStart(width);

/** One line per recorded call (time in UTC) and the sum, for the comparison with the dashboard. */
export function formatCostTable(rows) {
  if (rows.length === 0) return "(no calls recorded in this window)";
  const lines = [
    `${pad("time (UTC)", 10)}  ${pad("what", 18)}  ${pad("model", 28)}  ${padLeft("in", 7)}  ${padLeft("out", 6)}  ${padLeft("USD", 10)}`,
  ];
  let total = 0;
  for (const row of rows) {
    const cost = Number(row.cost) || 0;
    total += cost;
    lines.push(
      `${pad(new Date(row.created_at).toISOString().slice(11, 19), 10)}  ${pad(row.call_kind ?? "chat", 18)}  ${pad(row.model ?? "", 28)}  ${padLeft(row.prompt_tokens ?? 0, 7)}  ${padLeft(row.completion_tokens ?? 0, 6)}  ${padLeft(cost.toFixed(6), 10)}`,
    );
  }
  lines.push(`TOTAL ${rows.length} calls: ${total.toFixed(6)} USD`);
  return lines.join("\n");
}

/** The minutes to look at in the dashboard (Activity), in UTC and in this computer's time. */
export function costWindow(startMs, endMs) {
  const utc = (ms) => new Date(ms).toISOString().slice(11, 19);
  const local = (ms) => new Date(ms).toLocaleTimeString("ru-RU");
  return `OpenRouter dashboard window: ${utc(startMs)} to ${utc(endMs)} UTC (${local(startMs)} to ${local(endMs)} local)`;
}
