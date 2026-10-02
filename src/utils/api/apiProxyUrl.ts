import type { GoogleApiBackend } from '@/types';

const GEMINI_API_VERSION_SUFFIX = /\/v\d+(?:(?:alpha|beta)\d*|\.\d+)?$/i;
const VERTEX_EXPRESS_PUBLISHER_SUFFIX = /\/v\d+(?:(?:alpha|beta)\d*|\.\d+)?\/publishers\/google$/i;

export const DEFAULT_GEMINI_API_BASE_URL = 'https://generativelanguage.googleapis.com';
export const DEFAULT_VERTEX_EXPRESS_API_BASE_URL = 'https://aiplatform.googleapis.com';
const DEFAULT_GEMINI_API_VERSION = 'v1beta';
export const DEFAULT_OPENAI_COMPATIBLE_BASE_URL = 'https://api.openai.com/v1';

/**
 * Strips trailing slashes and whitespace from a URL or path string.
 */
export const trimTrailingSlashes = (url?: string | null): string => (url?.trim() || '').replace(/\/+$/, '');

export const normalizeGeminiApiBaseUrl = (baseUrl: string): string => {
  const trimmedBaseUrl = trimTrailingSlashes(baseUrl);
  return trimmedBaseUrl.replace(GEMINI_API_VERSION_SUFFIX, '');
};

/**
 * Normalizes Vertex Express custom endpoints to the base URL shape expected by
 * @google/genai. Cherry Studio-style endpoints may already end in
 * /v1/publishers/google, while @google/genai appends both the API version and
 * publisher/model resource path itself. Strip that suffix so both forms work.
 */
export const normalizeVertexExpressApiBaseUrl = (baseUrl: string): string => {
  const trimmedBaseUrl = trimTrailingSlashes(baseUrl);
  return normalizeGeminiApiBaseUrl(trimmedBaseUrl.replace(VERTEX_EXPRESS_PUBLISHER_SUFFIX, ''));
};

export const buildGeminiRequestPreviewUrl = (
  baseUrl: string,
  modelId: string,
  method: 'generateContent' | 'streamGenerateContent',
  apiVersion: string = DEFAULT_GEMINI_API_VERSION,
): string => {
  const normalizedBaseUrl = normalizeGeminiApiBaseUrl(baseUrl);
  return `${normalizedBaseUrl}/${apiVersion}/models/${modelId}:${method}`;
};

export const buildGoogleRequestPreviewUrl = (
  baseUrl: string,
  modelId: string,
  method: 'generateContent' | 'streamGenerateContent',
  backend: GoogleApiBackend = 'gemini-api',
): string => {
  const normalizedBaseUrl =
    backend === 'vertex-express' ? normalizeVertexExpressApiBaseUrl(baseUrl) : normalizeGeminiApiBaseUrl(baseUrl);
  if (backend === 'vertex-express') {
    return `${normalizedBaseUrl}/v1/publishers/google/models/${modelId}:${method}`;
  }
  return `${normalizedBaseUrl}/${DEFAULT_GEMINI_API_VERSION}/models/${modelId}:${method}`;
};
