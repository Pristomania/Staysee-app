/**
 * Resolve the authenticated chat user from a Bearer token.
 * Identity comes only from the injected getUser verifier — never from body alone.
 */

export type AuthDenialReason =
  | "missing_bearer_token"
  | "invalid_token"
  | "user_id_mismatch";

export type ResolveVerifiedChatUserInput = {
  authorizationHeader: string | null;
  requestedUserId: string | undefined;
  getUser: (token: string) => Promise<{
    user: { id: string } | null;
    error: unknown | null;
  }>;
};

export type ResolveVerifiedChatUserResult =
  | {
      ok: true;
      userId: string;
      authToken: string;
    }
  | {
      ok: false;
      status: 401;
      reason: AuthDenialReason;
    };

function extractBearerToken(authorizationHeader: string | null): string | null {
  if (authorizationHeader == null) return null;
  const header = authorizationHeader.trim();
  if (!header) return null;

  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return null;

  const token = match[1].trim();
  return token.length > 0 ? token : null;
}

function deny(reason: AuthDenialReason): ResolveVerifiedChatUserResult {
  return { ok: false, status: 401, reason };
}

export async function resolveVerifiedChatUser(
  input: ResolveVerifiedChatUserInput,
): Promise<ResolveVerifiedChatUserResult> {
  const authToken = extractBearerToken(input.authorizationHeader);
  if (!authToken) {
    return deny("missing_bearer_token");
  }

  let verifiedId: string;
  try {
    const result = await input.getUser(authToken);
    if (result.error != null) {
      return deny("invalid_token");
    }
    const userId = result.user?.id?.trim();
    if (!userId) {
      return deny("invalid_token");
    }
    verifiedId = userId;
  } catch {
    return deny("invalid_token");
  }

  if (
    input.requestedUserId !== undefined &&
    input.requestedUserId !== verifiedId
  ) {
    return deny("user_id_mismatch");
  }

  return {
    ok: true,
    userId: verifiedId,
    authToken,
  };
}
