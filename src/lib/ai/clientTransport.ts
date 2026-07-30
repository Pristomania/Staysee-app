/**
 * Authorized staysee-chat HTTP transport — injectable deps only (no supabase/env).
 */

import type { AiSendResult } from './sendResult';

export type ChatTransportDeps = {
  getAccessToken: () => Promise<string | null>;
  getPublicConfig: () => {
    url: string;
    anonKey: string;
  };
  fetch: typeof fetch;
};

export type SendAuthorizedChatRequestInput = {
  body: Record<string, unknown>;
  signal?: AbortSignal;
  deps: ChatTransportDeps;
};

export type SendAuthorizedChatRequestResult =
  | {
      ok: false;
      result: AiSendResult & {
        status: 'network_error';
        userMessage: string;
      };
    }
  | {
      ok: true;
      response: Response;
    };

const NO_SESSION_USER_MESSAGE =
  'Сейчас не могу ответить. Попробуй чуть позже.';

function denyNoSession(): SendAuthorizedChatRequestResult {
  return {
    ok: false,
    result: {
      status: 'network_error',
      userMessage: NO_SESSION_USER_MESSAGE,
    },
  };
}

export async function sendAuthorizedChatRequest(
  input: SendAuthorizedChatRequestInput,
): Promise<SendAuthorizedChatRequestResult> {
  let accessToken: string | null;
  try {
    accessToken = await input.deps.getAccessToken();
  } catch {
    return denyNoSession();
  }

  const token =
    typeof accessToken === 'string' ? accessToken.trim() : '';
  if (!token) {
    return denyNoSession();
  }

  const { url, anonKey } = input.deps.getPublicConfig();
  const response = await input.deps.fetch(
    `${url}/functions/v1/staysee-chat`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        Apikey: anonKey,
      },
      body: JSON.stringify(input.body),
      signal: input.signal,
    },
  );

  return { ok: true, response };
}
