import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';


import {
	ViewUpdate,
	PluginValue,
	DecorationSet,
	EditorView,
	PluginSpec,
	WidgetType,
	ViewPlugin,
	Decoration,
} from "@codemirror/view";

import { SyntaxNodeRef } from '@lezer/common';


import {
	Extension,
	RangeSetBuilder,
	StateField,
	Transaction,
} from "@codemirror/state";

import { syntaxTree } from "@codemirror/language";
import { match } from 'assert';

// Remember to rename these classes and interfaces!

interface MyPluginSettings {
	mySetting: string;
}

const DEFAULT_SETTINGS: MyPluginSettings = {
	mySetting: 'default'
}

export class TimeLengthWidget extends WidgetType {
	timeText: String;

	constructor(timeText: String) {
		super();
		this.timeText = timeText;
	}

	toDOM(view: EditorView): HTMLElement {
		const div = document.createElement("span");
		div.setCssStyles({
			color: '#888',
		});

		div.innerText = " — ⏱️ " + this.timeText;

		return div;
	}
}

const timeRangeRx = new RegExp("^.*?(\\d\\d:\\d\\d).*?(\\d\\d:\\d\\d).*", "");

function parseToMinutes(timeStr: String) {
	const [hours, minutes] = timeStr.split(':').map(Number);
	return hours * 60 + minutes;
}

interface TimeDuration {
	hours: number;
	minutes: number;
}

function sumDurations(dur1: TimeDuration, dur2: TimeDuration) {
	const mins = (dur1.hours + dur2.hours) * 60 + dur1.minutes + dur2.minutes;
	return {
		hours: Math.floor(mins / 60),
		minutes: mins % 60,
	}
}

// FIXME: time can be negative here
function diffDuration(timeStr1: String, timeStr2: String) {
	const minutes1 = parseToMinutes(timeStr1);
	const minutes2 = parseToMinutes(timeStr2);
	const difference = Math.abs(minutes2 - minutes1);

	return {
		hours: Math.floor(difference / 60),
		minutes: difference % 60,
	}
}

function bulletNodeDuration(bulletValue: String, bulletNode: SyntaxNodeRef) {
	const match = bulletValue.match(timeRangeRx);

	if (match != null) {
		return diffDuration(match[1], match[2]);
	}

	return null;
}

function formatDuration(duration: TimeDuration) {
	const minutes = duration.minutes + ' mins';
	if (duration.hours > 0) {
		return duration.hours + ' h ' + minutes;
	} else {
		return minutes;
	}
}

interface MarkPos {
	from: number,
	to: number,
}

interface TimedTask {
	level: number,
	position: number,
	markPos?: MarkPos,
	parent?: TimedTask,
	duration?: TimeDuration,
	children: Array<TimedTask>,
}

function setTasksDuration(taskList: Array<TimedTask>): TimeDuration {
	let duration: TimeDuration = {
		hours: 0,
		minutes: 0,
	};

	for (const currentTask of taskList) {
		if (currentTask.duration == null) {
			currentTask.duration = setTasksDuration(currentTask.children);
		}

		duration = sumDurations(duration, currentTask.duration);
	}

	return duration;
}

function displayDurations(builder: RangeSetBuilder<Decoration>, taskList: Array<TimedTask>) {
	for (const currentTask of taskList) {
		const dur = currentTask.duration;
		const markPos = currentTask.markPos;

		if (markPos != null) {
			builder.add(
				markPos.from,
				markPos.to,
				Decoration.mark({
					attributes: {
						"style": "color:#44dddd;font-family:Courier;font-size:11pt;font-weight:600;letter-spacing:-1px;"
					}
				})
			);
		}

		if (dur != null && (dur.hours != 0 || dur.minutes != 0)) {
			const durationStr = formatDuration(dur); 
			
			builder.add(
				currentTask.position,
				currentTask.position,
				Decoration.widget({
					widget: new TimeLengthWidget(durationStr),
					side: 1, // at the right of last symbol of the line
				})
			)
		}

		displayDurations(builder, currentTask.children);
	}
}

const listNodeNameRx = new RegExp("^list-(\\d)", "");

class TaskTimeDisplayPlugin implements PluginValue {
	decorations: DecorationSet;

	constructor(view: EditorView) {
		this.decorations = this.buildDecorations(view);
	}

	update(update: ViewUpdate) {
		if (update.docChanged || update.viewportChanged) {
			this.decorations = this.buildDecorations(update.view);
		}
	}

	destroy() { }

	buildDecorations(view: EditorView): DecorationSet {
		const builder = new RangeSetBuilder<Decoration>();

		let rootTask: any = {
			level: 0,
			children: [],
		};
		let currentParent = rootTask;

		for (let { from, to } of view.visibleRanges) {
			view
			syntaxTree(view.state).iterate({
				from,
				to,
				enter(node) {
					const listNodeMatch = node.name.match(listNodeNameRx);
					if (listNodeMatch != null) {
						const currentTaskLevel = parseInt(listNodeMatch[1]);
						const endOfLinePosition = node.to;

						const bulletValue = view.state.sliceDoc(node.from, node.to);
						const duration = bulletNodeDuration(bulletValue, node);

						const timeRangeRx = new RegExp("(\\d\\d:\\d\\d)(\\s*[-–—]\\s*\\d\\d:\\d\\d)?.*$", "");
						const timeRangeMatch = timeRangeRx.exec(bulletValue);

						const markPos = (timeRangeMatch != null && timeRangeMatch.length == 3)
							? {
								from: node.from + timeRangeMatch.index,
								to: node.from + timeRangeMatch.index + (timeRangeMatch[1]?.length || 0) + (timeRangeMatch[2]?.length || 0),
							}
							: null;
						

						while (currentParent != null && currentParent.level >= currentTaskLevel) {
							currentParent = currentParent.parent;
						}

						const currentTask = {
							level: currentTaskLevel,
							position: endOfLinePosition,
							markPos: markPos,
							parent: currentParent,
							duration: duration,
							children: [],
						}
						currentParent.children.push(currentTask);
						currentParent = currentTask;
					}
				},
			});
		}

		setTasksDuration(rootTask.children);
		displayDurations(builder, rootTask.children);

		return builder.finish();
	}
}

