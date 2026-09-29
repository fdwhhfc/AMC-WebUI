import type { GoogleGenAI } from '@google/genai';
import type { GoogleApiBackend } from '@/types';
import { dbService } from '@/services/db/dbService';
import { logService } from '@/services/logService';
import {
  getGeminiApiBaseUrlForSettings,
  getGeminiProxyBaseUrlForSettings,
  resolveConfiguredGeminiBaseUrl,
  shouldAttachGeminiUpstreamHeader,
  getNormalizedUpstreamBaseUrl,
  toAbsoluteHttpUrl,
} from './geminiApiBaseUrl';
import { DEFAULT_VERTEX_EXPRESS_API_BASE_URL, normalizeGeminiApiBaseUrl } from '@/utils/api/apiProxyUrl';
import { hasDeploymentApiContainer } from '@/runtime/runtimeConfig';
import { type GeminiClientHttpOptions, withHttpOptionHeaders } from './geminiApiVersion';
import type { InternalGeminiApiClient } from './geminiResumableUpload';

type ClientConfig = {
  apiKey: string;
  vertexai?: boolean;
  httpOptions?: GeminiClientHttpOptions;
};

const DEFAULT_GOOGLE_API_BACKEND: GoogleApiBackend = 'gemini-api';

type ConfiguredApiRouting = {
  settings: Awaited<ReturnType<typeof dbService.getAppSettings>>;
  apiProxyUrl: string | null;
};

type ConfiguredApiClientContext = {
  client: GoogleGenAI;
  uploadApiClient: InternalGeminiApiClient;
  apiBaseUrl: string;
  proxyBaseUrl: string | null;
};

type GoogleGenAIUploadClient = GoogleGenAI & {
  readonly apiClient: InternalGeminiApiClient;
};

const loadGoogleGenAI = async () => {
  const { GoogleGenAI } = await import('@google/genai');
  return GoogleGenAI;
};

const getUploadApiClient = (client: GoogleGenAI): InternalGeminiApiClient =>
  (client as GoogleGenAIUploadClient).apiClient;

export const getClient = async (
  apiKey: string,
  baseUrl?: string | null,
  httpOptions?: GeminiClientHttpOptions,
  backend: GoogleApiBackend = DEFAULT_GOOGLE_API_BACKEND,
): Promise<GoogleGenAI> => {
  try {
    const sanitizedApiKey = apiKey
      .replace(/[\u2013\u2014]/g, '-')
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/[\u00A0]/g, ' ');

    if (apiKey !== sanitizedApiKey) {
      logService.warn('API key was sanitized. Non-ASCII characters were replaced.');
    }

    const config: ClientConfig = {
      apiKey: sanitizedApiKey,
      ...(backend === 'vertex-express' ? { vertexai: true } : {}),
    };
    let mergedHttpOptions = httpOptions ? { ...httpOptions } : undefined;

    // Vertex AI Express mode uses Vertex resource paths. Pin the stable v1
    // endpoint unless the caller explicitly requested another API version.
    if (backend === 'vertex-express') {
      mergedHttpOptions = {
        ...(mergedHttpOptions ?? {}),
        apiVersion: mergedHttpOptions?.apiVersion ?? 'v1',
      };
    }

    if (baseUrl && baseUrl.trim().length > 0) {
      const sanitizedBaseUrl = baseUrl.includes('/api/live')
        ? normalizeGeminiApiBaseUrl(toAbsoluteHttpUrl(baseUrl))
        : getGeminiApiBaseUrlForSettings({
            useCustomApiConfig: true,
            useApiProxy: true,
            apiProxyUrl: baseUrl,
          });
      if (mergedHttpOptions) {
        if (!mergedHttpOptions.baseUrl) {
          mergedHttpOptions.baseUrl = sanitizedBaseUrl;
        }
      } else {
        config.httpOptions = { baseUrl: sanitizedBaseUrl };
      }
    }

    if (mergedHttpOptions) {
      config.httpOptions = mergedHttpOptions;
    }

    const GoogleGenAIConstructor = await loadGoogleGenAI();
    return new GoogleGenAIConstructor(config);
  } catch (clientInitError) {
    logService.error('Failed to initialize GoogleGenAI client:', clientInitError);
    throw clientInitError;
  }
};

