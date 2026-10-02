import type { AppSettings } from '@/types';

const GOOGLE_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const GOOGLE_API_SCRIPT_SRC = 'https://apis.google.com/js/api.js';
const GOOGLE_IDENTITY_SCRIPT_SRC = 'https://accounts.google.com/gsi/client';

const GOOGLE_APPS_PREFIX = 'application/vnd.google-apps.';
const GOOGLE_APPS_EXPORTABLE_TO_PDF = new Set([
  'application/vnd.google-apps.document',
  'application/vnd.google-apps.spreadsheet',
  'application/vnd.google-apps.presentation',
  'application/vnd.google-apps.drawing',
]);

export interface GoogleDrivePickerConfig {
  clientId: string;
  apiKey: string;
  appId: string;
}

interface GoogleTokenResponse {
  access_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

interface GoogleTokenClient {
  requestAccessToken: (options?: { prompt?: string }) => void;
}

interface GoogleOAuth2Api {
  initTokenClient: (config: {
    client_id: string;
    scope: string;
    callback: (response: GoogleTokenResponse) => void;
    error_callback?: (error: unknown) => void;
  }) => GoogleTokenClient;
}

interface GoogleIdentityNamespace {
  accounts?: {
    oauth2?: GoogleOAuth2Api;
  };
  picker?: GooglePickerNamespace;
}

interface GoogleApiLoader {
  load: (name: string, callback: () => void) => void;
}

interface GooglePickerDocument {
  [key: string]: unknown;
}

interface GooglePickerCallbackData {
  [key: string]: unknown;
}

interface GooglePickerView {
  setIncludeFolders: (value: boolean) => GooglePickerView;
  setSelectFolderEnabled: (value: boolean) => GooglePickerView;
  setMode: (mode: string) => GooglePickerView;
  setOwnedByMe: (value: boolean) => GooglePickerView;
  setParent: (parentId: string) => GooglePickerView;
}

interface GooglePickerInstance {
  setVisible: (value: boolean) => void;
}

interface GooglePickerBuilder {
  setAppId: (appId: string) => GooglePickerBuilder;
  setOAuthToken: (token: string) => GooglePickerBuilder;
  setDeveloperKey: (apiKey: string) => GooglePickerBuilder;
  addView: (view: GooglePickerView) => GooglePickerBuilder;
  enableFeature: (feature: string) => GooglePickerBuilder;
  setCallback: (callback: (data: GooglePickerCallbackData) => void) => GooglePickerBuilder;
  build: () => GooglePickerInstance;
}

interface GooglePickerNamespace {
  Action: {
    PICKED: string;
    CANCEL: string;
  };
  Response: {
    ACTION: string;
    DOCUMENTS: string;
  };
  Document: {
    ID: string;
  };
  Feature: {
    MULTISELECT_ENABLED: string;
    NAV_HIDDEN: string;
  };
  ViewId: {
    DOCS: string;
  };
  DocsViewMode: {
    LIST: string;
  };
  DocsView: new (viewId: string) => GooglePickerView;
  PickerBuilder: new () => GooglePickerBuilder;
}

type GoogleDriveWindow = Window & {
  google?: GoogleIdentityNamespace;
  gapi?: GoogleApiLoader;
};

interface DriveFileMetadata {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  capabilities?: {
    canDownload?: boolean;
  };
}

let cachedAccessToken:
  | {
      clientId: string;
      token: string;
      expiresAt: number;
    }
  | undefined;

const readRuntimeEnv = () =>
  (
    import.meta as ImportMeta & {
      env?: {
        VITE_GOOGLE_DRIVE_CLIENT_ID?: string;
        VITE_GOOGLE_DRIVE_API_KEY?: string;
        VITE_GOOGLE_DRIVE_APP_ID?: string;
      };
    }
  ).env;

const normalizeSetting = (value: string | null | undefined): string => value?.trim() ?? '';

export const resolveGoogleDrivePickerConfig = (settings: AppSettings): GoogleDrivePickerConfig | null => {
  const env = readRuntimeEnv();
  const clientId = normalizeSetting(settings.googleDriveClientId) || normalizeSetting(env?.VITE_GOOGLE_DRIVE_CLIENT_ID);
  const apiKey = normalizeSetting(settings.googleDriveApiKey) || normalizeSetting(env?.VITE_GOOGLE_DRIVE_API_KEY);
  const appId = normalizeSetting(settings.googleDriveAppId) || normalizeSetting(env?.VITE_GOOGLE_DRIVE_APP_ID);

  if (!clientId || !apiKey || !appId) {
    return null;
  }

  return { clientId, apiKey, appId };
};

const loadScript = async (src: string, id: string): Promise<void> => {
  const existing = document.getElementById(id) as HTMLScriptElement | null;
  if (existing?.dataset.loaded === 'true') {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const script = existing ?? document.createElement('script');

    const handleLoad = () => {
      script.dataset.loaded = 'true';
      resolve();
    };
    const handleError = () => reject(new Error(`Failed to load Google script: ${src}`));

    script.addEventListener('load', handleLoad, { once: true });
    script.addEventListener('error', handleError, { once: true });

    if (!existing) {
      script.id = id;
      script.src = src;
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    }
  });
};

