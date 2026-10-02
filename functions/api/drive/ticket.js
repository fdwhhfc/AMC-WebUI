/* global crypto, TextEncoder, btoa */
const GOOGLE_APPS_PREFIX = 'application/vnd.google-apps.';
const GOOGLE_APPS_EXPORTABLE_TO_PDF = new Set([
  'application/vnd.google-apps.document',
  'application/vnd.google-apps.spreadsheet',
  'application/vnd.google-apps.presentation',
  'application/vnd.google-apps.drawing',
]);

const MAX_REMOTE_FILE_BYTES = 15 * 1024 * 1024;
const TICKET_TTL_MS = 15 * 60 * 1000;

const json = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });

const toBase64Url = (bytes) => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
};

const importTicketKey = async (secret) => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt']);
};

const encryptTicket = async (payload, secret) => {
  const key = await importTicketKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext));
  const packed = new Uint8Array(iv.length + encrypted.length);
  packed.set(iv, 0);
  packed.set(encrypted, iv.length);
  return toBase64Url(packed);
};

const authorizedDriveFetch = async (url, accessToken) => {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Google Drive request failed (${response.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`);
  }
  return response;
};

const withPdfExtension = (name) => {
  const base = String(name || '').replace(/\.[^.]+$/, '');
  return `${base || 'google-drive-file'}.pdf`;
};

export async function onRequestPost(context) {
  try {
    const secret = context.env.DRIVE_TICKET_SECRET;
    if (!secret) return json({ error: 'DRIVE_TICKET_SECRET is not configured.' }, 503);

    const requestOrigin = context.request.headers.get('origin');
    const siteOrigin = new URL(context.request.url).origin;
    if (requestOrigin && requestOrigin !== siteOrigin) {
      return json({ error: 'Cross-origin Drive ticket requests are not allowed.' }, 403);
    }

    const body = await context.request.json();
    const fileId = typeof body?.fileId === 'string' ? body.fileId.trim() : '';
    const accessToken = typeof body?.accessToken === 'string' ? body.accessToken.trim() : '';
    if (!fileId || !accessToken) return json({ error: 'Missing Drive file id or OAuth token.' }, 400);

    const fields = encodeURIComponent('id,name,mimeType,size,capabilities(canDownload)');
    const metadataResponse = await authorizedDriveFetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=${fields}&supportsAllDrives=true`,
      accessToken,
    );
    const metadata = await metadataResponse.json();

    if (metadata?.capabilities?.canDownload === false) {
      return json({ error: `Google Drive file cannot be downloaded: ${metadata.name || fileId}` }, 400);
    }

    let name = metadata?.name || `drive-${fileId}`;
    let mimeType = metadata?.mimeType || 'application/octet-stream';
    let exportMimeType = null;
    const declaredSize = Number(metadata?.size || 0);

    if (mimeType.startsWith(GOOGLE_APPS_PREFIX)) {
      if (!GOOGLE_APPS_EXPORTABLE_TO_PDF.has(mimeType)) {
        return json({ error: `Unsupported Google Workspace file type: ${mimeType}` }, 400);
      }
      mimeType = 'application/pdf';
      exportMimeType = 'application/pdf';
      name = withPdfExtension(name);
    } else if (declaredSize > MAX_REMOTE_FILE_BYTES) {
      return json(
        {
          error:
            'This Drive file is larger than the current 15 MB Vertex remote-URL limit. AMC will not fall back to downloading it through your browser.',
          code: 'DRIVE_REMOTE_FILE_TOO_LARGE',
          maxBytes: MAX_REMOTE_FILE_BYTES,
          size: declaredSize,
        },
        413,
      );
    }

    const expiresAt = Date.now() + TICKET_TTL_MS;
    const ticket = await encryptTicket({ fileId, accessToken, name, mimeType, exportMimeType, exp: expiresAt }, secret);
    const fileUri = new URL('/api/drive/file', context.request.url);
    fileUri.searchParams.set('ticket', ticket);

    return json({
      fileUri: fileUri.toString(),
      name,
      mimeType,
      size: declaredSize,
      expiresAt,
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Failed to create Drive cloud ticket.' }, 500);
  }
}
