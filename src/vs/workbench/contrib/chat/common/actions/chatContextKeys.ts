/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../../nls.js';
import { ContextKeyExpr, RawContextKey } from '../../../../../platform/contextkey/common/contextkey.js';
import { IsWebContext } from '../../../../../platform/contextkey/common/contextkeys.js';
import { RemoteNameContext } from '../../../../common/contextkeys.js';
import { ViewContainerLocation } from '../../../../common/views.js';
import { ChatEntitlementContextKeys } from '../../../../services/chat/common/chatEntitlementService.js';
import { ChatAccountPolicyGateActiveContext } from '../../../../services/policies/common/accountPolicyService.js';
import { ChatAgentLocation, ChatModeKind, ChatPermissionLevel } from '../constants.js';

export namespace ChatContextKeys {
	export const responseVote = new RawContextKey<string>('chatSessionResponseVote', '', { type: 'string', description: localize('interactiveSessionResponseVote', "When the response has been voted up, is set to 'up'. When voted down, is set to 'down'. Otherwise an empty string.") });
	export const responseDetectedAgentCommand = new RawContextKey<boolean>('chatSessionResponseDetectedAgentOrCommand', false, { type: 'boolean', description: localize('chatSessionResponseDetectedAgentOrCommand', "When the agent or command was automatically detected") });
	export const responseSupportsIssueReporting = new RawContextKey<boolean>('chatResponseSupportsIssueReporting', false, { type: 'boolean', description: localize('chatResponseSupportsIssueReporting', "True when the current chat response supports issue reporting.") });
	export const responseIsFiltered = new RawContextKey<boolean>('chatSessionResponseFiltered', false, { type: 'boolean', description: localize('chatResponseFiltered', "True when the chat response was filtered out by the server.") });
	export const responseHasError = new RawContextKey<boolean>('chatSessionResponseError', false, { type: 'boolean', description: localize('chatResponseErrored', "True when the chat response resulted in an error.") });
	export const requestInProgress = new RawContextKey<boolean>('chatSessionRequestInProgress', false, { type: 'boolean', description: localize('interactiveSessionRequestInProgress', "True when the current request is still in progress.") });
	export const hasActiveRequest = new RawContextKey<boolean>('chatSessionHasActiveRequest', false, { type: 'boolean', description: localize('chatSessionHasActiveRequest', "True when the current chat response has not completed, regardless of intermediate states like tool calls or elicitations.") });
	export const currentlyEditing = new RawContextKey<boolean>('chatSessionCurrentlyEditing', false, { type: 'boolean', description: localize('interactiveSessionCurrentlyEditing', "True when the current request is being edited.") });
	export const currentlyEditingInput = new RawContextKey<boolean>('chatSessionCurrentlyEditingInput', false, { type: 'boolean', description: localize('interactiveSessionCurrentlyEditingInput', "True when the current request input at the bottom is being edited.") });

	export const enum EditingRequestType {
		Sent = 's',
		Queue = 'q',
		Steer = 'st',
	}
	export const editingRequestType = new RawContextKey<EditingRequestType | undefined>('chatEditingSentRequest', undefined, { type: 'string', description: localize('chatEditingSentRequest', "The type of the current editing request.") });

	export const isResponse = new RawContextKey<boolean>('chatResponse', false, { type: 'boolean', description: localize('chatResponse', "The chat item is a response.") });
	export const isRequest = new RawContextKey<boolean>('chatRequest', false, { type: 'boolean', description: localize('chatRequest', "The chat item is a request") });
	export const isFirstRequest = new RawContextKey<boolean>('chatFirstRequest', false, { type: 'boolean', description: localize('chatFirstRequest', "The chat item is the first request in the session.") });
	export const isPendingRequest = new RawContextKey<boolean>('chatRequestIsPending', false, { type: 'boolean', description: localize('chatRequestIsPending', "True when the chat request item is pending in the queue.") });
	export const itemId = new RawContextKey<string>('chatItemId', '', { type: 'string', description: localize('chatItemId', "The id of the chat item.") });
	export const lastItemId = new RawContextKey<string[]>('chatLastItemId', [], { type: 'string', description: localize('chatLastItemId', "The id of the last chat item.") });

