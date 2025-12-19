/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener } from '../../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../../base/browser/keyboardEvent.js';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Iterable } from '../../../../../base/common/iterator.js';
import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { markAsSingleton } from '../../../../../base/common/lifecycle.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { autorun } from '../../../../../base/common/observable.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { ServicesAccessor } from '../../../../../editor/browser/editorExtensions.js';
import { localize, localize2 } from '../../../../../nls.js';
import { getDefaultHoverDelegate } from '../../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { IActionViewItemService } from '../../../../../platform/actions/browser/actionViewItemService.js';
import { MenuEntryActionViewItem } from '../../../../../platform/actions/browser/menuEntryActionViewItem.js';
import { Action2, MenuId, MenuItemAction, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import { ConfirmedReason, IChatToolInvocation, ToolConfirmKind } from '../../common/chatService/chatService.js';
import { isResponseVM } from '../../common/model/chatViewModel.js';
import { ChatModeKind } from '../../common/constants.js';
import { IChatWidget, IChatWidgetService } from '../chat.js';
import { ToolsScope } from '../widget/input/chatSelectedTools.js';
import { CHAT_CATEGORY } from './chatActions.js';
import { showToolsPicker } from './chatToolPicker.js';


type SelectedToolData = {
	enabled: number;
	total: number;
};
type SelectedToolClassification = {
	owner: 'connor4312';
	comment: 'Details the capabilities of the MCP server';
	enabled: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Number of enabled chat tools' };
	total: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Number of total chat tools' };
};

const toggleContextUsageBreakdownCommandId = 'workbench.action.chat.contextUsage.toggleBreakdown';
const toggleLastRequestUsageBreakdownCommandId = 'workbench.action.chat.lastRequestUsage.toggleBreakdown';

export const AcceptToolConfirmationActionId = 'workbench.action.chat.acceptTool';
export const SkipToolConfirmationActionId = 'workbench.action.chat.skipTool';
export const AcceptToolPostConfirmationActionId = 'workbench.action.chat.acceptToolPostExecution';
export const SkipToolPostConfirmationActionId = 'workbench.action.chat.skipToolPostExecution';

abstract class ToolConfirmationAction extends Action2 {
	protected abstract getReason(): ConfirmedReason;

	run(accessor: ServicesAccessor, ...args: unknown[]) {
		const chatWidgetService = accessor.get(IChatWidgetService);
		const widget = chatWidgetService.lastFocusedWidget;
		const lastItem = widget?.viewModel?.getItems().at(-1);
		if (!isResponseVM(lastItem)) {
			return;
		}

		for (const item of lastItem.model.response.value) {
			const state = item.kind === 'toolInvocation' ? item.state.get() : undefined;
			if (state?.type === IChatToolInvocation.StateKind.WaitingForConfirmation || state?.type === IChatToolInvocation.StateKind.WaitingForPostApproval) {
				state.confirm(this.getReason());
				break;
			}
		}

		// Return focus to the chat input, in case it was in the tool confirmation editor
		widget?.focusInput();
	}
}

class AcceptToolConfirmation extends ToolConfirmationAction {
	constructor() {
		super({
			id: AcceptToolConfirmationActionId,
			title: localize2('chat.accept', "Accept"),
			f1: false,
			category: CHAT_CATEGORY,
			keybinding: {
				when: ContextKeyExpr.and(ChatContextKeys.inChatSession, ChatContextKeys.Editing.hasToolConfirmation),
				primary: KeyMod.CtrlCmd | KeyCode.Enter,
				// Override chatEditor.action.accept
				weight: KeybindingWeight.WorkbenchContrib + 1,
			},
		});
	}

	protected override getReason(): ConfirmedReason {
		return { type: ToolConfirmKind.UserAction };
	}
}

class SkipToolConfirmation extends ToolConfirmationAction {
	constructor() {
		super({
			id: SkipToolConfirmationActionId,
			title: localize2('chat.skip', "Skip"),
			f1: false,
			category: CHAT_CATEGORY,
			keybinding: {
				when: ContextKeyExpr.and(ChatContextKeys.inChatSession, ChatContextKeys.Editing.hasToolConfirmation),
				primary: KeyMod.CtrlCmd | KeyCode.Enter | KeyMod.Alt,
				// Override chatEditor.action.accept
				weight: KeybindingWeight.WorkbenchContrib + 1,
			},
		});
	}

	protected override getReason(): ConfirmedReason {
		return { type: ToolConfirmKind.Skipped };
	}
}

class ConfigureToolsAction extends Action2 {
	public static ID = 'workbench.action.chat.configureTools';

	constructor() {
		super({
			id: ConfigureToolsAction.ID,
			title: localize('label', "Configure Tools..."),
			icon: Codicon.tools,
			f1: false,
			category: CHAT_CATEGORY,
			precondition: ChatContextKeys.chatModeKind.isEqualTo(ChatModeKind.Agent),
			menu: [{
				when: ContextKeyExpr.and(ChatContextKeys.chatModeKind.isEqualTo(ChatModeKind.Agent), ChatContextKeys.lockedToCodingAgent.negate()),
				id: MenuId.ChatInput,
				group: 'navigation',
				order: 100,
			}]
		});
	}

	override async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {

		const instaService = accessor.get(IInstantiationService);
		const chatWidgetService = accessor.get(IChatWidgetService);
		const telemetryService = accessor.get(ITelemetryService);

		let widget = chatWidgetService.lastFocusedWidget;
		if (!widget) {
			type ChatActionContext = { widget: IChatWidget };
			function isChatActionContext(obj: unknown): obj is ChatActionContext {
				return !!obj && typeof obj === 'object' && !!(obj as ChatActionContext).widget;
			}
			const context = args[0];
			if (isChatActionContext(context)) {
				widget = context.widget;
			}
		}

		if (!widget) {
			return;
		}

		let placeholder;
		let description;
		const { entriesScope, entriesMap } = widget.input.selectedToolsModel;
		switch (entriesScope) {
			case ToolsScope.Session:
				placeholder = localize('chat.tools.placeholder.session', "Select tools for this chat session");
				description = localize('chat.tools.description.session', "The selected tools were configured only for this chat session.");
				break;
			case ToolsScope.Agent:
				placeholder = localize('chat.tools.placeholder.agent', "Select tools for this custom agent");
				description = localize('chat.tools.description.agent', "The selected tools are configured by the '{0}' custom agent. Changes to the tools will be applied to the custom agent file as well.", widget.input.currentModeObs.get().label.get());
				break;
			case ToolsScope.Agent_ReadOnly:
				placeholder = localize('chat.tools.placeholder.readOnlyAgent', "Select tools for this custom agent");
				description = localize('chat.tools.description.readOnlyAgent', "The selected tools are configured by the '{0}' custom agent. Changes to the tools will only be used for this session and will not change the '{0}' custom agent.", widget.input.currentModeObs.get().label.get());
				break;
			case ToolsScope.Global:
				placeholder = localize('chat.tools.placeholder.global', "Select tools that are available to chat.");
				description = localize('chat.tools.description.global', "The selected tools will be applied globally for all chat sessions that use the default agent.");
				break;

		}

		// Create a cancellation token that cancels when the mode changes
		const cts = new CancellationTokenSource();
		const initialMode = widget.input.currentModeObs.get();
		const modeListener = autorun(reader => {
			if (initialMode.id !== widget.input.currentModeObs.read(reader).id) {
				cts.cancel();
			}
		});

		try {
			const result = await instaService.invokeFunction(showToolsPicker, placeholder, description, () => entriesMap.get(), cts.token);
			if (result) {
				widget.input.selectedToolsModel.set(result, false);
			}
		} finally {
			modeListener.dispose();
			cts.dispose();
		}

		const tools = widget.input.selectedToolsModel.entriesMap.get();
		telemetryService.publicLog2<SelectedToolData, SelectedToolClassification>('chat/selectedTools', {
			total: tools.size,
			enabled: Iterable.reduce(tools, (prev, [_, enabled]) => enabled ? prev + 1 : prev, 0),
		});
	}
}

class ConfigureToolsActionRendering implements IWorkbenchContribution {

	static readonly ID = 'chat.configureToolsActionRendering';

	constructor(
		@IActionViewItemService actionViewItemService: IActionViewItemService,
	) {
		const disposable = actionViewItemService.register(MenuId.ChatInput, ConfigureToolsAction.ID, (action, _opts, instantiationService) => {
			if (!(action instanceof MenuItemAction)) {
				return undefined;
			}
			return instantiationService.createInstance(class extends MenuEntryActionViewItem {
				private warningElement!: HTMLElement;
				private contextUsageElement!: HTMLElement;
				private contextUsageProgressCircle!: SVGCircleElement;
				private readonly contextUsageCircumference = 2 * Math.PI * 6;
				private showContextUsageBreakdown = false;
				private lastRequestUsageElement!: HTMLElement;
				private lastRequestUsageProgressCircle!: SVGCircleElement;
				private readonly lastRequestUsageCircumference = 2 * Math.PI * 6;
				private showLastRequestUsageBreakdown = false;
				private readonly hoverDelegate = getDefaultHoverDelegate('mouse');

				override async onClick(event: MouseEvent): Promise<void> {
					if (
						(this.contextUsageElement && event.target instanceof Node && this.contextUsageElement.contains(event.target))
						|| (this.lastRequestUsageElement && event.target instanceof Node && this.lastRequestUsageElement.contains(event.target))
					) {
						event.preventDefault();
						event.stopPropagation();
						return;
					}

					return super.onClick(event);
				}

				override render(container: HTMLElement): void {
					super.render(container);

					// Add warning indicator element
					this.warningElement = $(`.tool-warning-indicator${ThemeIcon.asCSSSelector(Codicon.warning)}`);
					this.warningElement.style.display = 'none';
					container.appendChild(this.warningElement);
					container.style.position = 'relative';
					container.classList.add('chat-configure-tools-action-item');

					// Add context usage ring (to the right of the tools icon)
					this.contextUsageElement = $('.chat-context-usage-indicator');
					this.contextUsageElement.style.display = 'none';
					this.contextUsageElement.setAttribute('role', 'button');
					this.contextUsageElement.tabIndex = 0;

					const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
					svg.setAttribute('viewBox', '0 0 16 16');
					svg.setAttribute('width', '16');
					svg.setAttribute('height', '16');
					svg.setAttribute('focusable', 'false');

					const track = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
					track.setAttribute('class', 'chat-context-usage-track');
					track.setAttribute('cx', '8');
					track.setAttribute('cy', '8');
					track.setAttribute('r', '6');
					track.setAttribute('fill', 'none');
					track.setAttribute('stroke-width', '2');

					const progress = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
					progress.setAttribute('class', 'chat-context-usage-progress');
					progress.setAttribute('cx', '8');
					progress.setAttribute('cy', '8');
					progress.setAttribute('r', '6');
					progress.setAttribute('fill', 'none');
					progress.setAttribute('stroke-width', '2');
					progress.setAttribute('stroke-dasharray', String(this.contextUsageCircumference));
					progress.setAttribute('stroke-dashoffset', String(this.contextUsageCircumference));
					progress.setAttribute('transform', 'rotate(-90 8 8)');
					progress.setAttribute('stroke-linecap', 'round');
					this.contextUsageProgressCircle = progress;

					svg.appendChild(track);
					svg.appendChild(progress);
					this.contextUsageElement.appendChild(svg);
					container.appendChild(this.contextUsageElement);

					// Add model-reported last request usage ring (prompt usage for last completed request)
					this.lastRequestUsageElement = $('.chat-context-usage-indicator.chat-last-request-usage-indicator');
					this.lastRequestUsageElement.style.display = 'none';
					this.lastRequestUsageElement.setAttribute('role', 'button');
					this.lastRequestUsageElement.tabIndex = 0;

					const lastSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
					lastSvg.setAttribute('viewBox', '0 0 16 16');
					lastSvg.setAttribute('width', '16');
					lastSvg.setAttribute('height', '16');
					lastSvg.setAttribute('focusable', 'false');

					const lastTrack = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
					lastTrack.setAttribute('class', 'chat-context-usage-track');
					lastTrack.setAttribute('cx', '8');
					lastTrack.setAttribute('cy', '8');
					lastTrack.setAttribute('r', '6');
					lastTrack.setAttribute('fill', 'none');
					lastTrack.setAttribute('stroke-width', '2');

					const lastProgress = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
					lastProgress.setAttribute('class', 'chat-context-usage-progress');
					lastProgress.setAttribute('cx', '8');
					lastProgress.setAttribute('cy', '8');
					lastProgress.setAttribute('r', '6');
					lastProgress.setAttribute('fill', 'none');
					lastProgress.setAttribute('stroke-width', '2');
					lastProgress.setAttribute('stroke-dasharray', String(this.lastRequestUsageCircumference));
					lastProgress.setAttribute('stroke-dashoffset', String(this.lastRequestUsageCircumference));
					lastProgress.setAttribute('transform', 'rotate(-90 8 8)');
					lastProgress.setAttribute('stroke-linecap', 'round');
					this.lastRequestUsageProgressCircle = lastProgress;

					lastSvg.appendChild(lastTrack);
					lastSvg.appendChild(lastProgress);
					this.lastRequestUsageElement.appendChild(lastSvg);
					container.appendChild(this.lastRequestUsageElement);

					// Prevent clicks on the ring from triggering the parent Tools action view item.
					const stopEvent = (e: Event) => {
						e.preventDefault();
						e.stopPropagation();
						(e as unknown as { stopImmediatePropagation?: () => void }).stopImmediatePropagation?.();
					};
					this._register(addDisposableListener(this.contextUsageElement, 'pointerdown', stopEvent, { capture: true }));
					this._register(addDisposableListener(this.contextUsageElement, 'mousedown', stopEvent, { capture: true }));
					this._register(addDisposableListener(this.contextUsageElement, 'mouseup', stopEvent, { capture: true }));
					this._register(addDisposableListener(this.contextUsageElement, 'click', e => {
						stopEvent(e);
						this.showContextUsageBreakdown = false;
						this.showContextUsageHover(true);
					}, { capture: true }));
					this._register(addDisposableListener(this.contextUsageElement, 'keydown', e => {
						const event = new StandardKeyboardEvent(e);
						if (event.keyCode === KeyCode.Enter || event.keyCode === KeyCode.Space) {
							e.preventDefault();
							e.stopPropagation();
							this.showContextUsageBreakdown = false;
							this.showContextUsageHover(true);
						}
					}));

					this._register(addDisposableListener(this.lastRequestUsageElement, 'pointerdown', stopEvent, { capture: true }));
					this._register(addDisposableListener(this.lastRequestUsageElement, 'mousedown', stopEvent, { capture: true }));
					this._register(addDisposableListener(this.lastRequestUsageElement, 'mouseup', stopEvent, { capture: true }));
					this._register(addDisposableListener(this.lastRequestUsageElement, 'click', e => {
						stopEvent(e);
						this.showLastRequestUsageBreakdown = false;
						this.showLastRequestUsageHover(true);
					}, { capture: true }));
					this._register(addDisposableListener(this.lastRequestUsageElement, 'keydown', e => {
						const event = new StandardKeyboardEvent(e);
						if (event.keyCode === KeyCode.Enter || event.keyCode === KeyCode.Space) {
							e.preventDefault();
							e.stopPropagation();
							this.showLastRequestUsageBreakdown = false;
							this.showLastRequestUsageHover(true);
						}
					}));

					// Set up context key listeners
					this.updateWarningState();
					this.updateContextUsageState();
					this.updateLastRequestUsageState();
					this._register(this._contextKeyService.onDidChangeContext(() => {
						this.updateWarningState();
						this.updateContextUsageState();
						this.updateLastRequestUsageState();
					}));
				}

				private updateWarningState(): void {
					const wasShown = this.warningElement.style.display === 'block';
					const shouldBeShown = this.isAboveToolLimit();

					if (!wasShown && shouldBeShown) {
						this.warningElement.style.display = 'block';
						this.updateTooltip();
					} else if (wasShown && !shouldBeShown) {
						this.warningElement.style.display = 'none';
						this.updateTooltip();
					}
				}

				protected override getTooltip(): string {
					const base = super.getTooltip();
					const contextUsage = this.getContextUsageTooltip();
					const lastRequestUsage = this.getLastRequestUsageTooltip();

					const extraLines: string[] = [];
					if (lastRequestUsage) {
						extraLines.push(lastRequestUsage);
					}
					if (contextUsage) {
						extraLines.push(contextUsage);
					}
					const extra = extraLines.length ? extraLines.join('\n') : undefined;

					if (this.isAboveToolLimit()) {
						const warningMessage = localize('chatTools.tooManyEnabled', 'More than {0} tools are enabled, you may experience degraded tool calling.', this._contextKeyService.getContextKeyValue(ChatContextKeys.chatToolGroupingThreshold.key));
						return extra ? localize('chatTools.tooltip.withContextAndWarning', '{0}\n\n{1}', warningMessage, extra) : warningMessage;
					}

					return extra ? localize('chatTools.tooltip.withContext', '{0}\n\n{1}', base, extra) : base;
				}

				private getContextUsageTooltip(): string | undefined {
					const rawMax = this._contextKeyService.getContextKeyValue(ChatContextKeys.inputContextMaxTokens.key);
					const rawTokens = this._contextKeyService.getContextKeyValue(ChatContextKeys.inputContextTokens.key);
					const maxTokens = Number(rawMax ?? 0);
					const tokens = Number(rawTokens ?? 0);
					if (maxTokens <= 0) {
						return undefined;
					}
					const remaining = Math.max(0, maxTokens - tokens);
					return localize('chatTools.contextUsageWithRemaining', 'Context: {0}/{1} tokens ({2} remaining)', tokens, maxTokens, remaining);
				}

				private getContextUsageHoverActions() {
					return [{
						label: this.showContextUsageBreakdown ? localize('chatTools.hideBreakdown', 'Hide Breakdown') : localize('chatTools.showBreakdown', 'Breakdown'),
						commandId: toggleContextUsageBreakdownCommandId,
						run: () => {
							this.showContextUsageBreakdown = !this.showContextUsageBreakdown;
							this.showContextUsageHover(true, true);
						}
					}];
				}

				private getLastRequestUsageHoverActions() {
					return [{
						label: this.showLastRequestUsageBreakdown ? localize('chatTools.hideBreakdown', 'Hide Breakdown') : localize('chatTools.showBreakdown', 'Breakdown'),
						commandId: toggleLastRequestUsageBreakdownCommandId,
						run: () => {
							this.showLastRequestUsageBreakdown = !this.showLastRequestUsageBreakdown;
							this.showLastRequestUsageHover(true, true);
						}
					}];
				}

				private showContextUsageHover(focus: boolean, skipFadeInAnimation?: boolean): void {
					this.hoverDelegate.showHover({
						target: this.contextUsageElement,
						content: this.getContextUsageMarkdown(),
						actions: this.getContextUsageHoverActions(),
						trapFocus: true,
						appearance: { showHoverHint: true, skipFadeInAnimation },
					}, focus);
				}

				private showLastRequestUsageHover(focus: boolean, skipFadeInAnimation?: boolean): void {
					this.hoverDelegate.showHover({
						target: this.lastRequestUsageElement,
						content: this.getLastRequestUsageMarkdown(),
						actions: this.getLastRequestUsageHoverActions(),
						trapFocus: true,
						appearance: { showHoverHint: true, skipFadeInAnimation },
					}, focus);
				}

				private getContextUsageMarkdown(): MarkdownString {
					const rawMax = this._contextKeyService.getContextKeyValue(ChatContextKeys.inputContextMaxTokens.key);
					const rawTokens = this._contextKeyService.getContextKeyValue(ChatContextKeys.inputContextTokens.key);
					const rawPercent = this._contextKeyService.getContextKeyValue(ChatContextKeys.inputContextUsagePercent.key);
					const rawHistory = this._contextKeyService.getContextKeyValue(ChatContextKeys.inputContextHistoryTokens.key);
					const rawAttachments = this._contextKeyService.getContextKeyValue(ChatContextKeys.inputContextAttachmentTokens.key);
					const rawMode = this._contextKeyService.getContextKeyValue(ChatContextKeys.inputContextModeTokens.key);
					const rawDraft = this._contextKeyService.getContextKeyValue(ChatContextKeys.inputContextDraftTokens.key);

					const maxTokens = Number(rawMax ?? 0);
					const tokens = Number(rawTokens ?? 0);
					const percent = Math.max(0, Math.min(1, Number(rawPercent ?? 0)));
					const remaining = Math.max(0, maxTokens - tokens);
					const historyTokens = Number(rawHistory ?? 0);
					const attachmentTokens = Number(rawAttachments ?? 0);
					const modeTokens = Number(rawMode ?? 0);
					const draftTokens = Number(rawDraft ?? 0);

					const md = new MarkdownString(undefined, { supportThemeIcons: true });
					if (maxTokens > 0) {
						md.appendText(localize('chatTools.contextUsage.hover', 'Context: {0}/{1} tokens ({2} remaining)', tokens, maxTokens, remaining));
						md.appendText('\n');
						md.appendText(localize('chatTools.contextUsage.percent', 'Usage: {0}%', Math.round(percent * 100)));
					} else {
						md.appendText(localize('chatTools.contextUsage.unknown', 'Context usage unavailable'));
					}

					if (this.showContextUsageBreakdown && maxTokens > 0) {
						md.appendText('\n\n');
						md.appendText(localize('chatTools.contextUsage.breakdown', 'Breakdown:'));
						md.appendText('\n');
						md.appendMarkdown(`- ${localize('chatTools.contextUsage.breakdown.history', 'History')}: **${historyTokens}**\n`);
						md.appendMarkdown(`- ${localize('chatTools.contextUsage.breakdown.attachments', 'Attachments/Instructions')}: **${attachmentTokens}**\n`);
						md.appendMarkdown(`- ${localize('chatTools.contextUsage.breakdown.mode', 'Mode Instructions')}: **${modeTokens}**\n`);
						md.appendMarkdown(`- ${localize('chatTools.contextUsage.breakdown.draft', 'Draft')}: **${draftTokens}**`);
						md.appendText('\n\n');
						md.appendText(localize('chatTools.contextUsage.note', 'Note: This is an estimate. Tool schemas and reference expansion may add additional hidden tokens.'));
					}

					return md;
				}

				private getLastRequestUsageTooltip(): string | undefined {
					const rawAvailable = this._contextKeyService.getContextKeyValue(ChatContextKeys.lastRequestUsageAvailable.key);
					if (!rawAvailable) {
						return localize('chatTools.lastRequestUsageUnavailable', 'Last request usage unavailable');
					}
					const rawMax = this._contextKeyService.getContextKeyValue(ChatContextKeys.lastRequestMaxPromptTokens.key);
					const rawPrompt = this._contextKeyService.getContextKeyValue(ChatContextKeys.lastRequestPromptTokens.key);
					const maxTokens = Number(rawMax ?? 0);
					const promptTokens = Number(rawPrompt ?? 0);
					if (maxTokens <= 0) {
						return localize('chatTools.lastRequestUsageNoMax', 'Last request: {0} prompt tokens', promptTokens);
					}
					const remaining = Math.max(0, maxTokens - promptTokens);
					return localize('chatTools.lastRequestUsageWithRemaining', 'Last request: {0}/{1} prompt tokens ({2} remaining)', promptTokens, maxTokens, remaining);
				}

				private getLastRequestUsageMarkdown(): MarkdownString {
					const rawAvailable = this._contextKeyService.getContextKeyValue(ChatContextKeys.lastRequestUsageAvailable.key);
					const md = new MarkdownString(undefined, { supportThemeIcons: true });
					if (!rawAvailable) {
						md.appendText(localize('chatTools.lastRequestUsage.unavailable', 'Last request usage unavailable'));
						md.appendText('\n');
						md.appendText(localize('chatTools.lastRequestUsage.unavailable.hint', 'This requires the agent/provider to report token usage in the response metadata.'));
						return md;
					}

					const rawMax = this._contextKeyService.getContextKeyValue(ChatContextKeys.lastRequestMaxPromptTokens.key);
					const rawPrompt = this._contextKeyService.getContextKeyValue(ChatContextKeys.lastRequestPromptTokens.key);
					const rawCompletion = this._contextKeyService.getContextKeyValue(ChatContextKeys.lastRequestCompletionTokens.key);
					const rawTotal = this._contextKeyService.getContextKeyValue(ChatContextKeys.lastRequestTotalTokens.key);
					const rawCached = this._contextKeyService.getContextKeyValue(ChatContextKeys.lastRequestCachedPromptTokens.key);
					const rawAcceptedPred = this._contextKeyService.getContextKeyValue(ChatContextKeys.lastRequestAcceptedPredictionTokens.key);
					const rawRejectedPred = this._contextKeyService.getContextKeyValue(ChatContextKeys.lastRequestRejectedPredictionTokens.key);
					const rawPercent = this._contextKeyService.getContextKeyValue(ChatContextKeys.lastRequestPromptUsagePercent.key);

					const maxTokens = Number(rawMax ?? 0);
					const promptTokens = Number(rawPrompt ?? 0);
					const completionTokens = Number(rawCompletion ?? 0);
					const totalTokens = Number(rawTotal ?? (promptTokens + completionTokens));
					const cachedTokens = Number(rawCached ?? 0);
					const acceptedPredTokens = Number(rawAcceptedPred ?? 0);
					const rejectedPredTokens = Number(rawRejectedPred ?? 0);
					const percent = Math.max(0, Math.min(1, Number(rawPercent ?? 0)));
					const remaining = Math.max(0, maxTokens - promptTokens);

					if (maxTokens > 0) {
						md.appendText(localize('chatTools.lastRequestUsage.hover', 'Last request prompt: {0}/{1} tokens ({2} remaining)', promptTokens, maxTokens, remaining));
						md.appendText('\n');
						md.appendText(localize('chatTools.lastRequestUsage.percent', 'Prompt usage: {0}%', Math.round(percent * 100)));
						md.appendText('\n');
						md.appendText(localize('chatTools.lastRequestUsage.total', 'Completion: {0} • Total: {1}', completionTokens, totalTokens));
					} else {
						md.appendText(localize('chatTools.lastRequestUsage.unknownMax', 'Last request usage (model-reported): {0} prompt tokens', promptTokens));
						md.appendText('\n');
						md.appendText(localize('chatTools.lastRequestUsage.total', 'Completion: {0} • Total: {1}', completionTokens, totalTokens));
					}

					if (this.showLastRequestUsageBreakdown) {
						md.appendText('\n\n');
						md.appendText(localize('chatTools.lastRequestUsage.breakdown', 'Breakdown:'));
						md.appendText('\n');
						md.appendMarkdown(`- ${localize('chatTools.lastRequestUsage.breakdown.prompt', 'Prompt')}: **${promptTokens}**\n`);
						md.appendMarkdown(`- ${localize('chatTools.lastRequestUsage.breakdown.completion', 'Completion')}: **${completionTokens}**\n`);
						md.appendMarkdown(`- ${localize('chatTools.lastRequestUsage.breakdown.total', 'Total')}: **${totalTokens}**\n`);
						if (cachedTokens > 0) {
							md.appendMarkdown(`- ${localize('chatTools.lastRequestUsage.breakdown.cached', 'Cached Prompt Tokens')}: **${cachedTokens}**\n`);
						}
						if (acceptedPredTokens > 0 || rejectedPredTokens > 0) {
							md.appendMarkdown(`- ${localize('chatTools.lastRequestUsage.breakdown.predictions', 'Prediction Tokens')}: **${acceptedPredTokens}** ${localize('chatTools.lastRequestUsage.breakdown.accepted', 'accepted')}, **${rejectedPredTokens}** ${localize('chatTools.lastRequestUsage.breakdown.rejected', 'rejected')}\n`);
						}
						md.appendText('\n');
						md.appendText(localize('chatTools.lastRequestUsage.note', 'Note: These values are reported by the model/provider for the last completed request.'));
					}

					return md;
				}

				private updateContextUsageState(): void {
					const rawMax = this._contextKeyService.getContextKeyValue(ChatContextKeys.inputContextMaxTokens.key);
					const rawTokens = this._contextKeyService.getContextKeyValue(ChatContextKeys.inputContextTokens.key);
					const rawPercent = this._contextKeyService.getContextKeyValue(ChatContextKeys.inputContextUsagePercent.key);

					const maxTokens = Number(rawMax ?? 0);
					const tokens = Number(rawTokens ?? 0);
					const percent = Math.max(0, Math.min(1, Number(rawPercent ?? 0)));

					this.contextUsageElement.style.display = maxTokens > 0 ? 'flex' : 'none';
					this.contextUsageElement.classList.toggle('over-limit', maxTokens > 0 && tokens > maxTokens);
					this.contextUsageElement.classList.toggle('level-warning', maxTokens > 0 && tokens <= maxTokens && percent >= 0.9);
					this.contextUsageElement.classList.toggle('level-caution', maxTokens > 0 && tokens <= maxTokens && percent >= 0.7 && percent < 0.9);
					this.contextUsageElement.classList.toggle('level-ok', maxTokens > 0 && tokens <= maxTokens && percent < 0.7);

					const dashOffset = this.contextUsageCircumference * (1 - percent);
					this.contextUsageProgressCircle.setAttribute('stroke-dashoffset', String(dashOffset));
					this.contextUsageElement.setAttribute('aria-label', this.getContextUsageTooltip() ?? super.getTooltip());
					this.updateTooltip();
				}

				private updateLastRequestUsageState(): void {
					const rawAvailable = this._contextKeyService.getContextKeyValue(ChatContextKeys.lastRequestUsageAvailable.key);
					const rawMax = this._contextKeyService.getContextKeyValue(ChatContextKeys.lastRequestMaxPromptTokens.key);
					const rawPrompt = this._contextKeyService.getContextKeyValue(ChatContextKeys.lastRequestPromptTokens.key);
					const rawPercent = this._contextKeyService.getContextKeyValue(ChatContextKeys.lastRequestPromptUsagePercent.key);
					const rawEstimateMax = this._contextKeyService.getContextKeyValue(ChatContextKeys.inputContextMaxTokens.key);

					const available = Boolean(rawAvailable);
					const maxTokens = Number(rawMax ?? 0);
					const promptTokens = Number(rawPrompt ?? 0);
					const percent = Math.max(0, Math.min(1, Number(rawPercent ?? 0)));
					const estimateMaxTokens = Number(rawEstimateMax ?? 0);
					const shouldShow = available || estimateMaxTokens > 0;

					this.lastRequestUsageElement.style.display = shouldShow ? 'flex' : 'none';
					this.lastRequestUsageElement.classList.toggle('unavailable', !available);
					this.lastRequestUsageElement.classList.toggle('over-limit', available && maxTokens > 0 && promptTokens > maxTokens);
					this.lastRequestUsageElement.classList.toggle('level-warning', available && maxTokens > 0 && promptTokens <= maxTokens && percent >= 0.9);
					this.lastRequestUsageElement.classList.toggle('level-caution', available && maxTokens > 0 && promptTokens <= maxTokens && percent >= 0.7 && percent < 0.9);
					this.lastRequestUsageElement.classList.toggle('level-ok', available && maxTokens > 0 && promptTokens <= maxTokens && percent < 0.7);

					const effectivePercent = available ? percent : 0;
					const dashOffset = this.lastRequestUsageCircumference * (1 - effectivePercent);
					this.lastRequestUsageProgressCircle.setAttribute('stroke-dashoffset', String(dashOffset));
					this.lastRequestUsageElement.setAttribute('aria-label', this.getLastRequestUsageTooltip() ?? localize('chatTools.lastRequestUsage.aria', 'Last request token usage'));
					this.updateTooltip();
				}

				private isAboveToolLimit() {
					const rawToolLimit = this._contextKeyService.getContextKeyValue(ChatContextKeys.chatToolGroupingThreshold.key);
					const rawToolCount = this._contextKeyService.getContextKeyValue(ChatContextKeys.chatToolCount.key);
					if (rawToolLimit === undefined || rawToolCount === undefined) {
						return false;
					}

					const toolLimit = Number(rawToolLimit || 0);
					const toolCount = Number(rawToolCount || 0);
					return toolCount > toolLimit;
				}
			}, action, undefined);
		});

		// Reduces flicker a bit on reload/restart
		markAsSingleton(disposable);
	}
}

export function registerChatToolActions() {
	registerAction2(AcceptToolConfirmation);
	registerAction2(SkipToolConfirmation);
	registerAction2(ConfigureToolsAction);
	registerWorkbenchContribution2(ConfigureToolsActionRendering.ID, ConfigureToolsActionRendering, WorkbenchPhase.BlockRestore);
}
