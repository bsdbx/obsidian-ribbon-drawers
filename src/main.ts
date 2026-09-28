import { Plugin } from "obsidian";
import type { RibbonLayout } from "./layout";
import { RibbonController } from "./ribbon";
import type { RibbonDrawersPage } from "./settingsPage";

export interface Settings {
	tintItems: boolean;
}

const DEFAULT_SETTINGS: Settings = { tintItems: false };

interface PluginData {
	version: 1;
	layout: RibbonLayout | null;
	settings?: Partial<Settings>;
}

export interface CommitOptions {
	save?: boolean;
	render?: boolean;
	refreshSettings?: boolean;
}

export default class RibbonDrawersPlugin extends Plugin {
	layout: RibbonLayout | null = null;
	settings: Settings = { ...DEFAULT_SETTINGS };
	ribbon = new RibbonController(this);
	activePage: RibbonDrawersPage | null = null;

	async onload(): Promise<void> {
		const data = (await this.loadData()) as PluginData | null;
		this.layout = data?.layout ?? null;
		this.settings = { ...DEFAULT_SETTINGS, ...data?.settings };
		this.app.workspace.onLayoutReady(() => this.ribbon.start());
	}

	onunload(): void {
		this.ribbon.stop();
	}

	async onExternalSettingsChange(): Promise<void> {
		const data = (await this.loadData()) as PluginData | null;
		if (!data?.layout) return;
		this.settings = { ...DEFAULT_SETTINGS, ...data.settings };
		this.commitLayout(data.layout, { save: false });
	}

	commitLayout(layout: RibbonLayout, { save = true, render = true, refreshSettings = true }: CommitOptions = {}): void {
		this.layout = layout;
		if (save) this.save();
		this.ribbon.syncNative();
		if (render) this.ribbon.render();
		if (refreshSettings) this.activePage?.refresh();
	}

	updateSettings(patch: Partial<Settings>): void {
		this.settings = { ...this.settings, ...patch };
		this.save();
		this.ribbon.render();
		this.activePage?.refresh();
	}

	private save(): void {
		void this.saveData({ version: 1, layout: this.layout, settings: this.settings } satisfies PluginData);
	}
}