	export const editApplied = new RawContextKey<boolean>('chatEditApplied', false, { type: 'boolean', description: localize('chatEditApplied', "True when the chat text edits have been applied.") });

	export const inputHasText = new RawContextKey<boolean>('chatInputHasText', false, { type: 'boolean', description: localize('interactiveInputHasText', "True when the chat input has text.") });
	export const inputHasFocus = new RawContextKey<boolean>('chatInputHasFocus', false, { type: 'boolean', description: localize('interactiveInputHasFocus', "True when the chat input has focus.") });
	export const inChatInput = new RawContextKey<boolean>('inChatInput', false, { type: 'boolean', description: localize('inInteractiveInput', "True when focus is in the chat input, false otherwise.") });
	export const inChatSession = new RawContextKey<boolean>('inChat', false, { type: 'boolean', description: localize('inChat', "True when focus is in the chat widget, false otherwise.") });
	export const inChatQuestionCarousel = new RawContextKey<boolean>('inChatQuestionCarousel', false, { type: 'boolean', description: localize('inChatQuestionCarousel', "True when focus is in the chat question carousel.") });
	export const chatQuestionCarouselHasTerminal = new RawContextKey<boolean>('chatQuestionCarouselHasTerminal', false, { type: 'boolean', description: localize('chatQuestionCarouselHasTerminal', "True when the chat question carousel was triggered by a terminal and has a terminal to focus.") });
	export const inChatEditor = new RawContextKey<boolean>('inChatEditor', false, { type: 'boolean', description: localize('inChatEditor', "Whether focus is in a chat editor.") });
	export const inChatTodoList = new RawContextKey<boolean>('inChatTodoList', false, { type: 'boolean', description: localize('inChatTodoList', "True when focus is in the chat todo list.") });
	export const inChatTip = new RawContextKey<boolean>('inChatTip', false, { type: 'boolean', description: localize('inChatTip', "True when focus is in a chat tip.") });
	export const multipleChatTips = new RawContextKey<boolean>('multipleChatTips', false, { type: 'boolean', description: localize('multipleChatTips', "True when there are multiple chat tips available.") });
	export const inChatTerminalToolOutput = new RawContextKey<boolean>('inChatTerminalToolOutput', false, { type: 'boolean', description: localize('inChatTerminalToolOutput', "True when focus is in the chat terminal output region.") });
	export const chatModeKind = new RawContextKey<ChatModeKind>('chatAgentKind', ChatModeKind.Ask, { type: 'string', description: localize('agentKind', "The 'kind' of the current agent.") });
	export const chatPermissionLevel = new RawContextKey<ChatPermissionLevel>('chatPermissionLevel', ChatPermissionLevel.Default, { type: 'string', description: localize('chatPermissionLevel', "The current permission level for tool auto-approval.") });
	export const chatModeName = new RawContextKey<string>('chatModeName', '', { type: 'string', description: localize('chatModeName', "The name of the current chat mode (e.g. 'Plan' for custom modes).") });
	export const chatModelId = new RawContextKey<string>('chatModelId', '', { type: 'string', description: localize('chatModelId', "The short id of the currently selected chat model (for example 'gpt-4.1').") });

