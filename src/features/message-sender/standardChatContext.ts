import { createChatHistoryForApi } from '@/utils/chat/builder';
import {
  buildAudioLocateDirective,
  buildImageLocateDirective,
  buildPdfLocateDirective,
  buildVideoLocateDirective,
} from '@/utils/media-nav/locateMarker';
import { isLiveArtifactsModeFromSettings } from '@/utils/live-ui/liveUiMode';
import { getLiveArtifactsSystemPromptOverride } from '@/utils/live-ui/liveUiPromptSettings';
import { composeSystemInstruction } from '@/features/prompts/promptCompositor';
import { applyLiveArtifactsUserDirective } from '@/features/prompts/promptRegistry';
import {
  collectSessionMediaFiles,
  isAudioFile,
  isImageFile,
  isPdfFile,
  isNavigableVideoFile,
  partsContainAudio,
  partsContainImage,
  partsContainPdf,
  partsContainVideo,
} from '@/utils/media-nav/sessionMediaFiles';
import { isServerCodeExecutionMode } from '@/utils/code/codeExecution';
import { isGemmaModel, isImageGenerationModel, shouldStripThinkingFromContext } from '@/utils/model/modelCapabilities';
import { createMcpClientFunctions } from '@/features/mcp/mcpClientFunctions';
import { requestToolApproval } from '@/stores/mcp/mcpApprovalStore';
import { selectServersForTurn, useMcpRuntimeStore } from '@/stores/mcp/mcpRuntimeStore';
import { useVirtualMcpStore, isVirtualServerActiveForTurn } from '@/stores/mcp/virtualMcpStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { createStandardClientFunctions } from '@/features/standard-chat/standardClientFunctions';
import { collectLocalPythonInputFiles } from '@/features/local-python/executionFiles';
import { getPyodideService } from '@/features/local-python/loadPyodideService';
import { resolveAppLanguage } from '@/i18n/languageRegistry';
import type {
  ChatMessage,
  ChatSettings as IndividualChatSettings,
  StandardClientFunctions,
  UploadedFile,
} from '@/types';
import type { ContentPart } from '@/types/chat';
import type { StandardChatProps } from './messageSenderTypes';

export interface PrepareStandardChatContextParams {
  appSettings: StandardChatProps['appSettings'];
  sessionToUpdate: IndividualChatSettings;
  apiModelId: string;
  activeProvider: unknown;
  baseMessagesForApi: ChatMessage[];
  finalRole: 'user' | 'model';
  turnFinalParts: ContentPart[];
  isContinueMode: boolean;
  isRawMode: boolean;
  enrichedFiles: UploadedFile[];
  textToUse: string;
  abortSignal: AbortSignal;
}

export interface PreparedStandardChatContext {
  appLanguage: string;
  isVisualFormattingActive: boolean;
  shouldStripThinking: boolean;
  alwaysKeepThinking: boolean;
  finalParts: ContentPart[];
  historyForChat: Array<{ role: 'user' | 'model'; parts: ContentPart[] }>;
  effectiveSystemInstruction?: string;
  standardClientFunctions: StandardClientFunctions;
  mcpClientFunctions: StandardClientFunctions;
  combinedClientFunctions: StandardClientFunctions;
}

