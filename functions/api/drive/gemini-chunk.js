const MAX_CHUNK_BYTES = 32 * 1024 * 1024;

const json = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });

const safeErrorDetail = async (response) => {
  const detail = await response.text().catch(() => '');
  return detail ? detail.slice(0, 300) : '';
};

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

    const driveAccessToken = request.headers.get('x-amc-drive-access-token')?.trim();
    const geminiApiKey = request.headers.get('x-amc-gemini-api-key')?.trim();
    if (!driveAccessToken || !geminiApiKey) {
      return json({ error: 'Missing Google Drive authorization or Gemini API key.' }, 401);
    }

    const body = await request.json().catch(() => null);
    const fileId = typeof body?.fileId === 'string' ? body.fileId.trim() : '';
    const uploadUrl = typeof body?.uploadUrl === 'string' ? body.uploadUrl.trim() : '';
    const mimeType = typeof body?.mimeType === 'string' ? body.mimeType.trim() : 'application/octet-stream';
    const offset = Number(body?.offset);
    const length = Number(body?.length);
    const totalSize = Number(body?.totalSize);

    if (
      !fileId ||
      !isAllowedUploadUrl(uploadUrl) ||
      !Number.isInteger(offset) ||
      offset < 0 ||
      !Number.isInteger(length) ||
      length <= 0 ||
      length > MAX_CHUNK_BYTES ||
      !Number.isInteger(totalSize) ||
      totalSize <= 0 ||
      offset + length > totalSize
    ) {
      return json({ error: 'Invalid Gemini resumable upload chunk parameters.' }, 400);
    }

    const end = offset + length - 1;
    const driveUrl =
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}` +
      '?alt=media&supportsAllDrives=true';

    const driveResponse = await fetch(driveUrl, {
      headers: {
        Authorization: `Bearer ${driveAccessToken}`,
        Range: `bytes=${offset}-${end}`,
      },
      signal: request.signal,
    });

    const isWholeFileResponse = offset === 0 && length === totalSize && driveResponse.status === 200;
    if (driveResponse.status !== 206 && !isWholeFileResponse) {
      const detail = await safeErrorDetail(driveResponse);
      return json(
        {
          error:
            `Google Drive did not honor the requested byte range (status ${driveResponse.status})` +
            (detail ? `: ${detail}` : ''),
        },
        502,
      );
    }

    const bytes = new Uint8Array(await driveResponse.arrayBuffer());
    if (bytes.byteLength !== length) {
      return json(
        {
          error: `Google Drive returned ${bytes.byteLength} bytes for a ${length}-byte range.`,
        },
        502,
      );
    }

    const isFinal = offset + length === totalSize;
    const uploadResponse = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'x-goog-api-key': geminiApiKey,
        'X-Goog-Upload-Offset': String(offset),
        'X-Goog-Upload-Command': isFinal ? 'upload, finalize' : 'upload',
        'Content-Type': mimeType,
      },
      body: bytes,
      signal: request.signal,
      redirect: 'manual',
    });

    if (!uploadResponse.ok) {
      const detail = await safeErrorDetail(uploadResponse);
      return json(
        {
          error:
            `Gemini resumable upload chunk failed (${uploadResponse.status})` +
            (detail ? `: ${detail}` : ''),
          offset,
          length,
          recoverable: uploadResponse.status >= 500 || uploadResponse.status === 409,
        },
        502,
      );
    }

    if (!isFinal) {
      return json({ ok: true, nextOffset: offset + length });
    }

    const payload = await uploadResponse.json().catch(() => null);
    const file = payload?.file ?? payload;
    if (!file || typeof file !== 'object' || !file.name || !file.uri) {
      return json({ error: 'Gemini Files API returned an unexpected final upload response.' }, 502);
    }

    return json({ ok: true, nextOffset: totalSize, file });
  } catch (error) {
    return json(
      {
        error: error instanceof Error ? error.message : 'Gemini resumable upload chunk failed.',
        recoverable: true,
      },
      502,
    );
  }
}

export const onRequestGet = () => json({ error: 'Method not allowed.' }, 405);