	/**
	 * Approximate total tokens in the prompt/context for the current chat input.
	 */
	export const inputContextTokens = new RawContextKey<number>('chatInputContextTokens', 0, { type: 'number', description: localize('chatInputContextTokens', 'Approximate token count of the prompt/context for the current chat input.') });
	/**
	 * Approximate tokens in chat history (previous requests + responses), excluding the current draft input.
	 */
	export const inputContextHistoryTokens = new RawContextKey<number>('chatInputContextHistoryTokens', 0, { type: 'number', description: localize('chatInputContextHistoryTokens', 'Approximate token count contributed by chat history (previous requests and responses).') });
	/**
	 * Approximate tokens in the current draft input.
	 */
	export const inputContextDraftTokens = new RawContextKey<number>('chatInputContextDraftTokens', 0, { type: 'number', description: localize('chatInputContextDraftTokens', 'Approximate token count contributed by the current draft input.') });
	/**
	 * Approximate tokens contributed by attachments/instructions (prompt files, prompt text, paste, terminal output, etc.).
	 */
	export const inputContextAttachmentTokens = new RawContextKey<number>('chatInputContextAttachmentTokens', 0, { type: 'number', description: localize('chatInputContextAttachmentTokens', 'Approximate token count contributed by attachments and instructions.') });
	/**
	 * Approximate tokens contributed by the current chat mode instructions.
	 */
	export const inputContextModeTokens = new RawContextKey<number>('chatInputContextModeTokens', 0, { type: 'number', description: localize('chatInputContextModeTokens', 'Approximate token count contributed by the current chat mode instructions.') });
	/**
	 * Max input tokens for the currently selected language model.
	 */
	export const inputContextMaxTokens = new RawContextKey<number>('chatInputContextMaxTokens', 0, { type: 'number', description: localize('chatInputContextMaxTokens', 'Maximum number of input tokens supported by the currently selected language model.') });
	/**
	 * Ratio of {@link inputContextTokens} to {@link inputContextMaxTokens}, in the range [0, 1].
	 */
	export const inputContextUsagePercent = new RawContextKey<number>('chatInputContextUsagePercent', 0, { type: 'number', description: localize('chatInputContextUsagePercent', 'Approximate context usage ratio for the current chat input, from 0 to 1.') });

	// --- Model-reported usage (last completed request) ---
	/**
	 * True when we have model-reported usage data for the last completed request.
	 */
	export const lastRequestUsageAvailable = new RawContextKey<boolean>('chatLastRequestUsageAvailable', false, { type: 'boolean', description: localize('chatLastRequestUsageAvailable', 'True when model-reported token usage for the last completed request is available.') });
	/**
	 * Prompt tokens used for the last completed request (as reported by the model/provider).
	 */
	export const lastRequestPromptTokens = new RawContextKey<number>('chatLastRequestPromptTokens', 0, { type: 'number', description: localize('chatLastRequestPromptTokens', 'Prompt tokens used for the last completed request (model-reported).') });
	/**
	 * Completion tokens used for the last completed request (as reported by the model/provider).
	 */
	export const lastRequestCompletionTokens = new RawContextKey<number>('chatLastRequestCompletionTokens', 0, { type: 'number', description: localize('chatLastRequestCompletionTokens', 'Completion tokens used for the last completed request (model-reported).') });
	/**
	 * Total tokens used for the last completed request (as reported by the model/provider).
	 */
	export const lastRequestTotalTokens = new RawContextKey<number>('chatLastRequestTotalTokens', 0, { type: 'number', description: localize('chatLastRequestTotalTokens', 'Total tokens used for the last completed request (model-reported).') });
	/**
	 * Cached prompt tokens for the last completed request, if reported.
	 */
	export const lastRequestCachedPromptTokens = new RawContextKey<number>('chatLastRequestCachedPromptTokens', 0, { type: 'number', description: localize('chatLastRequestCachedPromptTokens', 'Cached prompt tokens for the last completed request (model-reported).') });
	/**
	 * Accepted prediction tokens for the last completed request, if reported.
	 */
	export const lastRequestAcceptedPredictionTokens = new RawContextKey<number>('chatLastRequestAcceptedPredictionTokens', 0, { type: 'number', description: localize('chatLastRequestAcceptedPredictionTokens', 'Accepted prediction tokens for the last completed request (model-reported).') });
	/**
	 * Rejected prediction tokens for the last completed request, if reported.
	 */
	export const lastRequestRejectedPredictionTokens = new RawContextKey<number>('chatLastRequestRejectedPredictionTokens', 0, { type: 'number', description: localize('chatLastRequestRejectedPredictionTokens', 'Rejected prediction tokens for the last completed request (model-reported).') });
	/**
	 * Max prompt tokens that applied for the last request, if reported.
	 */
	export const lastRequestMaxPromptTokens = new RawContextKey<number>('chatLastRequestMaxPromptTokens', 0, { type: 'number', description: localize('chatLastRequestMaxPromptTokens', 'Max prompt tokens that applied for the last request (model-reported).') });
	/**
	 * Ratio of {@link lastRequestPromptTokens} to {@link lastRequestMaxPromptTokens}, in the range [0, 1].
	 */
	export const lastRequestPromptUsagePercent = new RawContextKey<number>('chatLastRequestPromptUsagePercent', 0, { type: 'number', description: localize('chatLastRequestPromptUsagePercent', 'Prompt token usage ratio for the last completed request (model-reported), from 0 to 1.') });