const ensureGoogleIdentity = async (): Promise<GoogleOAuth2Api> => {
  const targetWindow = window as GoogleDriveWindow;
  if (!targetWindow.google?.accounts?.oauth2) {
    await loadScript(GOOGLE_IDENTITY_SCRIPT_SRC, 'google-identity-services-script');
  }

  const oauth2 = targetWindow.google?.accounts?.oauth2;
  if (!oauth2) {
    throw new Error('Google Identity Services did not initialize.');
  }
  return oauth2;
};

const ensureGooglePicker = async (): Promise<GooglePickerNamespace> => {
  const targetWindow = window as GoogleDriveWindow;
  if (!targetWindow.gapi) {
    await loadScript(GOOGLE_API_SCRIPT_SRC, 'google-api-loader-script');
  }

  const gapi = targetWindow.gapi;
  if (!gapi) {
    throw new Error('Google API loader did not initialize.');
  }

  if (!targetWindow.google?.picker) {
    await new Promise<void>((resolve, reject) => {
      try {
        gapi.load('picker', resolve);
      } catch (error) {
        reject(error);
      }
    });
  }

  const picker = targetWindow.google?.picker;
  if (!picker) {
    throw new Error('Google Picker API did not initialize.');
  }
  return picker;
};

const requestGoogleDriveAccessToken = async (config: GoogleDrivePickerConfig): Promise<string> => {
  if (
    cachedAccessToken &&
    cachedAccessToken.clientId === config.clientId &&
    cachedAccessToken.expiresAt > Date.now() + 60_000
  ) {
    return cachedAccessToken.token;
  }

  const oauth2 = await ensureGoogleIdentity();
  const hasPriorGrant = cachedAccessToken?.clientId === config.clientId;

  return new Promise<string>((resolve, reject) => {
    const tokenClient = oauth2.initTokenClient({
      client_id: config.clientId,
      scope: GOOGLE_DRIVE_SCOPE,
      callback: (response) => {
        if (response.error || !response.access_token) {
          reject(
            new Error(
              response.error_description || response.error || 'Google Drive authorization did not return a token.',
            ),
          );
          return;
        }

        const expiresInSeconds = Number(response.expires_in ?? 3600);
        cachedAccessToken = {
          clientId: config.clientId,
          token: response.access_token,
          expiresAt: Date.now() + Math.max(60, expiresInSeconds) * 1000,
        };
        resolve(response.access_token);
      },
      error_callback: (error) => {
        reject(error instanceof Error ? error : new Error('Google Drive authorization was cancelled or failed.'));
      },
    });

    tokenClient.requestAccessToken({ prompt: hasPriorGrant ? '' : 'consent' });
  });
};

export const prepareGoogleDrivePicker = async (): Promise<void> => {
  await Promise.all([ensureGoogleIdentity(), ensureGooglePicker()]);
};