const pluginSpec: PluginSpec<TaskTimeDisplayPlugin> = {
	decorations: (value: TaskTimeDisplayPlugin) => value.decorations,
};

export const TimeTrackingDisplayPlugin = ViewPlugin.fromClass(
	TaskTimeDisplayPlugin,
	pluginSpec
);


export default class MyPlugin extends Plugin {
	settings: MyPluginSettings;

	async onload() {
		await this.loadSettings();

		// const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		this.registerEditorExtension(TimeTrackingDisplayPlugin);


		// this.addCommand({
		// 	id: "build-decorations-command",
		// 	name: "Build decorations",
		// 	editorCallback: (editor, view) => {
		// 		// @ts-expect-error, not typed
		// 		const editorView = view.editor.cm as EditorView;
		// 		const plugin = editorView.plugin(emojiListPlugin);

		// 		if (plugin) {
		// 			plugin.buildDecorations(editorView);
		// 		}
		// 	},
		// });

		// this.registerMarkdownPostProcessor((element, context) => {
		// 	const codeblocks = element.querySelectorAll("div");
		// 	//div. HyperMD-list-line HyperMD-list-line-1 HyperMD-task-line cm-line
		// 	//div. HyperMD-list-line HyperMD-list-line-2 HyperMD-task-line cm-line

		// 	for (let index = 0; index < codeblocks.length; index++) {
		// 		const codeblock = codeblocks.item(index);
		// 		console.log('BLOCK', codeblock.innerHTML);

		// 		if (!codeblock.classList.contains("HyperMD-list-line")) {
		// 			console.log('classss', codeblock.classList);
		// 			continue;
		// 		}

		// 		// const text = codeblock.innerHTML.trim();
		// 		// context.addChild(new Emoji(codeblock, 'test2'));
		// 		// console.log('ADDED TO', text);
		// 	}
		// });


		// This creates an icon in the left ribbon.
		const ribbonIconEl = this.addRibbonIcon('dice', 'Sample Plugin', (evt: MouseEvent) => {
			// Called when the user clicks the icon.
			new Notice('AAAAA a notice!');
		});

		// Perform additional things with the ribbon
		ribbonIconEl.addClass('my-plugin-ribbon-class');

		// This adds a status bar item to the bottom of the app. Does not work on mobile apps.
		// const statusBarItemEl = this.addStatusBarItem();
		// statusBarItemEl.setText('Status Bar Text');

		// This adds a simple command that can be triggered anywhere
		this.addCommand({
			id: 'open-sample-modal-simple',
			name: 'Open sample modal (simple)',
			callback: () => {
				new SampleModal(this.app).open();
			}
		});

		// This adds an editor command that can perform some operation on the current editor instance
		this.addCommand({
			id: 'sample-editor-command',
			name: 'Sample editor command',
			editorCallback: (editor: Editor, view: MarkdownView) => {
				console.log(editor.getSelection());
				editor.replaceSelection('Sample Editor Command');
			}
		});
		
		// This adds a complex command that can check whether the current state of the app allows execution of the command
		this.addCommand({
			id: 'open-sample-modal-complex',
			name: 'Open sample modal (complex)',
			checkCallback: (checking: boolean) => {
				// Conditions to check
				const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (markdownView) {
					// If checking is true, we're simply "checking" if the command can be run.
					// If checking is false, then we want to actually perform the operation.
					if (!checking) {
						new SampleModal(this.app).open();
					}

					// This command will only show up in Command Palette when the check function returns true
					return true;
				}
			}
		});

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new SampleSettingTab(this.app, this));

		// If the plugin hooks up any global DOM events (on parts of the app that doesn't belong to this plugin)
		// Using this function will automatically remove the event listener when this plugin is disabled.
		// this.registerDomEvent(document, 'click', (evt: MouseEvent) => {
		// 	console.log('click', evt);
		// });

		// When registering intervals, this function will automatically clear the interval when the plugin is disabled.
		this.registerInterval(window.setInterval(() => console.log('setInterval'), 5 * 60 * 1000));
	}

	onunload() {

	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

// Example stuff
class SampleModal extends Modal {
	constructor(app: App) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.setText('Woah!');
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

class SampleSettingTab extends PluginSettingTab {
	plugin: MyPlugin;

	constructor(app: App, plugin: MyPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		containerEl.createEl('h2', { text: 'Settings for my awesome plugin.' });

		new Setting(containerEl)
			.setName('Setting #1')
			.setDesc('It\'s a secret')
			.addText(text => text
				.setPlaceholder('Enter your secret')
				.setValue(this.plugin.settings.mySetting)
				.onChange(async (value) => {
					console.log('Secret: ' + value);
					this.plugin.settings.mySetting = value;
					await this.plugin.saveSettings();
				}));
	}
}
