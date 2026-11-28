import { deliverToOwner, ownerAlertMailer, type OwnerMailer } from "../ownerAlert.ts";

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
  | "unknown_failure"
  | "forced_skip";

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
  /** The letter to the owner; by default from the settings of the function, null when it is switched off. */
  mailer?: OwnerMailer | null;
}

const OPTION_FIELDS = new Set([
  "botToken",
  "chatId",
  "path",
  "diagnosticCode",
  "reserveAlertKey",
  "fetchImpl",
]);
const OPTIONAL_FIELDS = new Set(["mailer"]);
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
  "forced_skip",
]);

/**
 * What each code means, in plain words, so that the alert explains itself. Fixed texts: nothing of a conversation, a person or
 * a message goes into them (the test of this file checks that no identifier reaches the alert).
 */
const MEANING: Record<MemoryV3TelegramAlertDiagnostic, string> = {
  load_failed: "память не смогла прочитать сохранённое о человеке (сбой чтения базы).",
  invalid_shape: "прочитанное из базы оказалось в неожиданном виде и не было использовано.",
  too_large: "прочитанного оказалось слишком много, и оно не было использовано.",
  invalid_source:
    "память не нашла сообщений беседы для чтения или они в неверном виде. Бывает, если ответ был, а сообщения не сохранили (в проверках, которые сообщения не записывают, это ожидаемо).",
  state_too_large: "накопленное состояние памяти слишком велико, запись остановлена.",
  extractor_transport_failed: "запрос к модели, которая выбирает факты из беседы, не дошёл (сеть или отказ хоста).",
  extractor_parse_invalid: "модель выбора фактов ответила так, что ответ нельзя разобрать.",
  extractor_shape_invalid: "модель выбора фактов вернула данные неверной формы.",
  extractor_contract_invalid: "модель выбора фактов нарушила договорённый формат.",
  reconciler_request_too_large: "запрос на сведение фактов получился слишком большим.",
  reconciler_transport_failed: "запрос к модели, которая сводит факты, не дошёл (сеть или отказ хоста).",
  reconciler_parse_invalid: "модель сведения фактов ответила так, что ответ нельзя разобрать.",
  reconciler_shape_invalid: "модель сведения фактов вернула данные неверной формы.",
  reconciler_contract_invalid: "модель сведения фактов нарушила договорённый формат.",
  state_conflict: "две записи памяти пересеклись одновременно, вторая не прошла.",
  state_write_failed: "запись в память не удалась (сбой базы).",
  reservation_failed: "не удалось занять очередь на запись памяти.",
  unknown_failure: "неизвестный сбой записи памяти.",
  forced_skip: "память пропустила одно сообщение, чтобы не застрять на нём.",
};

type ProjectedOptions = {
  botToken: unknown;
  chatId: unknown;
  path: unknown;
  diagnosticCode: unknown;
  reserveAlertKey: unknown;
  fetchImpl: unknown;
  mailer?: unknown;
};

function inspectOptions(value: unknown): ProjectedOptions | null {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return null;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(value);
    const projected: Record<string, unknown> = {};
    for (const key of keys) {
      if (typeof key !== "string" || !(OPTION_FIELDS.has(key) || OPTIONAL_FIELDS.has(key))) return null;
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
  const telegram = typeof options.botToken === "string" && BOT_TOKEN.test(options.botToken) &&
    typeof options.chatId === "string" && CHAT_ID.test(options.chatId);
  const mailer = options.mailer === undefined
    ? ownerAlertMailer()
    : typeof options.mailer === "function" ? options.mailer as OwnerMailer : null;
  if (!telegram && !mailer) return;
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
      `Что это: ${MEANING[diagnosticCode]}`,
    ].join("\n");
    const fetchImpl = options.fetchImpl as MemoryV3TelegramAlertOptions["fetchImpl"];
    const channels: Array<() => Promise<unknown>> = [];
    if (telegram) {
      channels.push(() =>
        fetchImpl(`https://api.telegram.org/bot${options.botToken}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: options.chatId, text }),
        })
      );
    }
    if (mailer) channels.push(() => mailer(text));
    await deliverToOwner(channels);
  } catch {
    // Operator alerting is best-effort and must never affect the reply path.
  }
}