	export const supported = ContextKeyExpr.or(IsWebContext.negate(), RemoteNameContext.notEqualsTo(''), ContextKeyExpr.has('config.chat.experimental.serverlessWebEnabled'));
	export const enabled = new RawContextKey<boolean>('chatIsEnabled', false, { type: 'boolean', description: localize('chatIsEnabled', "True when chat is enabled because a default chat participant is activated with an implementation.") });
	export const accountPolicyGateActive = ChatAccountPolicyGateActiveContext;

	/**
	 * True when the chat widget is locked to the coding agent session.
	 */
	export const lockedToCodingAgent = new RawContextKey<boolean>('lockedToCodingAgent', false, { type: 'boolean', description: localize('lockedToCodingAgent', "True when the chat widget is locked to the coding agent session.") });
	export const lockedCodingAgentId = new RawContextKey<string>('lockedCodingAgentId', '', { type: 'string', description: localize('lockedCodingAgentId', "The agent ID when the chat widget is locked to a coding agent session.") });
	/**
	 * True when the chat session has a customAgentTarget defined in its contribution,
	 * which means the mode picker should be shown with filtered custom agents.
	 */
	export const chatSessionHasCustomAgentTarget = new RawContextKey<boolean>('chatSessionHasCustomAgentTarget', false, { type: 'boolean', description: localize('chatSessionHasCustomAgentTarget', "True when the chat session has a customAgentTarget defined to filter modes.") });
	/**
	 * True when the current chat session has models that specifically target it
	 * via `targetChatSessionType`, which means the model picker should be shown
	 * even when the widget is locked to a coding agent.
	 */
	export const chatSessionHasTargetedModels = new RawContextKey<boolean>('chatSessionHasTargetedModels', false, { type: 'boolean', description: localize('chatSessionHasTargetedModels', "True when the chat session has language models that target it via targetChatSessionType.") });
	export const agentSupportsAttachments = new RawContextKey<boolean>('agentSupportsAttachments', false, { type: 'boolean', description: localize('agentSupportsAttachments', "True when the chat agent supports attachments.") });
	export const withinEditSessionDiff = new RawContextKey<boolean>('withinEditSessionDiff', false, { type: 'boolean', description: localize('withinEditSessionDiff', "True when the chat widget dispatches to the edit session chat.") });
	export const filePartOfEditSession = new RawContextKey<boolean>('filePartOfEditSession', false, { type: 'boolean', description: localize('filePartOfEditSession', "True when the chat widget is within a file with an edit session.") });

