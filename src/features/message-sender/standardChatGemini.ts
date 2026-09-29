import { createChatHistoryForApi, appendTurnToHistory } from '@/utils/chat/builder';
import { toError } from '@/utils/errorMessage';
import { createMessage } from '@/utils/chat/session';
import { isServerCodeExecutionMode } from '@/utils/code/codeExecution';
import { isGemini3Model } from '@/utils/model/modelCapabilities';
import { appendFunctionDeclarationsToTools, buildGenerationConfig } from '@/services/api/generationConfig';
import {
  generateContentTurnApi,
  sendStatelessMessageNonStreamApi,
  sendStatelessMessageStreamApi,
} from '@/services/api/chatApi';
import { runStandardToolLoop } from '@/features/standard-chat/standardToolLoop';
import { updateSessionById } from '@/utils/chat/sessionMutations';
import {
  recordPendingStreamJob,
  advancePendingStreamJobSeq,
  generateJobSecret,
} from '@/features/stream-jobs/amcStreamJobs';
import { isGeminiProxyRelativePath } from '@/services/api/geminiApiBaseUrl';
import { useModelPreferencesStore } from '@/stores/modelPreferencesStore';
import { useChatStore } from '@/stores/chatStore';
import { ensureHistoryFilesApiReferences, resolveUploadableFile } from './fileApiReference';
import { uploadFileApi } from '@/services/api/fileApi';
import { getUploadLifecycleForGeminiState } from '@/utils/file-upload/fileUploadPolicy';
import {
  extractFilesApiIdentifierFromError,
  formatHistoryFileApiUnavailablePartText,
  getApiKeyFingerprint,
  getGeminiFilesApiNameFromUri,
  invalidateSessionFilesApiReferences,
  isFilesApiPermissionDeniedError,
  toFileApiExpirationTime,
} from '@/utils/chat/geminiFilesApi';
import { getGeminiKeyForRequest } from '@/utils/api/apiKeySelection';
import { getTranslator } from '@/i18n/translations';
import { resolveAppLanguage } from '@/i18n/languageRegistry';
import { applyLiveArtifactsUserDirective } from '@/features/prompts/promptRegistry';
import { logService } from '@/services/logService';
import { routeThrownStreamError } from './standardChatThirdParty';
import type {
  ChatMessage,
  ChatSettings as IndividualChatSettings,
  NonStreamMessageCompleteHandler,
  StandardClientFunctions,
  UploadedFile,
} from '@/types';
import type { ContentPart } from '@/types/chat';
import type { SessionsUpdater, StandardChatProps, StreamHandlerFunctions } from './messageSenderTypes';
import type { resolveStandardChatTurn } from './standardChatTurn';

export interface ExecuteGeminiChatParams {
  appSettings: StandardChatProps['appSettings'];
  sessionToUpdate: IndividualChatSettings;
  apiModelId: string;
  keyToUse: string;
  effectiveSystemInstruction?: string;
  aspectRatio: string;
  imageSize?: string;
  imageOutputMode: StandardChatProps['imageOutputMode'];
  standardClientFunctions: StandardClientFunctions;
  mcpFunctionDeclarations: unknown[];
  combinedClientFunctions: StandardClientFunctions;
  historyForChat: Array<{ role: 'user' | 'model'; parts: ContentPart[] }>;
  finalRole: 'user' | 'model';
  finalParts: ContentPart[];
  finalSessionId: string;
  generationId: string;
  generationStartTime: Date;
  newAbortController: AbortController;
  isContinueMode: boolean;
  isRawMode: boolean;
  promptParts: ContentPart[];
  textToUse: string;
  enrichedFiles: UploadedFile[];
  effectiveEditingId: string | null;
  resolveTurn: typeof resolveStandardChatTurn;
  shouldStripThinking: boolean;
  alwaysKeepThinking: boolean;
  isVisualFormattingActive: boolean;
  appLanguage: string;
  updateAndPersistSessions: SessionsUpdater;
  insertInternalToolMessages: (messages: ChatMessage[]) => void;
  streamOnPart: StreamHandlerFunctions['streamOnPart'];
  onThoughtChunk: StreamHandlerFunctions['onThoughtChunk'];
  streamOnError: (error: Error) => void | Promise<void>;
  streamOnComplete: StreamHandlerFunctions['streamOnComplete'];
  wrappedStreamOnComplete: StreamHandlerFunctions['streamOnComplete'];
  nonStreamOnComplete: NonStreamMessageCompleteHandler;
}

