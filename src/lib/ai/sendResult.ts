export type AiSendStatus =
  | 'success'
  | 'aborted'
  | 'in_flight_duplicate'
  | 'server_duplicate'
  | 'server_fallback'
  | 'rate_limit'
  | 'network_error'
  | 'http_error'
  | 'empty_response';

export interface AiSendResult {
  status: AiSendStatus;
  content?: string;
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