	export const extensionParticipantRegistered = new RawContextKey<boolean>('chatPanelExtensionParticipantRegistered', false, { type: 'boolean', description: localize('chatPanelExtensionParticipantRegistered', "True when a default chat participant is registered for the panel from an extension.") });
	export const panelParticipantRegistered = new RawContextKey<boolean>('chatPanelParticipantRegistered', false, { type: 'boolean', description: localize('chatParticipantRegistered', "True when a default chat participant is registered for the panel.") });
	export const chatEditingCanUndo = new RawContextKey<boolean>('chatEditingCanUndo', false, { type: 'boolean', description: localize('chatEditingCanUndo', "True when it is possible to undo an interaction in the editing panel.") });
	export const chatEditingCanRedo = new RawContextKey<boolean>('chatEditingCanRedo', false, { type: 'boolean', description: localize('chatEditingCanRedo', "True when it is possible to redo an interaction in the editing panel.") });
	export const languageModelsAreUserSelectable = new RawContextKey<boolean>('chatModelsAreUserSelectable', false, { type: 'boolean', description: localize('chatModelsAreUserSelectable', "True when the chat model can be selected manually by the user.") });
	export const nonCopilotLanguageModelsAreUserSelectable = new RawContextKey<boolean>('chatNonCopilotModelsAreUserSelectable', false, { type: 'boolean', description: localize('chatNonCopilotModelsAreUserSelectable', "True when a user-selectable chat model from a non-Copilot vendor is available.") });
	export const chatSessionHasModels = new RawContextKey<boolean>('chatSessionHasModels', false, { type: 'boolean', description: localize('chatSessionHasModels', "True when the chat is in a contributed chat session that has available 'models' to display.") });
	export const chatSessionOptionsValid = new RawContextKey<boolean>('chatSessionOptionsValid', true, { type: 'boolean', description: localize('chatSessionOptionsValid', "True when all selected session options exist in their respective option group items.") });
	export const extensionInvalid = new RawContextKey<boolean>('chatExtensionInvalid', false, { type: 'boolean', description: localize('chatExtensionInvalid', "True when the installed chat extension is invalid and needs to be updated.") });
	export const inputCursorAtTop = new RawContextKey<boolean>('chatCursorAtTop', false);
	export const inputHasAgent = new RawContextKey<boolean>('chatInputHasAgent', false);
	export const location = new RawContextKey<ChatAgentLocation>('chatLocation', undefined);
	export const inQuickChat = new RawContextKey<boolean>('quickChatHasFocus', false, { type: 'boolean', description: localize('inQuickChat', "True when the quick chat UI has focus, false otherwise.") });
	export const inAgentSessionsWelcome = new RawContextKey<boolean>('inAgentSessionsWelcome', false, { type: 'boolean', description: localize('inAgentSessionsWelcome', "True when the chat input is within the agent sessions welcome page.") });
	export const chatSessionType = new RawContextKey<string>('chatSessionType', '', { type: 'string', description: localize('chatSessionType', "The type of the current chat session.") });
	export const hasFileAttachments = new RawContextKey<boolean>('chatHasFileAttachments', false, { type: 'boolean', description: localize('chatHasFileAttachments', "True when the chat has file attachments.") });
	export const chatSessionIsEmpty = new RawContextKey<boolean>('chatSessionIsEmpty', true, { type: 'boolean', description: localize('chatSessionIsEmpty', "True when the current chat session has no requests.") });
	export const hasPendingRequests = new RawContextKey<boolean>('chatHasPendingRequests', false, { type: 'boolean', description: localize('chatHasPendingRequests', "True when there are pending requests in the queue.") });
	export const chatSessionHasDebugData = new RawContextKey<boolean>('chatSessionHasDebugData', false, { type: 'boolean', description: localize('chatSessionHasDebugData', "True when the current chat session has debug log data.") });
	export const chatSessionHasDebugTools = new RawContextKey<boolean>('chatSessionHasDebugTools', false, { type: 'boolean', description: localize('chatSessionHasDebugTools', "True when debug tools are enabled in the current chat session.") });

