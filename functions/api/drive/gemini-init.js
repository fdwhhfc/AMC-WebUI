const GOOGLE_APPS_PREFIX = 'application/vnd.google-apps.';
const GOOGLE_APPS_EXPORTABLE_TO_PDF = new Set([
  'application/vnd.google-apps.document',
  'application/vnd.google-apps.spreadsheet',
  'application/vnd.google-apps.presentation',
  'application/vnd.google-apps.drawing',
]);

const GEMINI_FILES_API_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_CHUNK_BYTES = 8 * 1024 * 1024;

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

const authorizedDriveFetch = async (url, accessToken, signal) => {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal,
  });
  if (!response.ok) {
    const detail = await safeErrorDetail(response);
    throw new Error(`Google Drive request failed (${response.status})${detail ? `: ${detail}` : ''}`);
  }
  return response;
};

const chooseChunkSize = (granularity) => {
  const value = Number(granularity || 0);
  if (!Number.isInteger(value) || value <= 0) return DEFAULT_CHUNK_BYTES;
  const multiples = Math.max(1, Math.floor(DEFAULT_CHUNK_BYTES / value));
  return multiples * value;
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
    if (!fileId) return json({ error: 'Missing Google Drive file id.' }, 400);

    const fields = encodeURIComponent('id,name,mimeType,size,capabilities(canDownload)');
    const metadataResponse = await authorizedDriveFetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=${fields}&supportsAllDrives=true`,
      driveAccessToken,
      request.signal,
    );
    const metadata = await metadataResponse.json();

    if (metadata?.capabilities?.canDownload === false) {
      return json({ error: `Google Drive file cannot be downloaded: ${metadata.name || fileId}` }, 400);
    }

    const mimeType = metadata?.mimeType || 'application/octet-stream';
    if (mimeType.startsWith(GOOGLE_APPS_PREFIX)) {
      if (!GOOGLE_APPS_EXPORTABLE_TO_PDF.has(mimeType)) {
        return json({ error: `Unsupported Google Workspace file type: ${mimeType}` }, 400);
      }
      return json({
        mode: 'single',
        reason: 'google-workspace-export',
      });
    }

    const size = Number(metadata?.size || 0);
    if (!Number.isFinite(size) || size <= 0) {
      return json({ error: 'Google Drive did not provide a valid file size.' }, 400);
    }
    if (size > GEMINI_FILES_API_MAX_BYTES) {
      return json({ error: 'Gemini Files API supports files up to 2 GB.' }, 413);
    }

    const startResponse = await fetch('https://generativelanguage.googleapis.com/upload/v1beta/files', {
      method: 'POST',
      headers: {
        'x-goog-api-key': geminiApiKey,
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(size),
        'X-Goog-Upload-Header-Content-Type': mimeType,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ file: { display_name: metadata?.name || `drive-${fileId}` } }),
      signal: request.signal,
      redirect: 'manual',
    });

    if (!startResponse.ok) {
      const detail = await safeErrorDetail(startResponse);
      return json(
        {
          error:
            `Gemini Files API upload session failed (${startResponse.status})` +
            (detail ? `: ${detail}` : ''),
        },
        502,
      );
    }

    const uploadUrl = startResponse.headers.get('x-goog-upload-url');
    if (!uploadUrl) {
      return json({ error: 'Gemini Files API did not return an upload URL.' }, 502);
    }

    const granularity = Number(startResponse.headers.get('x-goog-upload-chunk-granularity') || 0);
    const chunkSize = chooseChunkSize(granularity);

    return json({
      mode: 'resumable',
      fileId,
      uploadUrl,
      name: metadata?.name || `drive-${fileId}`,
      mimeType,
      size,
      chunkSize,
      granularity: granularity || null,
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Failed to initialize Gemini upload.' }, 500);
  }
}

export const onRequestGet = () => json({ error: 'Method not allowed.' }, 405);
