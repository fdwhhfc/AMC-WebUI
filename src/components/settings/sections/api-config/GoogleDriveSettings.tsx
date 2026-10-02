import React from 'react';
import { HardDriveDownload } from 'lucide-react';
import { SETTINGS_INPUT_CLASS } from '@/constants/formClasses';
import type { AppSettings } from '@/types';
import { resolveGoogleDrivePickerConfig } from '@/services/googleDrive/googleDrivePicker';

interface GoogleDriveSettingsProps {
  settings: AppSettings;
  onUpdate: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
}

const INPUT_CLASS =
  'w-full p-3 rounded-lg border transition-all duration-200 focus:ring-2 focus:ring-offset-0 text-sm font-mono';

export const GoogleDriveSettings: React.FC<GoogleDriveSettingsProps> = ({ settings, onUpdate }) => {
  const runtimeConfig = resolveGoogleDrivePickerConfig(settings);
  const currentOrigin = typeof window !== 'undefined' ? window.location.origin : '';

  return (
    <div
      className="rounded-xl border border-[var(--theme-border-secondary)] bg-[var(--theme-bg-surface-secondary)]/50 p-4 space-y-4"
      data-settings-item="google-drive"
    >
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--theme-accent-primary)]/10 text-[var(--theme-accent-primary)]">
          <HardDriveDownload size={18} />
        </div>
        <div className="min-w-0">
          <div className="text-sm font-medium text-[var(--theme-text-primary)]">Google Drive</div>
          <p className="mt-0.5 text-xs leading-relaxed text-[var(--theme-text-secondary)]">
            Enables the attachment menu to open Google Picker and import private Drive files. Use one Google Cloud
            project for the OAuth Web client, Picker API key, and project number.
          </p>
        </div>
      </div>

      <div className="grid gap-3">
        <label className="space-y-1.5">
          <span className="text-xs font-semibold uppercase tracking-wider text-[var(--theme-text-secondary)]">
            OAuth Web Client ID
          </span>
          <input
            type="text"
            value={settings.googleDriveClientId ?? ''}
            onChange={(event) => onUpdate('googleDriveClientId', event.target.value || null)}
            className={`${INPUT_CLASS} ${SETTINGS_INPUT_CLASS}`}
            placeholder="1234567890-xxxx.apps.googleusercontent.com"
            autoComplete="off"
          />
        </label>

        <label className="space-y-1.5">
          <span className="text-xs font-semibold uppercase tracking-wider text-[var(--theme-text-secondary)]">
            Picker API Key
          </span>
          <input
            type="text"
            value={settings.googleDriveApiKey ?? ''}
            onChange={(event) => onUpdate('googleDriveApiKey', event.target.value || null)}
            className={`${INPUT_CLASS} ${SETTINGS_INPUT_CLASS}`}
            placeholder="AIza..."
            autoComplete="off"
          />
        </label>

        <label className="space-y-1.5">
          <span className="text-xs font-semibold uppercase tracking-wider text-[var(--theme-text-secondary)]">
            Project Number / App ID
          </span>
          <input
            type="text"
            inputMode="numeric"
            value={settings.googleDriveAppId ?? ''}
            onChange={(event) => onUpdate('googleDriveAppId', event.target.value || null)}
            className={`${INPUT_CLASS} ${SETTINGS_INPUT_CLASS}`}
            placeholder="123456789012"
            autoComplete="off"
          />
        </label>
      </div>

      <div className="rounded-lg border border-[var(--theme-border-secondary)] bg-[var(--theme-bg-tertiary)]/30 p-3 text-[11px] leading-relaxed text-[var(--theme-text-secondary)] space-y-1">
        <p>
          Enable both Google Picker API and Google Drive API. The OAuth client must allow this JavaScript origin:
          {currentOrigin ? <code className="ml-1 font-mono text-[var(--theme-text-primary)]">{currentOrigin}</code> : null}
        </p>
        <p>
          Restrict the browser API key to your site plus <code className="font-mono">https://docs.google.com/*</code>,
          and restrict APIs to Google Picker API + Google Drive API.
        </p>
        <p>
          You can also configure <code className="font-mono">VITE_GOOGLE_DRIVE_CLIENT_ID</code>,{' '}
          <code className="font-mono">VITE_GOOGLE_DRIVE_API_KEY</code>, and{' '}
          <code className="font-mono">VITE_GOOGLE_DRIVE_APP_ID</code>.
        </p>
      </div>

      <div className="text-xs">
        {runtimeConfig ? (
          <span className="text-emerald-600 dark:text-emerald-400">Google Drive picker is configured.</span>
        ) : (
          <span className="text-[var(--theme-text-secondary)]">Enter all three values before using Google Drive.</span>
        )}
      </div>
    </div>
  );
};