export const executeGeminiChat = async ({
  appSettings,
  sessionToUpdate,
  apiModelId,
  keyToUse,
  effectiveSystemInstruction,
  aspectRatio,
  imageSize,
  imageOutputMode,
  standardClientFunctions,
  mcpFunctionDeclarations,
  combinedClientFunctions,
  historyForChat,
  finalRole,
  finalParts,
  finalSessionId,
  generationId,
  generationStartTime,
  newAbortController,
  isContinueMode,
  isRawMode,
  promptParts,
  textToUse,
  enrichedFiles,
  effectiveEditingId,
  resolveTurn,
  shouldStripThinking,
  alwaysKeepThinking,
  isVisualFormattingActive,
  appLanguage,
  updateAndPersistSessions,
  insertInternalToolMessages,
  streamOnPart,
  onThoughtChunk,
  streamOnError,
  streamOnComplete: _streamOnComplete,
  wrappedStreamOnComplete,
  nonStreamOnComplete,
}: ExecuteGeminiChatParams): Promise<void> => {
  const localPythonFunctionDeclarations = Object.values(standardClientFunctions).map(({ declaration }) => declaration);
  const hasRequestedServerSideToolThatNeedsCombination =
    !!sessionToUpdate.isGoogleSearchEnabled ||
    !!sessionToUpdate.isGoogleMapsEnabled ||
    !!sessionToUpdate.isDeepSearchEnabled ||
    !!sessionToUpdate.isUrlContextEnabled;
  const isLocalPythonEnabledForTurn =
    localPythonFunctionDeclarations.length > 0 &&
    (isGemini3Model(apiModelId) || !hasRequestedServerSideToolThatNeedsCombination);

  const customGeminiModel = useModelPreferencesStore.getState().customModels?.find((model) => model.id === apiModelId);
  const geminiParams = customGeminiModel?.parameters;
  const effectiveSession = geminiParams
    ? {
        ...sessionToUpdate,
        temperature: geminiParams.temperature ?? sessionToUpdate.temperature,
        topP: geminiParams.topP ?? sessionToUpdate.topP,
        topK: geminiParams.topK ?? sessionToUpdate.topK,
        maxOutputTokens: geminiParams.maxOutputTokens ?? sessionToUpdate.maxOutputTokens,
        stopSequences: geminiParams.stopSequences ?? sessionToUpdate.stopSequences,
        presencePenalty: geminiParams.presencePenalty ?? sessionToUpdate.presencePenalty,
        frequencyPenalty: geminiParams.frequencyPenalty ?? sessionToUpdate.frequencyPenalty,
        seed: geminiParams.seed ?? sessionToUpdate.seed,
        thinkingBudget: geminiParams.thinkingBudget ?? sessionToUpdate.thinkingBudget,
      }
    : sessionToUpdate;

  const config = await buildGenerationConfig({
    settings: effectiveSession,
    modelId: apiModelId,
    systemInstruction: effectiveSystemInstruction,
    aspectRatio,
    imageSize,
    isLocalPythonEnabled: isLocalPythonEnabledForTurn,
    imageOutputMode,
  });

  const isVertexExpress = appSettings.useCustomApiConfig && appSettings.googleApiBackend === 'vertex-express';
  const requestConfig = appendFunctionDeclarationsToTools(
    apiModelId,
    config,
    [
      ...(isLocalPythonEnabledForTurn ? localPythonFunctionDeclarations : []),
      ...(mcpFunctionDeclarations as Parameters<typeof appendFunctionDeclarationsToTools>[2]),
    ],
    {
      // This field is specific to the Gemini Developer API and is rejected by
      // Vertex AI / Vertex Express.
      includeServerSideToolInvocations: !isVertexExpress,
    },
  );
  const hasFunctionDeclarationsInRequest = !!requestConfig.tools?.some((tool) => 'functionDeclarations' in tool);

  const canJournalStream = isGeminiProxyRelativePath(appSettings) && finalRole === 'user' && !isContinueMode;
  const jobSecret = canJournalStream ? generateJobSecret() : undefined;
  const streamResume = canJournalStream
    ? {
        jobId: generationId,
        jobSecret,
        lastSeq: 0,
        onSeq: (seq: number) => advancePendingStreamJobSeq(finalSessionId, seq),
      }
    : undefined;

  if (canJournalStream) {
    recordPendingStreamJob({
      sessionId: finalSessionId,
      generationId,
      jobId: generationId,
      secret: jobSecret,
      startedAt: generationStartTime.getTime(),
    });
  }

  let autoRetryAttempted = false;

  const handleStreamErrorWithAutoRetry = async (error: Error): Promise<void> => {
    if (!autoRetryAttempted && !newAbortController.signal.aborted && isFilesApiPermissionDeniedError(error)) {
      autoRetryAttempted = true;
      logService.warn('Files API permission error detected during generation. Attempting silent auto-retry.', {
        sessionId: finalSessionId,
        error,
      });

      try {
        const state = useChatStore.getState();
        const currentSession = state.savedSessions.find((session) => session.id === finalSessionId);
        if (currentSession) {
          const invalidatedSession = invalidateSessionFilesApiReferences(currentSession, error);
          updateAndPersistSessions((prev) => updateSessionById(prev, finalSessionId, () => invalidatedSession));

          const freshKeyResult = getGeminiKeyForRequest(appSettings, sessionToUpdate);
          const freshKey = 'key' in freshKeyResult ? freshKeyResult.key : keyToUse;
          const t = getTranslator(resolveAppLanguage(appSettings.language));

          const historyRefResult = await ensureHistoryFilesApiReferences({
            messages: invalidatedSession.messages,
            apiKey: freshKey,
            abortSignal: newAbortController.signal,
            translate: t,
          });

          const sessionWasInvalidated = invalidatedSession !== currentSession;
          if (
            historyRefResult.ok &&
            (historyRefResult.changed || sessionWasInvalidated) &&
            !newAbortController.signal.aborted
          ) {
            updateAndPersistSessions((prev) =>
              updateSessionById(prev, finalSessionId, (session) => ({
                ...session,
                messages: historyRefResult.messages,
              })),
            );

            const { baseMessagesForApi: nextBaseMessages, finalParts: rawRetryParts } = resolveTurn({
              messages: historyRefResult.messages,
              promptParts,
              textToUse,
              enrichedFiles,
              effectiveEditingId,
              isContinueMode,
              isRawMode,
              apiModelId,
            });
            const turnFinalParts =
              isVisualFormattingActive && finalRole === 'user' && !isContinueMode
                ? applyLiveArtifactsUserDirective(rawRetryParts, appLanguage)
                : rawRetryParts;

            const targetIdentifier = extractFilesApiIdentifierFromError(error);
            const reuploadedFilesMap = new Map<string, UploadedFile>();

            for (const file of enrichedFiles) {
              const isTarget =
                !targetIdentifier ||
                (file.fileUri && file.fileUri.includes(targetIdentifier)) ||
                (file.fileApiName && file.fileApiName.includes(targetIdentifier));

              if (isTarget) {
                const uploadable = await resolveUploadableFile(file);
                if (uploadable) {
                  try {
                    const uploaded = await uploadFileApi(
                      freshKey,
                      uploadable,
                      file.type || uploadable.type || 'application/octet-stream',
                      file.name,
                      newAbortController.signal,
                    );
                    const patch = {
                      ...getUploadLifecycleForGeminiState(uploaded.state),
                      fileUri: uploaded.uri,
                      fileApiName: uploaded.name,
                      rawFile: uploadable,
                      fileApiExpirationTime: toFileApiExpirationTime(
                        (uploaded as { expirationTime?: unknown }).expirationTime,
                      ),
                      fileApiKeyFingerprint: getApiKeyFingerprint(freshKey),
                    };
                    reuploadedFilesMap.set(file.fileUri || file.id, { ...file, ...patch });
                  } catch (reuploadErr) {
                    logService.warn('Auto-retry re-upload failed, will degrade file reference', { error: reuploadErr });
                  }
                }
              }
            }

            if (reuploadedFilesMap.size > 0) {
              updateAndPersistSessions((prev) =>
                updateSessionById(prev, finalSessionId, (session) => ({
                  ...session,
                  messages: session.messages.map((message) =>
                    message.files
                      ? {
                          ...message,
                          files: message.files.map((file) => reuploadedFilesMap.get(file.fileUri || file.id) || file),
                        }
                      : message,
                  ),
                })),
              );
            }

            const retryFinalParts = turnFinalParts.map((part) => {
              const fileUri = part.fileData?.fileUri;
              if (!fileUri) return part;
              const isTarget =
                !targetIdentifier ||
                fileUri.includes(targetIdentifier) ||
                Boolean(getGeminiFilesApiNameFromUri(fileUri)?.includes(targetIdentifier));
              if (isTarget) {
                const reuploaded =
                  reuploadedFilesMap.get(fileUri) ||
                  Array.from(reuploadedFilesMap.values()).find(
                    (file) =>
                      file.fileUri === fileUri || (targetIdentifier && file.fileApiName?.includes(targetIdentifier)),
                  );
                if (reuploaded?.fileUri) {
                  return { fileData: { mimeType: reuploaded.type, fileUri: reuploaded.fileUri } };
                }

                const fileName =
                  enrichedFiles.find(
                    (file) =>
                      file.fileUri === fileUri ||
                      Boolean(
                        targetIdentifier &&
                        ((file.fileApiName && file.fileApiName.includes(targetIdentifier)) ||
                          (file.fileUri && file.fileUri.includes(targetIdentifier))),
                      ),
                  )?.name || (targetIdentifier ? `File ${targetIdentifier}` : 'file');
                return { text: formatHistoryFileApiUnavailablePartText(fileName) };
              }
              return part;
            });

            const retryHistoryForChat = await createChatHistoryForApi(
              nextBaseMessages,
              shouldStripThinking,
              apiModelId,
              isServerCodeExecutionMode(sessionToUpdate),
              alwaysKeepThinking,
              isVertexExpress,
            );

            if (hasFunctionDeclarationsInRequest) {
              try {
                const toolLoopResult = await runStandardToolLoop({
                  initialContents: appendTurnToHistory(retryHistoryForChat, finalRole, retryFinalParts),
                  clientFunctions: combinedClientFunctions,
                  abortSignal: newAbortController.signal,
                  omitFunctionCallIdsFromWire: isVertexExpress,
                  onToolCallsStarted: (modelContent) => {
                    insertInternalToolMessages([
                      createMessage('model', '', {
                        apiParts: modelContent.parts,
                        isInternalToolMessage: true,
                        toolParentMessageId: generationId,
                      }),
                    ]);
                  },
                  onToolResponsesSettled: (functionResponseParts) => {
                    insertInternalToolMessages([
                      createMessage('user', '', {
                        apiParts: functionResponseParts,
                        isInternalToolMessage: true,
                        toolParentMessageId: generationId,
                      }),
                    ]);
                  },
                  runTurn: (contents) =>
                    generateContentTurnApi(freshKey, apiModelId, contents, requestConfig, newAbortController.signal),
                });

                for (const part of toolLoopResult.finalTurn.parts) {
                  streamOnPart(part, { recordFirstToken: false });
                }
                if (toolLoopResult.finalTurn.thoughts) {
                  onThoughtChunk(toolLoopResult.finalTurn.thoughts, { recordFirstToken: false });
                }
                wrappedStreamOnComplete(
                  toolLoopResult.finalTurn.usage,
                  toolLoopResult.finalTurn.grounding,
                  toolLoopResult.finalTurn.urlContext,
                  toolLoopResult.generatedFiles,
                );
              } catch (retryErr) {
                await streamOnError(toError(retryErr));
              }
              return;
            }

            if (appSettings.isStreamingEnabled) {
              await routeThrownStreamError(
                () =>
                  sendStatelessMessageStreamApi(
                    freshKey,
                    apiModelId,
                    retryHistoryForChat,
                    retryFinalParts,
                    requestConfig,
                    newAbortController.signal,
                    streamOnPart,
                    onThoughtChunk,
                    streamOnError,
                    wrappedStreamOnComplete,
                    finalRole,
                    undefined,
                    streamResume,
                  ),
                streamOnError,
              );
              return;
            }

            await routeThrownStreamError(
              () =>
                sendStatelessMessageNonStreamApi(
                  freshKey,
                  apiModelId,
                  retryHistoryForChat,
                  retryFinalParts,
                  requestConfig,
                  newAbortController.signal,
                  streamOnError,
                  nonStreamOnComplete,
                  finalRole,
                ),
              streamOnError,
            );
            return;
          }
        }
      } catch (retryError) {
        logService.error('Silent auto-retry for Files API permission denied failed', { error: retryError });
      }
    }

    await streamOnError(error);
  };

  if (hasFunctionDeclarationsInRequest) {
    try {
      const toolLoopResult = await runStandardToolLoop({
        initialContents: appendTurnToHistory(historyForChat, finalRole, finalParts),
        clientFunctions: combinedClientFunctions,
        abortSignal: newAbortController.signal,
        omitFunctionCallIdsFromWire: isVertexExpress,
        onToolCallsStarted: (modelContent) => {
          insertInternalToolMessages([
            createMessage('model', '', {
              apiParts: modelContent.parts,
              isInternalToolMessage: true,
              toolParentMessageId: generationId,
            }),
          ]);
        },
        onToolResponsesSettled: (functionResponseParts) => {
          insertInternalToolMessages([
            createMessage('user', '', {
              apiParts: functionResponseParts,
              isInternalToolMessage: true,
              toolParentMessageId: generationId,
            }),
          ]);
        },
        runTurn: (contents) =>
          generateContentTurnApi(keyToUse, apiModelId, contents, requestConfig, newAbortController.signal),
      });

      for (const part of toolLoopResult.finalTurn.parts) {
        streamOnPart(part, { recordFirstToken: false });
      }
      if (toolLoopResult.finalTurn.thoughts) {
        onThoughtChunk(toolLoopResult.finalTurn.thoughts, { recordFirstToken: false });
      }
      wrappedStreamOnComplete(
        toolLoopResult.finalTurn.usage,
        toolLoopResult.finalTurn.grounding,
        toolLoopResult.finalTurn.urlContext,
        toolLoopResult.generatedFiles,
      );
    } catch (toolLoopError) {
      await handleStreamErrorWithAutoRetry(toError(toolLoopError));
    }
    return;
  }

  if (appSettings.isStreamingEnabled) {
    await routeThrownStreamError(
      () =>
        sendStatelessMessageStreamApi(
          keyToUse,
          apiModelId,
          historyForChat,
          finalParts,
          requestConfig,
          newAbortController.signal,
          streamOnPart,
          onThoughtChunk,
          handleStreamErrorWithAutoRetry,
          wrappedStreamOnComplete,
          finalRole,
          undefined,
          streamResume,
        ),
      handleStreamErrorWithAutoRetry,
    );
    return;
  }

  await routeThrownStreamError(
    () =>
      sendStatelessMessageNonStreamApi(
        keyToUse,
        apiModelId,
        historyForChat,
        finalParts,
        requestConfig,
        newAbortController.signal,
        handleStreamErrorWithAutoRetry,
        nonStreamOnComplete,
        finalRole,
      ),
    handleStreamErrorWithAutoRetry,
  );
};

export const standardChatGemini = executeGeminiChat;