	export const remoteJobCreating = new RawContextKey<boolean>('chatRemoteJobCreating', false, { type: 'boolean', description: localize('chatRemoteJobCreating', "True when a remote coding agent job is being created.") });
	export const hasRemoteCodingAgent = new RawContextKey<boolean>('hasRemoteCodingAgent', false, localize('hasRemoteCodingAgent', "Whether any remote coding agent is available"));
	export const hasCanDelegateProviders = new RawContextKey<boolean>('chatHasCanDelegateProviders', false, { type: 'boolean', description: localize('chatHasCanDelegateProviders', "True when there are chat session providers with delegation support available.") });
	export const enableRemoteCodingAgentPromptFileOverlay = new RawContextKey<boolean>('enableRemoteCodingAgentPromptFileOverlay', false, localize('enableRemoteCodingAgentPromptFileOverlay', "Whether the remote coding agent prompt file overlay feature is enabled"));
	/** Used by the extension to skip the quit confirmation when #new wants to open a new folder */
	export const skipChatRequestInProgressMessage = new RawContextKey<boolean>('chatSkipRequestInProgressMessage', false, { type: 'boolean', description: localize('chatSkipRequestInProgressMessage', "True when the chat request in progress message should be skipped.") });

	// Re-exported from chat entitlement service
	export const Setup = ChatEntitlementContextKeys.Setup;
	export const Entitlement = ChatEntitlementContextKeys.Entitlement;
	export const chatQuotaExceeded = ChatEntitlementContextKeys.chatQuotaExceeded;
	export const completionsQuotaExceeded = ChatEntitlementContextKeys.completionsQuotaExceeded;

	export const Editing = {
		hasToolConfirmation: new RawContextKey<boolean>('chatHasToolConfirmation', false, { type: 'boolean', description: localize('chatEditingHasToolConfirmation', "True when a tool confirmation is present.") }),
		hasElicitationRequest: new RawContextKey<boolean>('chatHasElicitationRequest', false, { type: 'boolean', description: localize('chatEditingHasElicitationRequest', "True when a chat elicitation request is pending.") }),
		hasQuestionCarousel: new RawContextKey<boolean>('chatHasQuestionCarousel', false, { type: 'boolean', description: localize('chatEditingHasQuestionCarousel', "True when a question carousel is rendered in the chat input.") }),
	};

	export const Tools = {
		toolsCount: new RawContextKey<number>('toolsCount', 0, { type: 'number', description: localize('toolsCount', "The count of tools available in the chat.") })
	};

	export const foregroundSessionCount = new RawContextKey<number>('chatForegroundSessionCount', 0, { type: 'number', description: localize('chatForegroundSessionCount', "The number of foreground chat sessions visible across chat surfaces.") });

	export const Modes = {
		hasCustomChatModes: new RawContextKey<boolean>('chatHasCustomAgents', false, { type: 'boolean', description: localize('chatHasAgents', "True when the chat has custom agents available.") }),
		agentModeDisabledByPolicy: new RawContextKey<boolean>('chatAgentModeDisabledByPolicy', false, { type: 'boolean', description: localize('chatAgentModeDisabledByPolicy', "True when agent mode is disabled by organization policy.") }),
	};

	export const panelLocation = new RawContextKey<ViewContainerLocation>('chatPanelLocation', undefined, { type: 'number', description: localize('chatPanelLocation', "The location of the chat panel.") });

