import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_APP_SETTINGS } from '@/constants/settingsDefaults';
import { downloadGoogleDriveFile, resolveGoogleDrivePickerConfig } from './googleDrivePicker';

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
    expect(await file.text()).toBe('video-bytes');
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
    expect(await file.text()).toBe('pdf-bytes');
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
