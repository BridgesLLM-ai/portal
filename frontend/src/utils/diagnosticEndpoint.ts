const SAFE_HTTP_METHOD = /^[A-Z]{1,16}$/;

/**
 * Keep diagnostic request identity useful without retaining query parameters
 * or fragments, which routinely carry tokens, signed URLs, search text, and
 * other user data.
 */
export function diagnosticEndpoint(method: unknown, url: unknown): string {
  const candidateMethod = String(method || 'GET').trim().toUpperCase();
  const safeMethod = SAFE_HTTP_METHOD.test(candidateMethod) ? candidateMethod : 'GET';
  const rawUrl = String(url || '').trim();
  if (!rawUrl) return safeMethod;

  const withoutQueryOrFragment = rawUrl.split(/[?#]/, 1)[0]?.trim() || '';
  if (!withoutQueryOrFragment) return safeMethod;

  let safePath = withoutQueryOrFragment;
  if (
    /^[a-z][a-z\d+.-]*:\/\//i.test(withoutQueryOrFragment)
    || withoutQueryOrFragment.startsWith('//')
  ) {
    try {
      safePath = new URL(withoutQueryOrFragment, 'https://portal.invalid').pathname;
    } catch {
      safePath = '';
    }
  }

  return safePath ? `${safeMethod} ${safePath}` : safeMethod;
}
