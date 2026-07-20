export function extractAccountIdFromJwt(accessToken: string): string {
  try {
    const parts = accessToken.split('.');
    if (parts.length !== 3) return '';
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    return payload?.['https://api.openai.com/auth']?.chatgpt_account_id || '';
  } catch {
    return '';
  }
}
