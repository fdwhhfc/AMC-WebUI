import { logService } from '@/services/logService';
import { buildContentParts } from '@/utils/chat/builder';
import { isServerCodeExecutionMode } from '@/utils/code/codeExecution';
import { getModelCapabilities, bansModelTurnPrefill } from '@/utils/model/modelCapabilities';
import { resolveChatApiRoute } from '@/utils/chat/chatApiRoute';
import { getLiveArtifactsUserDirective } from '@/features/prompts/liveUi';
import { resolveAppLanguage } from '@/i18n/languageRegistry';
import type { UploadedFile } from '@/types';
import { runOptimisticMessagePipeline, type MessageLifecycleRunner } from './messagePipeline';
import { resolveStandardChatTurn } from './standardChatTurn';
import { performStandardChatApiCall } from './standardChatApiCall';
import { waitForFilesReady } from './waitForFilesReady';
import { useChatStore } from '@/stores/chatStore';
import { updateMessageInSession } from '@/utils/chat/sessionMutations';
import { ensureFilesApiReferences, formatFileReferenceErrorMessage } from './fileApiReference';
import { prepareFilesForOpenAICompatibleMode } from './openaiCompatibleFiles';
import { getTranslator } from '@/i18n/translations';
import { formatMessageSenderText } from './i18nFormat';
import type { GetStreamHandlers, StandardChatProps } from './messageSenderTypes';
import type { PreparedModelRequest } from './useModelRequestRunner';

export interface SendStandardMessageParams {
  props: Omit<StandardChatProps, 'getStreamHandlers'>;
  getStreamHandlers: GetStreamHandlers;
  runMessageLifecycle: MessageLifecycleRunner;
  text: string;
  files: UploadedFile[];
  editingMessageId: string | null;
  retryModelMessageId?: string;
  activeModelId: string;
  isContinueMode?: boolean;
  isFastMode?: boolean;
  request: PreparedModelRequest;
}