export const prepareStandardChatContext = async ({
  appSettings,
  sessionToUpdate,
  apiModelId,
  activeProvider,
  baseMessagesForApi,
  finalRole,
  turnFinalParts,
  isContinueMode,
  isRawMode,
  enrichedFiles,
  textToUse,
  abortSignal,
}: PrepareStandardChatContextParams): Promise<PreparedStandardChatContext> => {
  const appLanguage = resolveAppLanguage(appSettings.language);
  const customLiveArtifactsPrompt = getLiveArtifactsSystemPromptOverride(
    appSettings,
    appSettings.liveArtifactsPromptMode,
  );

  const isVisualFormattingActive = Boolean(sessionToUpdate.isVisualFormattingActive);
  const finalParts =
    isVisualFormattingActive && finalRole === 'user' && !isContinueMode
      ? applyLiveArtifactsUserDirective(turnFinalParts, appLanguage)
      : turnFinalParts;

  const isLiveArtifactsActive = isLiveArtifactsModeFromSettings({
    isLiveArtifactsEnabled: sessionToUpdate.isLiveArtifactsEnabled,
    isVisualFormattingActive,
    systemInstruction: sessionToUpdate.systemInstruction,
    promptMode: appSettings.liveArtifactsPromptMode,
    liveArtifactsSystemPrompt: appSettings.liveArtifactsSystemPrompt,
    liveArtifactsSystemPrompts: appSettings.liveArtifactsSystemPrompts,
  });
  const shouldIncludeLiveArtifactsInSystemInstruction = isLiveArtifactsActive || isVisualFormattingActive;

  const alwaysKeepThinking =
    sessionToUpdate.alwaysKeepThinkingInContext ?? appSettings.alwaysKeepThinkingInContext ?? false;
  const shouldStripThinking = shouldStripThinkingFromContext(
    apiModelId,
    sessionToUpdate.hideThinkingInContext ?? appSettings.hideThinkingInContext,
    alwaysKeepThinking,
  );
  const isVertexExpress = appSettings.useCustomApiConfig && appSettings.googleApiBackend === 'vertex-express';
  const historyForChat = await createChatHistoryForApi(
    baseMessagesForApi,
    shouldStripThinking,
    apiModelId,
    isServerCodeExecutionMode(sessionToUpdate),
    alwaysKeepThinking,
    isVertexExpress,
  );

  // Media Locate Protocols: augment the system instruction when preset is enabled and matching media is present
  const hasPdfMedia =
    enrichedFiles.some(isPdfFile) ||
    partsContainPdf(finalParts) ||
    baseMessagesForApi.some((message) => message.files?.some(isPdfFile));
  const hasVideoMedia =
    enrichedFiles.some(isNavigableVideoFile) ||
    partsContainVideo(finalParts) ||
    baseMessagesForApi.some((message) => message.files?.some(isNavigableVideoFile));
  const hasAudioMedia =
    enrichedFiles.some(isAudioFile) ||
    partsContainAudio(finalParts) ||
    baseMessagesForApi.some((message) => message.files?.some(isAudioFile));
  const hasImageMedia =
    enrichedFiles.some(isImageFile) ||
    partsContainImage(finalParts) ||
    baseMessagesForApi.some((message) => message.files?.some(isImageFile));
  const { pdfs, videos, audios, images } = collectSessionMediaFiles(enrichedFiles, baseMessagesForApi);
  const locateDirectives = [
    sessionToUpdate.isPdfNavEnabled && hasPdfMedia ? buildPdfLocateDirective(pdfs.map((file) => file.name)) : '',
    sessionToUpdate.isVideoNavEnabled && hasVideoMedia
      ? buildVideoLocateDirective(videos.map((file) => file.name))
      : '',
    sessionToUpdate.isAudioNavEnabled && hasAudioMedia
      ? buildAudioLocateDirective(audios.map((file) => file.name))
      : '',
    sessionToUpdate.isImageNavEnabled && hasImageMedia
      ? buildImageLocateDirective(images.map((file) => file.name))
      : '',
  ].filter(Boolean);
  const effectiveSystemInstruction = await composeSystemInstruction({
    userInstruction: sessionToUpdate.systemInstruction,
    isLiveArtifactsEnabled: shouldIncludeLiveArtifactsInSystemInstruction,
    liveArtifactsPromptMode: appSettings.liveArtifactsPromptMode,
    customLiveArtifactsPrompt: shouldIncludeLiveArtifactsInSystemInstruction ? customLiveArtifactsPrompt : null,
    visionPromptMode: sessionToUpdate.visionPromptMode,
    taskSuggestionMode: sessionToUpdate.taskSuggestionMode,
    isDeepSearchEnabled: !activeProvider && Boolean(sessionToUpdate.isDeepSearchEnabled),
    isLocalPythonEnabled: Boolean(sessionToUpdate.isLocalPythonEnabled),
    isGemmaModel: isGemmaModel(apiModelId),
    locateDirectives,
    language: appLanguage,
  });

  const localPythonContextMessages =
    finalRole === 'user'
      ? [
          ...baseMessagesForApi,
          {
            id: 'temp-standard-user',
            role: 'user' as const,
            content: textToUse.trim(),
            files: enrichedFiles,
            timestamp: new Date(),
          },
        ]
      : baseMessagesForApi;
  const standardClientFunctions = !activeProvider
    ? createStandardClientFunctions({
        isLocalPythonEnabled:
          !!sessionToUpdate.isLocalPythonEnabled &&
          finalRole === 'user' &&
          !isRawMode &&
          !isImageGenerationModel(apiModelId),
        inputFiles: collectLocalPythonInputFiles(
          [
            ...localPythonContextMessages,
            {
              id: 'temp-standard-tool-target',
              role: 'model',
              content: '',
              timestamp: new Date(),
            },
          ],
          'temp-standard-tool-target',
        ),
        runPython: async (code, options) => {
          const pyodideService = await getPyodideService();
          return pyodideService.runPython(code, options);
        },
      })
    : {};

  const runtimeSelection = useMcpRuntimeStore.getState();
  const enabledMcpServers = selectServersForTurn(appSettings.mcpServers ?? [], runtimeSelection);
  const virtualMcpStore = useVirtualMcpStore.getState();
  const activeVirtualServers = virtualMcpStore
    .getEnabledVirtualServers()
    .filter((vs) => isVirtualServerActiveForTurn(vs.id, runtimeSelection));
  const isMcpEnabledForTurn =
    finalRole === 'user' &&
    !isRawMode &&
    !isImageGenerationModel(apiModelId) &&
    (enabledMcpServers.length > 0 || activeVirtualServers.length > 0);

  // Discovery is resilient: failures log and yield {} so chat continues without MCP tools.
  const mcpClientFunctions = isMcpEnabledForTurn
    ? await createMcpClientFunctions({
        servers: enabledMcpServers,
        virtualServers: activeVirtualServers,
        abortSignal,
        requestApproval: (request) => requestToolApproval(request, abortSignal),
        // Discovery is cached for 30s; re-check disables at call time.
        resolveLatestServers: () => useSettingsStore.getState().appSettings.mcpServers,
      })
    : {};

  const combinedClientFunctions = {
    ...standardClientFunctions,
    ...mcpClientFunctions,
  };

  return {
    appLanguage,
    isVisualFormattingActive,
    shouldStripThinking,
    alwaysKeepThinking,
    finalParts,
    historyForChat: historyForChat as Array<{ role: 'user' | 'model'; parts: ContentPart[] }>,
    effectiveSystemInstruction,
    standardClientFunctions,
    mcpClientFunctions,
    combinedClientFunctions,
  };
};

export const standardChatContext = prepareStandardChatContext;
