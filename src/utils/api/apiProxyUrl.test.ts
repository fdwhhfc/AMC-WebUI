import { describe, expect, it } from 'vitest';
import * as apiProxyUrlModule from './apiProxyUrl';

const {
  buildGeminiRequestPreviewUrl,
  buildGoogleRequestPreviewUrl,
  DEFAULT_GEMINI_API_BASE_URL,
  DEFAULT_VERTEX_EXPRESS_API_BASE_URL,
  normalizeGeminiApiBaseUrl,
  trimTrailingSlashes,
} = apiProxyUrlModule;

describe('apiProxyUrl', () => {
  describe('trimTrailingSlashes', () => {
    it('strips trailing slashes from urls and paths', () => {
      expect(trimTrailingSlashes('https://api.example.com/')).toBe('https://api.example.com');
      expect(trimTrailingSlashes('https://api.example.com///')).toBe('https://api.example.com');
      expect(trimTrailingSlashes('/api/openai/')).toBe('/api/openai');
      expect(trimTrailingSlashes('https://api.example.com')).toBe('https://api.example.com');
    });

    it('trims whitespace and handles nullish inputs', () => {
      expect(trimTrailingSlashes('  https://api.example.com/  ')).toBe('https://api.example.com');
      expect(trimTrailingSlashes('')).toBe('');
      expect(trimTrailingSlashes(null)).toBe('');
      expect(trimTrailingSlashes(undefined)).toBe('');
    });
  });

  describe('normalizeGeminiApiBaseUrl', () => {
    it('strips version suffixes and trailing slashes', () => {
      expect(normalizeGeminiApiBaseUrl('https://generativelanguage.googleapis.com/v1beta')).toBe(
        DEFAULT_GEMINI_API_BASE_URL,
      );
      expect(normalizeGeminiApiBaseUrl('https://generativelanguage.googleapis.com/v1alpha/')).toBe(
        DEFAULT_GEMINI_API_BASE_URL,
      );
    });
  });

  describe('buildGeminiRequestPreviewUrl', () => {
    it('builds standard request preview url', () => {
      const url = buildGeminiRequestPreviewUrl(DEFAULT_GEMINI_API_BASE_URL, 'gemini-2.5-flash', 'generateContent');
      expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
    });
  });

  describe('buildGoogleRequestPreviewUrl', () => {
    it('builds the Vertex Express publisher model path', () => {
      const url = buildGoogleRequestPreviewUrl(
        DEFAULT_VERTEX_EXPRESS_API_BASE_URL,
        'gemini-2.5-flash',
        'generateContent',
        'vertex-express',
      );
      expect(url).toBe(
        'https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-2.5-flash:generateContent',
      );
    });
  });

  describe('default proxy url', () => {
    it('does not export a hardcoded third-party DEFAULT_GEMINI_PROXY_URL', () => {
      expect((apiProxyUrlModule as Record<string, unknown>).DEFAULT_GEMINI_PROXY_URL).toBeUndefined();
    });
  });
});
