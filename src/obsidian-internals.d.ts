import type { PluginManifest, SettingPage } from "obsidian";

declare module "obsidian" {
	interface WorkspaceRibbon {
		items: RibbonItem[];
		containerEl: HTMLElement;
		ribbonItemsEl: HTMLElement;
		onChange(save: boolean): void;
	}

	interface RibbonItem {
		id: string;
		title: string;
		icon: string;
		hidden: boolean;
		callback?: () => unknown;
		buttonEl?: HTMLElement;
	}

	interface SettingTab {
		id: string;
	}

	interface RibbonSettingTab extends SettingTab {
		buildRibbonPage(): unknown;
	}

	interface App {
		setting: {
			settingTabs: SettingTab[];
			open(): void;
			openTabById(id: string): void;
			openPage(page: SettingPage): void;
		};
		plugins: {
			enabledPlugins: Set<string>;
			manifests: Record<string, PluginManifest>;
		};
	}

	interface Vault {
		setConfig(key: string, value: unknown): void;
	}
}