const loadConfiguredApiRouting = async (): Promise<ConfiguredApiRouting> => {
  const settings = await dbService.getAppSettings();

  const shouldUseProxy = !!(settings?.useCustomApiConfig && settings?.useApiProxy);
  const apiProxyUrl = settings ? resolveConfiguredGeminiBaseUrl(settings) : null;

  if (settings?.useCustomApiConfig && !shouldUseProxy && settings?.apiProxyUrl && !settings?.useApiProxy) {
    logService.debug("[API Config] Proxy URL present but 'Use API Proxy' toggle is OFF.");
  }

  return { settings, apiProxyUrl };
};

export const getConfiguredApiClient = async (
  apiKey: string,
  httpOptions?: GeminiClientHttpOptions,
  routingOverrides?: { directGoogleApi?: boolean; backend?: GoogleApiBackend },
): Promise<GoogleGenAI> => {
  const { settings, apiProxyUrl } = await loadConfiguredApiRouting();

  const backend =
    routingOverrides?.backend ??
    (settings?.useCustomApiConfig ? settings.googleApiBackend : undefined) ??
    DEFAULT_GOOGLE_API_BACKEND;
  const effectiveApiProxyUrl = routingOverrides?.directGoogleApi ? null : apiProxyUrl;

  // Docker mode: when the user configured an absolute upstream proxy URL, the
  // frontend sends all Gemini requests to the api container's relative path
  // and needs to tell the backend where to forward via a request header.
  const upstreamHeader =
    settings && !routingOverrides?.directGoogleApi
      ? (() => {
          const configuredUpstream = shouldAttachGeminiUpstreamHeader(settings)
            ? getNormalizedUpstreamBaseUrl(settings)
            : null;
          const vertexExpressUpstream =
            backend === 'vertex-express' && hasDeploymentApiContainer() ? DEFAULT_VERTEX_EXPRESS_API_BASE_URL : null;
          const upstreamUrl = configuredUpstream ?? vertexExpressUpstream;
          return upstreamUrl ? { 'x-gemini-upstream-base-url': upstreamUrl } : undefined;
        })()
      : undefined;

  const authHeaders = settings?.serverAccessPassword?.trim()
    ? { 'x-access-token': settings.serverAccessPassword.trim() }
    : undefined;

  let mergedHttpOptions = upstreamHeader ? withHttpOptionHeaders(httpOptions, upstreamHeader) : httpOptions;
  if (authHeaders) {
    mergedHttpOptions = withHttpOptionHeaders(mergedHttpOptions, authHeaders);
  }
  return getClient(apiKey, effectiveApiProxyUrl, mergedHttpOptions, backend);
};

export const getConfiguredApiClientContext = async (
  apiKey: string,
  httpOptions?: GeminiClientHttpOptions,
): Promise<ConfiguredApiClientContext> => {
  const { settings, apiProxyUrl } = await loadConfiguredApiRouting();
  const authHeaders = settings?.serverAccessPassword?.trim()
    ? { 'x-access-token': settings.serverAccessPassword.trim() }
    : undefined;
  const mergedHttpOptions = authHeaders ? withHttpOptionHeaders(httpOptions, authHeaders) : httpOptions;
  // This context powers Gemini Files/resumable upload flows, which must not
  // inherit the normal generation backend switch.
  const client = await getClient(apiKey, apiProxyUrl, mergedHttpOptions, 'gemini-api');

  return {
    client,
    uploadApiClient: getUploadApiClient(client),
    apiBaseUrl: getGeminiApiBaseUrlForSettings(settings),
    proxyBaseUrl: getGeminiProxyBaseUrlForSettings(settings),
  };
};
