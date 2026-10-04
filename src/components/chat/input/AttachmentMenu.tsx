import React from 'react';
import { Paperclip, FolderOpen, Library, FileArchive, Layers, Film, HardDriveDownload } from 'lucide-react';
import { useI18n } from '@/contexts/I18nContext';
import { type AttachmentAction, GEMINI_PROVIDER_ID } from '@/types';
import {
  IconUpload,
  IconGallery,
  IconCamera,
  IconScreenshot,
  IconMicrophone,
  IconCloud,
  IconFileEdit,
  IconYoutube,
} from '@/components/icons';
import { CHAT_INPUT_BUTTON_CLASS } from '@/constants/buttonClasses';
import { MENU_ITEM_BUTTON_CLASS, MENU_ITEM_DEFAULT_STATE_CLASS } from '@/constants/menuClasses';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/shared/DropdownMenu';
import { useIsMobile } from '@/hooks/ui/useDevice';
import { useChatInputActionsContext } from './ChatInputContext';
import { isGemmaModel } from '@/utils/model/modelCapabilities';

const attachIconSize = 20;
const menuIconSize = 18;

export const AttachmentMenu: React.FC = () => {
  const {
    onAttachmentAction,
    disabled,
    isImageGenerationModel,
    isTranscribeModel,
    canAddYouTubeVideo,
    currentModelId,
    providerId,
  } = useChatInputActionsContext();
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const isAttachmentDisabled = disabled;
  const isGemma = isGemmaModel(currentModelId);
  const isGeminiNative = providerId === undefined || providerId === GEMINI_PROVIDER_ID;

  const isItemActionTriggeredRef = React.useRef(false);

  const handleAction = (action: AttachmentAction) => {
    isItemActionTriggeredRef.current = true;
    onAttachmentAction(action);
  };

  // The menu opens upward (bottom anchored to the trigger button), so the most
  // frequently used items go at the bottom, closest to the input area.
  const menuItems = [
    { labelKey: 'attachMenuCreateText', icon: <IconFileEdit size={menuIconSize} />, action: 'text' },
    ...(isGeminiNative && canAddYouTubeVideo
      ? [{ labelKey: 'attachMenuAddByUrl', icon: <IconYoutube size={menuIconSize} />, action: 'url' } as const]
      : []),
    ...(isGeminiNative
      ? [
          {
            labelKey: 'attachMenuUpload',
            icon: <HardDriveDownload size={menuIconSize} />,
            action: 'drive',
          } as const,
          { labelKey: 'attachMenuAddById', icon: <IconCloud size={menuIconSize} />, action: 'id' } as const,
        ]
      : []),
    ...(!isMobile
      ? ([
          { labelKey: 'attachMenuImportFolder', icon: <FolderOpen size={menuIconSize} />, action: 'folder' },
          { labelKey: 'attachMenuScreenshot', icon: <IconScreenshot size={menuIconSize} />, action: 'screenshot' },
        ] as const)
      : ([{ labelKey: 'attachMenuImportZip', icon: <FileArchive size={menuIconSize} />, action: 'zip' }] as const)),
    { labelKey: 'attachMenuRecordAudio', icon: <IconMicrophone size={menuIconSize} />, action: 'recorder' },
    ...(isMobile
      ? ([
          { labelKey: 'attachMenuTakePhoto', icon: <IconCamera size={menuIconSize} />, action: 'camera' },
          { labelKey: 'attachMenuGallery', icon: <IconGallery size={menuIconSize} />, action: 'gallery' },
        ] as const)
      : []),
    { labelKey: 'attachMenuMultimodalSearch', icon: <Layers size={menuIconSize} />, action: 'multimodal_search' },
    { labelKey: 'attachMenuLibrary', icon: <Library size={menuIconSize} />, action: 'library' },
    { labelKey: 'transcribeUploadVideo', icon: <Film size={menuIconSize} />, action: 'video' },
    { labelKey: 'attachMenuUpload', icon: <IconUpload size={menuIconSize} />, action: 'upload' },
  ] as const;

  const filteredMenuItems = isTranscribeModel
    ? menuItems.filter(
        (item) =>
          item.action === 'upload' ||
          item.action === 'video' ||
          item.action === 'library' ||
          item.action === 'multimodal_search' ||
          item.action === 'recorder' ||
          item.action === 'drive' ||
          item.action === 'id',
      )
    : isImageGenerationModel
      ? menuItems.filter(
          (item) =>
            item.action === 'upload' ||
            item.action === 'library' ||
            item.action === 'multimodal_search' ||
            item.action === 'gallery' ||
            item.action === 'camera' ||
            item.action === 'screenshot' ||
            item.action === 'drive' ||
            item.action === 'id',
        )
      : isGemma
        ? menuItems.filter((item) => item.action !== 'recorder')
        : menuItems;

  return (
    <div className="relative">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={isAttachmentDisabled}
            className={`${CHAT_INPUT_BUTTON_CLASS} text-[var(--theme-icon-attach)] bg-transparent hover:bg-[var(--theme-bg-tertiary)] data-[state=open]:bg-[var(--theme-bg-tertiary)] data-[state=open]:text-[var(--theme-text-primary)]`}
            aria-label={t('attachMenuAria')}
            title={t('attachMenuTitle')}
            aria-haspopup="true"
          >
            <Paperclip size={attachIconSize} strokeWidth={2} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side="top"
          align="start"
          sideOffset={8}
          className="w-60 max-h-[75vh] overflow-y-auto custom-scrollbar py-1.5 shadow-premium"
          onCloseAutoFocus={(event) => {
            if (isItemActionTriggeredRef.current) {
              event.preventDefault();
              isItemActionTriggeredRef.current = false;
            }
          }}
        >
          {filteredMenuItems.map((item) => (
            <DropdownMenuItem
              key={item.action}
              asChild
              onClick={() => handleAction(item.action)}
              className="cursor-pointer"
            >
              <button
                type="button"
                role="menuitem"
                className={`${MENU_ITEM_BUTTON_CLASS} ${MENU_ITEM_DEFAULT_STATE_CLASS} w-full px-4 py-2.5 gap-3.5`}
              >
                <span className="text-[var(--theme-text-secondary)]">{item.icon}</span>
                <span className="font-medium">{item.action === 'drive' ? 'Google Drive' : t(item.labelKey)}</span>
              </button>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
};