const openGoogleDrivePicker = async (config: GoogleDrivePickerConfig, accessToken: string): Promise<string[]> => {
  const picker = await ensureGooglePicker();

  return new Promise<string[]>((resolve, reject) => {
    try {
      const docsView = new picker.DocsView(picker.ViewId.DOCS)
        .setIncludeFolders(true)
        .setSelectFolderEnabled(false)
        .setMode(picker.DocsViewMode.LIST)
        .setOwnedByMe(true)
        .setParent('root');

      const instance = new picker.PickerBuilder()
        .setAppId(config.appId)
        .setOAuthToken(accessToken)
        .setDeveloperKey(config.apiKey)
        .addView(docsView)
        .enableFeature(picker.Feature.MULTISELECT_ENABLED)
        .enableFeature(picker.Feature.NAV_HIDDEN)
        .setCallback((data) => {
          const action = data[picker.Response.ACTION];
          if (action === picker.Action.CANCEL) {
            resolve([]);
            return;
          }
          if (action !== picker.Action.PICKED) {
            return;
          }

          const documents = data[picker.Response.DOCUMENTS];
          if (!Array.isArray(documents)) {
            resolve([]);
            return;
          }

          const ids = documents.flatMap((document): string[] => {
            if (!document || typeof document !== 'object') return [];
            const id = (document as GooglePickerDocument)[picker.Document.ID];
            return typeof id === 'string' && id ? [id] : [];
          });
          resolve(ids);
        })
        .build();

      instance.setVisible(true);
    } catch (error) {
      reject(error);
    }
  });
};

const authorizedDriveFetch = async (url: string, accessToken: string): Promise<Response> => {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Google Drive request failed (${response.status})${detail ? `: ${detail.slice(0, 240)}` : ''}`);
  }
  return response;
};

const getDriveFileMetadata = async (fileId: string, accessToken: string): Promise<DriveFileMetadata> => {
  const fields = encodeURIComponent('id,name,mimeType,size,capabilities(canDownload)');
  const response = await authorizedDriveFetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=${fields}&supportsAllDrives=true`,
    accessToken,
  );
  return (await response.json()) as DriveFileMetadata;
};

const withPdfExtension = (name: string): string => {
  const base = name.replace(/\.[^.]+$/, '');
  return `${base || 'google-drive-file'}.pdf`;
};

export const downloadGoogleDriveFile = async (fileId: string, accessToken: string): Promise<File> => {
  const metadata = await getDriveFileMetadata(fileId, accessToken);

  if (metadata.capabilities?.canDownload === false) {
    throw new Error(`Google Drive file cannot be downloaded: ${metadata.name}`);
  }

  if (metadata.mimeType.startsWith(GOOGLE_APPS_PREFIX)) {
    if (!GOOGLE_APPS_EXPORTABLE_TO_PDF.has(metadata.mimeType)) {
      throw new Error(`Unsupported Google Workspace file type: ${metadata.mimeType}`);
    }

    const response = await authorizedDriveFetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent('application/pdf')}`,
      accessToken,
    );
    const blob = await response.blob();
    return new File([blob], withPdfExtension(metadata.name), { type: 'application/pdf' });
  }

  const response = await authorizedDriveFetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`,
    accessToken,
  );
  const blob = await response.blob();
  const mimeType = metadata.mimeType || blob.type || 'application/octet-stream';
  return new File([blob], metadata.name || `drive-${fileId}`, { type: mimeType });
};

export const pickGoogleDriveFiles = async (settings: AppSettings): Promise<File[]> => {
  const config = resolveGoogleDrivePickerConfig(settings);
  if (!config) {
    throw new Error(
      'Google Drive is not configured. Open Settings and enter the Google Drive OAuth Client ID, Picker API key, and project number.',
    );
  }

  const accessToken = await requestGoogleDriveAccessToken(config);
  const fileIds = await openGoogleDrivePicker(config, accessToken);
  const files: File[] = [];

  for (const fileId of fileIds) {
    files.push(await downloadGoogleDriveFile(fileId, accessToken));
  }

  return files;
};
