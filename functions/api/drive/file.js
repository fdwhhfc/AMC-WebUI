const fromBase64Url = (value) => {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
};

const importTicketKey = async (secret) => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['decrypt']);
};

const decryptTicket = async (ticket, secret) => {
  const packed = fromBase64Url(ticket);
  if (packed.length <= 12) throw new Error('Invalid Drive ticket.');
  const iv = packed.slice(0, 12);
  const ciphertext = packed.slice(12);
  const key = await importTicketKey(secret);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return JSON.parse(new TextDecoder().decode(plaintext));
};

const sanitizeFilename = (name) => String(name || 'google-drive-file').replace(/[\r\n"]/g, '_');

export async function onRequestGet(context) {
  try {
    const secret = context.env.DRIVE_TICKET_SECRET;
    if (!secret) return new Response('Drive proxy is not configured.', { status: 503 });

    const requestUrl = new URL(context.request.url);
    const ticket = requestUrl.searchParams.get('ticket');
    if (!ticket) return new Response('Missing Drive ticket.', { status: 400 });

    const payload = await decryptTicket(ticket, secret);
    if (!payload?.fileId || !payload?.accessToken || !payload?.exp || Date.now() > Number(payload.exp)) {
      return new Response('Drive ticket expired or invalid.', { status: 401 });
    }

    const driveUrl = payload.exportMimeType
      ? `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(payload.fileId)}/export?mimeType=${encodeURIComponent(payload.exportMimeType)}`
      : `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(payload.fileId)}?alt=media&supportsAllDrives=true`;

    const driveResponse = await fetch(driveUrl, {
      headers: { Authorization: `Bearer ${payload.accessToken}` },
    });

    if (!driveResponse.ok || !driveResponse.body) {
      const detail = await driveResponse.text().catch(() => '');
      return new Response(detail || 'Google Drive download failed.', {
        status: driveResponse.status || 502,
        headers: { 'cache-control': 'no-store' },
      });
    }

    const headers = new Headers();
    headers.set(
      'content-type',
      payload.mimeType || driveResponse.headers.get('content-type') || 'application/octet-stream',
    );
    headers.set('content-disposition', `inline; filename="${sanitizeFilename(payload.name)}"`);
    headers.set('cache-control', 'private, no-store, max-age=0');
    const contentLength = driveResponse.headers.get('content-length');
    if (contentLength) headers.set('content-length', contentLength);

    return new Response(driveResponse.body, { status: 200, headers });
  } catch {
    return new Response('Drive ticket expired or invalid.', {
      status: 401,
      headers: { 'cache-control': 'no-store' },
    });
  }
}
