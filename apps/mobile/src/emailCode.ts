export type EmailCodeChallenge = { challengeId: string; expiresIn: number; retryAfter: number };
export type EmailCodeResponse = { data?: { challenge_id?: string; expires_in?: number; retry_after?: number; user?: { id: string | number; email?: string } }; meta?: { session_token?: string; is_authenticated?: boolean }; errors?: { message?: string }[]; detail?: string };
export function challengeFromResponse(data: EmailCodeResponse): EmailCodeChallenge {
  if (!data.data?.challenge_id) throw new Error('Could not request a sign-in code. Try again.');
  return { challengeId: data.data.challenge_id, expiresIn: data.data.expires_in ?? 300, retryAfter: data.data.retry_after ?? 60 };
}
export function emailCodeError(data: EmailCodeResponse, fallback: string): string { return data.errors?.map(error => error.message).filter(Boolean).join(' ') || data.detail || fallback; }