export const sendStandardMessage = async (params: SendStandardMessageParams) => {
  const {
    props,
    getStreamHandlers,
    runMessageLifecycle,
    text: textToUse,
    files: filesToUse,
    editingMessageId: effectiveEditingId,
    retryModelMessageId,
    activeModelId,
    isContinueMode = false,
    isFastMode = false,
    request,
  } = params;
  const {
    appSettings,
    currentChatSettings,
    messages,
    setEditingMessageId,
    aspectRatio,
    imageSize,
    imageOutputMode,
    userScrolledUpRef,
    activeSessionId,
    setActiveSessionId,
    updateAndPersistSessions,
    sessionKeyMapRef,
  } = props;
  const effectiveActiveModelId = resolveChatApiRoute(appSettings, currentChatSettings).modelId || activeModelId;
  const settingsForPersistence = { ...currentChatSettings };
  const settingsForApi = { ...currentChatSettings };

  if (!settingsForApi.systemInstruction?.trim() && appSettings.systemInstruction) {
    settingsForApi.systemInstruction = appSettings.systemInstruction;
    settingsForPersistence.systemInstruction = appSettings.systemInstruction;
  }

  if (isFastMode) {
    const capabilities = getModelCapabilities(effectiveActiveModelId);
    // gemini-3.7-flash / gemini-3.8-flash rejects MINIMAL with an API error — fall back to LOW there.
    const targetLevel =
      capabilities.isGemini3FlashModel && capabilities.supportsMinimalThinkingLevel ? 'MINIMAL' : 'LOW';

    settingsForApi.thinkingLevel = targetLevel;
    settingsForApi.thinkingBudget = 0;
    logService.info(`Fast Mode activated (One-off): Overriding thinking level to ${targetLevel}.`);
  }

  const { keyToUse, shouldLockKey, generationId, generationStartTime, abortController: newAbortController } = request;

  const successfullyProcessedFiles = filesToUse.filter(
    (file) => file.uploadState === 'active' && !file.error && !file.isProcessing,
  );
  const preferCodeExecutionFileInputs = isServerCodeExecutionMode(settingsForApi);

  const appLanguage = resolveAppLanguage(appSettings.language);
  const directive = getLiveArtifactsUserDirective(appLanguage);

  const isVisualFormattingActive = Boolean(settingsForApi.isVisualFormattingActive);
  let effectiveUserText = textToUse.trim();
  if (
    isVisualFormattingActive &&
    !isContinueMode &&
    !(
      (directive && effectiveUserText.startsWith(directive)) ||
      (effectiveUserText.includes('Live Artifacts') &&
        (effectiveUserText.includes('排版指令') ||
          effectiveUserText.includes('Layout Directive') ||
          effectiveUserText.includes('HTML 卡片') ||
          effectiveUserText.includes('HTML 作品') ||
          effectiveUserText.includes('HTML 产物') ||
          effectiveUserText.includes('HTML artifact')))
    )
  ) {
    effectiveUserText = effectiveUserText ? `${directive}\n\n${effectiveUserText}` : directive;
  }

  const { contentParts: promptParts, enrichedFiles } = await buildContentParts(
    effectiveUserText,
    successfullyProcessedFiles,
    effectiveActiveModelId,
    settingsForApi.mediaResolution,
    preferCodeExecutionFileInputs,
  );

  // Gemini 3.6+ rejects prefilled model turns (HTTP 400). Raw mode ends the payload with a
  // model role `<thinking>` prefix, so it is unsafe for those models even if listed as raw-capable.
  const isRawMode = Boolean(
    (settingsForApi.isRawModeEnabled ?? appSettings.isRawModeEnabled) &&
    !isContinueMode &&
    !bansModelTurnPrefill(effectiveActiveModelId) &&
    getModelCapabilities(effectiveActiveModelId).supportsRawReasoningPrefill,
  );

  const lastMessage = messages[messages.length - 1];
  const cumulativeTotalTokens = lastMessage?.cumulativeTotalTokens || 0;
  const placement =
    isContinueMode && effectiveEditingId
      ? ({ type: 'continue-model', targetMessageId: effectiveEditingId } as const)
      : retryModelMessageId
        ? ({ type: 'retry-model', targetMessageId: retryModelMessageId } as const)
        : ({ type: 'append-turn' } as const);

  await runOptimisticMessagePipeline({
    activeSessionId,
    appSettings,
    currentChatSettings: settingsForPersistence,
    updateAndPersistSessions,
    setActiveSessionId,
    setActiveMessages: props.setActiveMessages,
    text: effectiveUserText,
    files: filesToUse.length ? filesToUse : undefined,
    generationId,
    generationStartTime,
    editingMessageId: effectiveEditingId,
    shouldGenerateTitle: (session) => !activeSessionId || session?.title === 'New Chat',
    shouldLockKey,
    keyToLock: keyToUse,
    abortController: newAbortController,
    errorPrefix: 'Error',
    runMessageLifecycle,
    placement,
    userMessageOptions: {
      apiParts: promptParts,
      cumulativeTotalTokens: cumulativeTotalTokens > 0 ? cumulativeTotalTokens : undefined,
    },
    modelMessageOptions: {
      content: isRawMode ? '<thinking>' : '',
    },
    afterStart: (turn) => {
      userScrolledUpRef.current = false;
      sessionKeyMapRef.current.set(turn.finalSessionId, keyToUse);
      if (effectiveEditingId) {
        setEditingMessageId(null);
      }
    },
    execute: async (turn) => {
      let effectivePromptParts = promptParts;
      let effectiveEnrichedFiles = enrichedFiles;

      if (filesToUse.some((file) => file.uploadState === 'uploading' || file.isProcessing)) {
        const waitResult = await waitForFilesReady(
          filesToUse.map((file) => file.id),
          newAbortController.signal,
        );

        const t = getTranslator(props.language);
        if (!waitResult.ok) {
          if (newAbortController.signal.aborted) {
            return undefined;
          }
          return {
            patch: {
              content: formatMessageSenderText(t('messageSenderErrorWithPrefix'), {
                prefix: t('messageSenderApiErrorPrefix'),
                message: waitResult.error || t('messageSenderFileUploadFailedBeforeSend'),
              }),
              isLoading: false,
              generationEndTime: new Date(),
            },
          };
        }

        const state = useChatStore.getState();
        const activeMessagesMatch =
          turn.finalSessionId === state.activeSessionId
            ? state.activeMessages.find((message) => message.id === turn.userMessage?.id)
            : undefined;
        const currentSession = state.savedSessions.find((session) => session.id === turn.finalSessionId);
        const currentUserMsg =
          activeMessagesMatch ?? currentSession?.messages.find((message) => message.id === turn.userMessage?.id);
        const readyFiles = currentUserMsg?.files ?? filesToUse;

        let filesReadyForSend: UploadedFile[];
        const apiRoute = resolveChatApiRoute(appSettings, settingsForApi);
        const isVertexExpress =
          apiRoute.apiMode !== 'third-party' &&
          appSettings.useCustomApiConfig &&
          appSettings.googleApiBackend === 'vertex-express';
        if (apiRoute.apiMode === 'third-party') {
          const openAiFilesResult = prepareFilesForOpenAICompatibleMode(readyFiles);
          if (!openAiFilesResult.ok) {
            return {
              patch: {
                content: formatMessageSenderText(t('messageSenderErrorWithPrefix'), {
                  prefix: t('messageSenderApiErrorPrefix'),
                  message: formatFileReferenceErrorMessage(openAiFilesResult, t),
                }),
                isLoading: false,
                generationEndTime: new Date(),
              },
            };
          }
          filesReadyForSend = openAiFilesResult.files;
        } else if (isVertexExpress) {
          // Vertex Express does not expose the Gemini Files API. Keep the local
          // Blob/File and let buildContentParts emit native inlineData.
          filesReadyForSend = readyFiles.map((file) => ({
            ...file,
            transferStrategy: 'inline' as const,
          }));
        } else {
          const fileRefResult = await ensureFilesApiReferences({
            files: readyFiles,
            apiKey: keyToUse,
            abortSignal: newAbortController.signal,
            allowDegrade: Boolean(effectiveEditingId),
          });
          if (!fileRefResult.ok) {
            return {
              patch: {
                content: formatMessageSenderText(t('messageSenderErrorWithPrefix'), {
                  prefix: t('messageSenderApiErrorPrefix'),
                  message: formatFileReferenceErrorMessage(fileRefResult, t),
                }),
                isLoading: false,
                generationEndTime: new Date(),
              },
            };
          }
          filesReadyForSend = fileRefResult.files;
        }

        const built = await buildContentParts(
          effectiveUserText,
          filesReadyForSend,
          effectiveActiveModelId,
          settingsForApi.mediaResolution,
          preferCodeExecutionFileInputs,
        );
        effectivePromptParts = built.contentParts;
        effectiveEnrichedFiles = built.enrichedFiles;

        if (turn.userMessage?.id) {
          updateAndPersistSessions((prev) =>
            updateMessageInSession(prev, turn.finalSessionId, turn.userMessage!.id, (msg) => ({
              ...msg,
              files: effectiveEnrichedFiles,
              apiParts: effectivePromptParts,
            })),
          );
        }
      }

      await performStandardChatApiCall({
        appSettings,
        messages,
        updateAndPersistSessions,
        getStreamHandlers,
        aspectRatio,
        imageSize,
        imageOutputMode,
        resolveTurn: resolveStandardChatTurn,
        finalSessionId: turn.finalSessionId,
        generationId,
        generationStartTime,
        keyToUse,
        activeModelId: effectiveActiveModelId,
        promptParts: effectivePromptParts,
        effectiveEditingId,
        isContinueMode,
        isRawMode,
        sessionToUpdate: settingsForApi,
        newAbortController,
        textToUse: effectiveUserText,
        enrichedFiles: effectiveEnrichedFiles,
      });

      return undefined;
    },
  });
};

export const standardChatStrategy = sendStandardMessage;
