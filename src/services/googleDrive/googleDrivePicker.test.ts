import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_APP_SETTINGS } from '@/constants/settingsDefaults';
import {
  createGoogleDriveCloudReference,
  downloadGoogleDriveFile,
  uploadGoogleDriveFileToGemini,
  resolveGoogleDrivePickerConfig,
} from './googleDrivePicker';

describe('googleDrivePicker', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('resolves explicit Google Drive picker settings', () => {
    expect(
      resolveGoogleDrivePickerConfig({
        ...DEFAULT_APP_SETTINGS,
        googleDriveClientId: 'client-id',
        googleDriveApiKey: 'api-key',
        googleDriveAppId: '123456',
      }),
    ).toEqual({
      clientId: 'client-id',
      apiKey: 'api-key',
      appId: '123456',
    });
  });

  it('creates a remote Drive reference without downloading file bytes', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          fileUri: 'https://amc.example/api/drive/file?ticket=opaque',
          name: 'clip.mp4',
          mimeType: 'video/mp4',
          size: 1024,
          expiresAt: Date.now() + 60_000,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('crypto', { randomUUID: () => 'test-drive-id' });

    const file = await createGoogleDriveCloudReference('video-1', 'drive-token');

    expect(file).toMatchObject({
      id: 'drive-cloud-test-drive-id',
      name: 'clip.mp4',
      type: 'video/mp4',
      size: 1024,
      fileUri: 'https://amc.example/api/drive/file?ticket=opaque',
      transferStrategy: 'remote-file-id',
      uploadState: 'active',
      isProcessing: false,
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/drive/ticket', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fileId: 'video-1', accessToken: 'drive-token' }),
    });
  });

  it('uploads a Drive file to Gemini Files API in resumable cloud chunks', async () => {
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const size = 12 * 1024 * 1024;
    const chunkSize = 8 * 1024 * 1024;

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/drive/gemini-init') {
        return new Response(
          JSON.stringify({
            mode: 'resumable',
            fileId: 'video-1',
            uploadUrl: 'https://generativelanguage.googleapis.com/upload/session-1',
            name: 'clip.mp4',
            mimeType: 'video/mp4',
            size,
            chunkSize,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url === '/api/drive/gemini-chunk') {
        const chunkCalls = fetchMock.mock.calls.filter(([candidate]) => String(candidate) === '/api/drive/gemini-chunk');
        if (chunkCalls.length === 1) {
          return new Response(JSON.stringify({ ok: true, nextOffset: chunkSize }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(
          JSON.stringify({
            ok: true,
            nextOffset: size,
            file: {
              name: 'files/abc123',
              uri: 'https://generativelanguage.googleapis.com/v1beta/files/abc123',
              displayName: 'clip.mp4',
              mimeType: 'video/mp4',
              sizeBytes: String(size),
              state: 'ACTIVE',
              expirationTime: expiresAt,
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('crypto', { randomUUID: () => 'drive-gemini-id' });

    const file = await uploadGoogleDriveFileToGemini('video-1', 'drive-token', 'gemini-key');

    expect(file).toMatchObject({
      id: 'drive-gemini-drive-gemini-id',
      name: 'clip.mp4',
      type: 'video/mp4',
      size,
      fileApiName: 'files/abc123',
      fileUri: 'https://generativelanguage.googleapis.com/v1beta/files/abc123',
      transferStrategy: 'files-api',
      uploadState: 'active',
      isProcessing: false,
      progress: 100,
    });
    expect(file.fileApiExpirationTime).toBe(expiresAt);

    const chunkCalls = fetchMock.mock.calls.filter(([input]) => String(input) === '/api/drive/gemini-chunk');
    expect(chunkCalls).toHaveLength(2);
    expect(fetchMock.mock.calls.some(([input]) => String(input) === '/api/drive/gemini-upload')).toBe(false);
  });

  it('downloads a normal Drive blob file without changing its type', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'video-1',
            name: 'clip.mp4',
            mimeType: 'video/mp4',
            capabilities: { canDownload: true },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(new Response(new Blob(['video-bytes'], { type: 'video/mp4' }), { status: 200 }));

    vi.stubGlobal('fetch', fetchMock);

    const file = await downloadGoogleDriveFile('video-1', 'drive-token');

    expect(file.name).toBe('clip.mp4');
    expect(file.type).toBe('video/mp4');
    expect(fetchMock.mock.calls[1]?.[0]).toContain('alt=media');
    expect(fetchMock.mock.calls[1]?.[1]).toEqual({
      headers: { Authorization: 'Bearer drive-token' },
    });
  });

  it('exports Google Workspace documents to PDF before handing them to AMC', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'doc-1',
            name: 'Quarterly report',
            mimeType: 'application/vnd.google-apps.document',
            capabilities: { canDownload: true },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(new Response(new Blob(['pdf-bytes'], { type: 'application/pdf' }), { status: 200 }));

    vi.stubGlobal('fetch', fetchMock);

    const file = await downloadGoogleDriveFile('doc-1', 'drive-token');

    expect(file.name).toBe('Quarterly report.pdf');
    expect(file.type).toBe('application/pdf');
    expect(fetchMock.mock.calls[1]?.[0]).toContain('/export?mimeType=application%2Fpdf');
  });

  it('rejects Drive files whose owner disabled downloading', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            id: 'locked-1',
            name: 'locked.pdf',
            mimeType: 'application/pdf',
            capabilities: { canDownload: false },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );

    await expect(downloadGoogleDriveFile('locked-1', 'drive-token')).rejects.toThrow(
      'Google Drive file cannot be downloaded',
    );
  });
});