	export const agentSessionsViewerFocused = new RawContextKey<boolean>('agentSessionsViewerFocused', true, { type: 'boolean', description: localize('agentSessionsViewerFocused', "If the agent sessions view in the chat view is focused.") });
	export const agentSessionsViewerOrientation = new RawContextKey<number>('agentSessionsViewerOrientation', undefined, { type: 'number', description: localize('agentSessionsViewerOrientation', "Orientation of the agent sessions view in the chat view.") });
	export const agentSessionsViewerPosition = new RawContextKey<number>('agentSessionsViewerPosition', undefined, { type: 'number', description: localize('agentSessionsViewerPosition', "Position of the agent sessions view in the chat view.") });
	export const agentSessionsViewerVisible = new RawContextKey<boolean>('agentSessionsViewerVisible', undefined, { type: 'boolean', description: localize('agentSessionsViewerVisible', "Visibility of the agent sessions view in the chat view.") });
	export const agentSessionType = new RawContextKey<string>('chatSessionType', '', { type: 'string', description: localize('agentSessionType', "The type of the current agent session item.") });
	export const chatSessionSupportsDelegation = new RawContextKey<boolean>('chatSessionSupportsDelegation', true, { type: 'boolean', description: localize('chatSessionSupportsDelegation', "True when the current session type supports delegation.") });
	export const chatSessionSupportsFork = new RawContextKey<boolean>('chatSessionSupportsFork', false, { type: 'boolean', description: localize('chatSessionSupportsFork', "True when the current chat session provider supports forking conversations.") });
	export const agentSessionSection = new RawContextKey<string>('agentSessionSection', '', { type: 'string', description: localize('agentSessionSection', "The section of the current agent session section item.") });
	export const isArchivedAgentSession = new RawContextKey<boolean>('agentSessionIsArchived', false, { type: 'boolean', description: localize('agentSessionIsArchived', "True when the agent session item is archived.") });
	export const isPinnedAgentSession = new RawContextKey<boolean>('agentSessionIsPinned', false, { type: 'boolean', description: localize('agentSessionIsPinned', "True when the agent session item is pinned.") });
	export const isReadAgentSession = new RawContextKey<boolean>('agentSessionIsRead', false, { type: 'boolean', description: localize('agentSessionIsRead', "True when the agent session item is read.") });
	export const hasMultipleAgentSessionsSelected = new RawContextKey<boolean>('agentSessionHasMultipleSelected', false, { type: 'boolean', description: localize('agentSessionHasMultipleSelected', "True when multiple agent sessions are selected.") });
	export const hasAgentSessionChanges = new RawContextKey<boolean>('agentSessionHasChanges', false, { type: 'boolean', description: localize('agentSessionHasChanges', "True when the current agent session item has changes.") });

	export const isKatexMathElement = new RawContextKey<boolean>('chatIsKatexMathElement', false, { type: 'boolean', description: localize('chatIsKatexMathElement', "True when focusing a KaTeX math element.") });

	/**
	 * True when the user has submitted a chat request using any of the `/create-*` slash commands.
	 * This is persisted in application storage and used to suppress onboarding tips once discovered.
	 */
	export const hasUsedCreateSlashCommands = new RawContextKey<boolean>('chatHasUsedCreateSlashCommands', false, { type: 'boolean', description: localize('chatHasUsedCreateSlashCommands', "True when the user has used any of the /create-* slash commands.") });

	export const contextUsageHasBeenOpened = new RawContextKey<boolean>('chatContextUsageHasBeenOpened', false, { type: 'boolean', description: localize('chatContextUsageHasBeenOpened', "True when the user has opened the context window usage details.") });

	export const newChatButtonExperimentIcon = new RawContextKey<string>('chatNewChatButtonExperimentIcon', '', { type: 'string', description: localize('chatNewChatButtonExperimentIcon', "The icon variant for the new chat button, controlled by experiment. Values: 'copilot', 'new-session', 'comment', or empty for default.") });
}

export namespace ChatContextKeyExprs {

	export const inEditingMode = ContextKeyExpr.or(
		ChatContextKeys.chatModeKind.isEqualTo(ChatModeKind.Edit),
		ChatContextKeys.chatModeKind.isEqualTo(ChatModeKind.Agent),
	);

	/**
	 * True when the locked coding agent is an agent host session (agent-host-* or remote-*).
	 * These sessions use AgentHostEditingSession which supports checkpoint-based undo/redo.
	 */
	export const isAgentHostSession = ContextKeyExpr.or(
		ContextKeyExpr.regex(ChatContextKeys.lockedCodingAgentId.key, /^agent-host-/),
		ContextKeyExpr.regex(ChatContextKeys.lockedCodingAgentId.key, /^remote-/),
	);
}
