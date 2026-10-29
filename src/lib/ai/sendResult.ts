export type AiSendStatus =
  | 'success'
  | 'aborted'
  | 'in_flight_duplicate'
  | 'server_duplicate'
  | 'server_fallback'
  | 'rate_limit'
  | 'network_error'
  | 'http_error'
  | 'empty_response'
  | 'images_error';

export interface AiSendResult {
  status: AiSendStatus;
  content?: string;
  /** The person's message as the server used it, with the picture description lines (only with pictures). */
  userText?: string;
  userMessage?: string;
}

export function isAiSendSuccess(
  result: AiSendResult,
): result is AiSendResult & { content: string } {
  return (
    result.status === 'success' &&
    typeof result.content === 'string' &&
    result.content.trim().length > 0
  );
}
