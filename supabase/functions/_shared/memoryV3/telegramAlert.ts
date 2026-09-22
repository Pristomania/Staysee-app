export type MemoryV3TelegramAlertPath = "read" | "write";

export type MemoryV3TelegramAlertDiagnostic =
  | "load_failed"
  | "invalid_shape"
  | "too_large"
  | "invalid_source"
  | "state_too_large"
  | "extractor_transport_failed"
  | "extractor_parse_invalid"
  | "extractor_shape_invalid"
  | "extractor_contract_invalid"
  | "reconciler_request_too_large"
  | "reconciler_transport_failed"
  | "reconciler_parse_invalid"
  | "reconciler_shape_invalid"
  | "reconciler_contract_invalid"
  | "state_conflict"
  | "state_write_failed"
  | "reservation_failed"
  | "unknown_failure";

export interface MemoryV3TelegramAlertOptions {
  botToken: string | null | undefined;
  chatId: string | null | undefined;
  path: MemoryV3TelegramAlertPath;
  diagnosticCode: MemoryV3TelegramAlertDiagnostic;
  reserveAlertKey: (key: string) => Promise<boolean>;
  fetchImpl: (
    url: string,
    init: {
      method: "POST";
      headers: Record<string, string>;
      body: string;
    },
  ) => Promise<unknown>;
}

const OPTION_FIELDS = new Set([
  "botToken",
  "chatId",
  "path",
  "diagnosticCode",
  "reserveAlertKey",
  "fetchImpl",
]);
const BOT_TOKEN = /^\d{5,20}:[A-Za-z0-9_-]{20,100}$/;
const CHAT_ID = /^-?[1-9]\d{0,19}$/;
const READ_DIAGNOSTICS = new Set<MemoryV3TelegramAlertDiagnostic>([
  "load_failed",
  "invalid_shape",
  "too_large",
]);
const WRITE_DIAGNOSTICS = new Set<MemoryV3TelegramAlertDiagnostic>([
  "invalid_source",
  "state_too_large",
  "extractor_transport_failed",
  "extractor_parse_invalid",
  "extractor_shape_invalid",
  "extractor_contract_invalid",
  "reconciler_request_too_large",
  "reconciler_transport_failed",
  "reconciler_parse_invalid",
  "reconciler_shape_invalid",
  "reconciler_contract_invalid",
  "state_conflict",
  "state_write_failed",
  "reservation_failed",
  "unknown_failure",
]);

type ProjectedOptions = {
  botToken: unknown;
  chatId: unknown;
  path: unknown;
  diagnosticCode: unknown;
  reserveAlertKey: unknown;
  fetchImpl: unknown;
};

function inspectOptions(value: unknown): ProjectedOptions | null {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return null;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== OPTION_FIELDS.size) return null;
    const projected: Record<string, unknown> = {};
    for (const key of keys) {
      if (typeof key !== "string" || !OPTION_FIELDS.has(key)) return null;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
        return null;
      }
      projected[key] = descriptor.value;
    }
    for (const field of OPTION_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(projected, field)) return null;
    }
    return projected as ProjectedOptions;
  } catch {
    return null;
  }
}

function isClosedDiagnostic(
  path: unknown,
  diagnosticCode: unknown,
): diagnosticCode is MemoryV3TelegramAlertDiagnostic {
  if (typeof diagnosticCode !== "string") return false;
  if (path === "read") {
    return READ_DIAGNOSTICS.has(
      diagnosticCode as MemoryV3TelegramAlertDiagnostic,
    );
  }
  if (path === "write") {
    return WRITE_DIAGNOSTICS.has(
      diagnosticCode as MemoryV3TelegramAlertDiagnostic,
    );
  }
  return false;
}

export async function sendMemoryV3TelegramAlertSafely(
  optionsValue: MemoryV3TelegramAlertOptions,
): Promise<void> {
  const options = inspectOptions(optionsValue);
  if (options === null) return;
  if (typeof options.botToken !== "string" || !BOT_TOKEN.test(options.botToken)) {
    return;
  }
  if (typeof options.chatId !== "string" || !CHAT_ID.test(options.chatId)) {
    return;
  }
  if (!isClosedDiagnostic(options.path, options.diagnosticCode)) return;
  if (
    typeof options.reserveAlertKey !== "function" ||
    typeof options.fetchImpl !== "function"
  ) {
    return;
  }

  const path = options.path as MemoryV3TelegramAlertPath;
  const diagnosticCode = options.diagnosticCode;
  const alertKey = `${path}:${diagnosticCode}`;
  try {
    const reserved = await options.reserveAlertKey(alertKey);
    if (reserved !== true) return;
    const text = [
      "⚠️ StaySEE Memory V3",
      `Path: ${path}`,
      `Code: ${diagnosticCode}`,
      `Time: ${new Date().toISOString()}`,
    ].join("\n");
    await options.fetchImpl(
      `https://api.telegram.org/bot${options.botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: options.chatId, text }),
      },
    );
  } catch {
    // Operator alerting is best-effort and must never affect the reply path.
  }
}
