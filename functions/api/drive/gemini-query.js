const json = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });

const isSameOriginRequest = (request) => {
  const origin = request.headers.get('origin');
  return !origin || origin === new URL(request.url).origin;
};

const isAllowedUploadUrl = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'generativelanguage.googleapis.com';
  } catch {
    return false;
  }
};

export async function onRequestPost(context) {
  try {
    const request = context.request;
    if (!isSameOriginRequest(request)) {
      return json({ error: 'Cross-origin Drive uploads are not allowed.' }, 403);
    }

    const geminiApiKey = request.headers.get('x-amc-gemini-api-key')?.trim();
    if (!geminiApiKey) {
      return json({ error: 'Missing Gemini API key.' }, 401);
    }

    const body = await request.json().catch(() => null);
    const uploadUrl = typeof body?.uploadUrl === 'string' ? body.uploadUrl.trim() : '';
    if (!isAllowedUploadUrl(uploadUrl)) {
      return json({ error: 'Invalid Gemini upload session URL.' }, 400);
    }

    const response = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'x-goog-api-key': geminiApiKey,
        'X-Goog-Upload-Command': 'query',
      },
      body: new Uint8Array(0),
      signal: request.signal,
      redirect: 'manual',
    });

    if (!response.ok) {
      return json({ error: `Gemini upload session query failed (${response.status}).` }, 502);
    }

    const received = Number(response.headers.get('x-goog-upload-size-received') || 0);
    const status = response.headers.get('x-goog-upload-status') || 'active';

    return json({
      received: Number.isFinite(received) && received >= 0 ? received : 0,
      status,
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Gemini upload session query failed.' }, 502);
  }
}

export const onRequestGet = () => json({ error: 'Method not allowed.' }, 405);
