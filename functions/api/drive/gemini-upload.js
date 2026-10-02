/* global FixedLengthStream */

const GOOGLE_APPS_PREFIX = 'application/vnd.google-apps.';
const GOOGLE_APPS_EXPORTABLE_TO_PDF = new Set([
  'application/vnd.google-apps.document',
  'application/vnd.google-apps.spreadsheet',
  'application/vnd.google-apps.presentation',
  'application/vnd.google-apps.drawing',
]);

const GEMINI_FILES_API_MAX_BYTES = 2 * 1024 * 1024 * 1024;

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

const withPdfExtension = (name) => {
  const base = String(name || '').replace(/\.[^.]+$/, '');
  return `${base || 'google-drive-file'}.pdf`;
};

const getDriveSource = async (fileId, accessToken, signal) => {
  const fields = encodeURIComponent('id,name,mimeType,size,capabilities(canDownload)');
  const metadataResponse = await authorizedDriveFetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=${fields}&supportsAllDrives=true`,
    accessToken,
    signal,
  );
  const metadata = await metadataResponse.json();

  if (metadata?.capabilities?.canDownload === false) {
    throw new Error(`Google Drive file cannot be downloaded: ${metadata.name || fileId}`);
  }

  const originalMimeType = metadata?.mimeType || 'application/octet-stream';

  if (originalMimeType.startsWith(GOOGLE_APPS_PREFIX)) {
    if (!GOOGLE_APPS_EXPORTABLE_TO_PDF.has(originalMimeType)) {
      throw new Error(`Unsupported Google Workspace file type: ${originalMimeType}`);
    }

    const exportResponse = await authorizedDriveFetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent('application/pdf')}`,
      accessToken,
      signal,
    );
    const declaredLength = Number(exportResponse.headers.get('content-length') || 0);

    if (declaredLength > 0) {
      return {
        name: withPdfExtension(metadata?.name),
        mimeType: 'application/pdf',
        size: declaredLength,
        body: exportResponse.body,
      };
    }

    const bytes = new Uint8Array(await exportResponse.arrayBuffer());
    return {
      name: withPdfExtension(metadata?.name),
      mimeType: 'application/pdf',
      size: bytes.byteLength,
      body: bytes,
    };
  }

  const size = Number(metadata?.size || 0);
  if (!Number.isFinite(size) || size <= 0) {
    throw new Error('Google Drive did not provide a valid file size.');
  }
  if (size > GEMINI_FILES_API_MAX_BYTES) {
    throw new Error('Gemini Files API supports files up to 2 GB.');
  }

  const mediaResponse = await authorizedDriveFetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`,
    accessToken,
    signal,
  );
  if (!mediaResponse.body) {
    throw new Error('Google Drive returned an empty file body.');
  }

  return {
    name: metadata?.name || `drive-${fileId}`,
    mimeType: originalMimeType,
    size,
    body: mediaResponse.body,
  };
};

const startGeminiUpload = async ({ apiKey, name, mimeType, size, signal }) => {
  const response = await fetch('https://generativelanguage.googleapis.com/upload/v1beta/files', {
    method: 'POST',
    headers: {
      'x-goog-api-key': apiKey,
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(size),
      'X-Goog-Upload-Header-Content-Type': mimeType,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ file: { display_name: name } }),
    signal,
    redirect: 'manual',
  });

  if (!response.ok) {
    const detail = await safeErrorDetail(response);
    throw new Error(`Gemini Files API upload session failed (${response.status})${detail ? `: ${detail}` : ''}`);
  }

  const uploadUrl = response.headers.get('x-goog-upload-url');
  if (!uploadUrl) {
    throw new Error('Gemini Files API did not return an upload URL.');
  }
  return uploadUrl;
};

const uploadFixedLengthStream = async ({ uploadUrl, apiKey, source, signal }) => {
  const fixed = new FixedLengthStream(source.size);
  const pipePromise = source.body.pipeTo(fixed.writable);

  try {
    const uploadResponse = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'x-goog-api-key': apiKey,
        'X-Goog-Upload-Offset': '0',
        'X-Goog-Upload-Command': 'upload, finalize',
        'Content-Type': source.mimeType,
      },
      body: fixed.readable,
      signal,
      redirect: 'manual',
    });
    await pipePromise;
    return uploadResponse;
  } catch (error) {
    await pipePromise.catch(() => undefined);
    throw error;
  }
};

const finalizeGeminiUpload = async ({ uploadUrl, apiKey, source, signal }) => {
  const uploadResponse =
    source.body instanceof Uint8Array
      ? await fetch(uploadUrl, {
          method: 'POST',
          headers: {
            'x-goog-api-key': apiKey,
            'X-Goog-Upload-Offset': '0',
            'X-Goog-Upload-Command': 'upload, finalize',
            'Content-Type': source.mimeType,
          },
          body: source.body,
          signal,
          redirect: 'manual',
        })
      : await uploadFixedLengthStream({ uploadUrl, apiKey, source, signal });

  if (!uploadResponse.ok) {
    const detail = await safeErrorDetail(uploadResponse);
    throw new Error(`Gemini Files API upload failed (${uploadResponse.status})${detail ? `: ${detail}` : ''}`);
  }

  const payload = await uploadResponse.json().catch(() => null);
  const file = payload?.file ?? payload;
  if (!file || typeof file !== 'object' || !file.name || !file.uri) {
    throw new Error('Gemini Files API returned an unexpected upload response.');
  }

  return file;
};

export async function onRequestPost(context) {
  try {
    const request = context.request;
    const requestUrl = new URL(request.url);
    const requestOrigin = request.headers.get('origin');
    if (requestOrigin && requestOrigin !== requestUrl.origin) {
      return json({ error: 'Cross-origin Drive uploads are not allowed.' }, 403);
    }

    const driveAccessToken = request.headers.get('x-amc-drive-access-token')?.trim();
    const geminiApiKey = request.headers.get('x-amc-gemini-api-key')?.trim();
    if (!driveAccessToken || !geminiApiKey) {
      return json({ error: 'Missing Google Drive authorization or Gemini API key.' }, 401);
    }

    const body = await request.json().catch(() => null);
    const fileId = typeof body?.fileId === 'string' ? body.fileId.trim() : '';
    if (!fileId) {
      return json({ error: 'Missing Google Drive file id.' }, 400);
    }

    const source = await getDriveSource(fileId, driveAccessToken, request.signal);
    if (source.size > GEMINI_FILES_API_MAX_BYTES) {
      return json({ error: 'Gemini Files API supports files up to 2 GB.' }, 413);
    }

    const uploadUrl = await startGeminiUpload({
      apiKey: geminiApiKey,
      name: source.name,
      mimeType: source.mimeType,
      size: source.size,
      signal: request.signal,
    });

    const file = await finalizeGeminiUpload({
      uploadUrl,
      apiKey: geminiApiKey,
      source,
      signal: request.signal,
    });

    return json({
      file: {
        ...file,
        displayName: file.displayName || source.name,
        mimeType: file.mimeType || source.mimeType,
        sizeBytes: file.sizeBytes || String(source.size),
      },
    });
  } catch (error) {
    return json(
      {
        error: error instanceof Error ? error.message : 'Failed to upload Google Drive file to Gemini Files API.',
      },
      500,
    );
  }
}

export const onRequestGet = () => json({ error: 'Method not allowed.' }, 405);
