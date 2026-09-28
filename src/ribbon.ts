import { around } from "monkey-around";
import { Menu, RibbonItem, RibbonSettingTab, SettingDefinitionPage, setTooltip, WorkspaceRibbon } from "obsidian";
import { renderFolderIcon } from "./folderIcon";
import { flatten, LiveItem, reconcile, RibbonFolder, ribbonBlocks, seedLayout, updateFolder } from "./layout";
import type RibbonDrawersPlugin from "./main";
import { RibbonDrag } from "./ribbonDrag";
import { RibbonDrawersPage } from "./settingsPage";

export class RibbonController {
	private folderViews = new Map<string, FolderView>();
	private cleanups: (() => void)[] = [];
	private started = false;
	private settingsTab: RibbonSettingTab | null = null;
	private pageName = "Ribbon menu configuration";

	constructor(readonly plugin: RibbonDrawersPlugin) {}

	private get ribbon(): WorkspaceRibbon {
		return this.plugin.app.workspace.leftRibbon;
	}

	start(): void {
		if (this.started) return;
		this.started = true;
		const ribbon = this.ribbon;
		this.cleanups.push(
			around(ribbon, {
				onChange: (original) => (save: boolean) => {
					original.call(ribbon, save);
					this.render();
				},
			}),
		);
		this.blockNativeCustomisation();
		this.render();
	}

	stop(): void {
		if (!this.started) return;
		this.started = false;
		for (const cleanup of this.cleanups.splice(0).reverse()) cleanup();
		this.syncNative();
		this.ribbon.onChange(true);
		this.folderViews.clear();
	}

	liveItems(): LiveItem[] {
		return this.ribbon.items
			.filter((i) => i.buttonEl)
			.map((i) => ({ id: i.id, title: i.title, icon: i.icon, hidden: i.hidden }));
	}

	render(): void {
		if (!this.started) return;
		const live = this.liveItems();
		const current = this.plugin.layout;
		const { layout, changed } = current ? reconcile(current, live) : { layout: seedLayout(live), changed: true };
		if (changed) this.plugin.commitLayout(layout, { render: false });

		const buttons = new Map<string, HTMLElement>();
		for (const item of this.ribbon.items) if (item.buttonEl) buttons.set(item.id, item.buttonEl);

		const children: HTMLElement[] = [];
		const shownFolders = new Set<string>();
		for (const block of ribbonBlocks(layout, new Set(buttons.keys()))) {
			const els = block.ids.map((id) => buttons.get(id)!);
			if (block.kind === "loose") {
				for (const el of els) el.toggle(true);
				children.push(...els);
			} else {
				const view = this.folderView(block.folder.id);
				view.update(block.folder, els, this.plugin.settings.tintItems);
				children.push(view.el);
				shownFolders.add(block.folder.id);
			}
		}
		for (const id of this.folderViews.keys()) if (!shownFolders.has(id)) this.folderViews.delete(id);
		this.ribbon.ribbonItemsEl.setChildrenInPlace(children);
	}

	syncNative(): void {
		const layout = this.plugin.layout;
		if (!layout) return;
		const flat = flatten(layout);
		const rank = new Map(flat.map((f, i) => [f.id, i]));
		const hidden = new Map(flat.map((f) => [f.id, f.hidden]));
		const items = this.ribbon.items;
		const order = (item: RibbonItem, i: number) => rank.get(item.id) ?? flat.length + i;
		const sorted = items.map((item, i) => ({ item, key: order(item, i) })).sort((a, b) => a.key - b.key);
		items.splice(0, items.length, ...sorted.map((s) => s.item));
		for (const item of items) item.hidden = hidden.get(item.id) ?? item.hidden;
		this.plugin.app.workspace.requestSaveLayout();
	}

	private folderView(id: string): FolderView {
		let view = this.folderViews.get(id);
		if (!view) {
			view = new FolderView(
				id,
				() => this.toggleFolder(id),
				(evt) => this.showFolderMenu(evt),
			);
			this.folderViews.set(id, view);
		}
		return view;
	}

	private toggleFolder(id: string): void {
		const layout = this.plugin.layout;
		const folder = layout?.sections.find((s): s is RibbonFolder => s.kind === "folder" && s.id === id);
		if (!layout || !folder) return;
		this.plugin.commitLayout(updateFolder(layout, id, { open: !folder.open }), { refreshSettings: false });
	}

	private showFolderMenu(evt: MouseEvent): void {
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle("Organise ribbon…")
				.setIcon("settings")
				.onClick(() => this.openEditor()),
		);
		menu.showAtMouseEvent(evt);
	}

	private blockNativeCustomisation(): void {
		const { containerEl, ribbonItemsEl } = this.ribbon;

		const onContextMenu = (evt: MouseEvent) => {
			if (evt.target !== containerEl && evt.target !== ribbonItemsEl) return;
			evt.preventDefault();
			evt.stopImmediatePropagation();
			const menu = new Menu();
			menu.addItem((item) =>
				item
					.setTitle("Organise ribbon…")
					.setIcon("settings")
					.onClick(() => this.openEditor()),
			);
			menu.addSeparator();
			menu.addItem((item) =>
				item
					.setTitle("Hide ribbon")
					.setIcon("lucide-panel-left-close")
					.onClick(() => this.plugin.app.vault.setConfig("showRibbon", false)),
			);
			menu.showAtMouseEvent(evt);
		};
		containerEl.addEventListener("contextmenu", onContextMenu, true);
		this.cleanups.push(() => containerEl.removeEventListener("contextmenu", onContextMenu, true));

		const drag = new RibbonDrag(this.plugin, this.ribbon);
		const onMouseDown = (evt: MouseEvent) => {
			if (evt.target === ribbonItemsEl) return;
			evt.stopPropagation();
			drag.onMouseDown(evt);
		};
		const onTouchStart = (evt: TouchEvent) => {
			if (evt.target !== ribbonItemsEl) evt.stopPropagation();
		};
		ribbonItemsEl.addEventListener("mousedown", onMouseDown, true);
		ribbonItemsEl.addEventListener("touchstart", onTouchStart, true);
		this.cleanups.push(() => {
			ribbonItemsEl.removeEventListener("mousedown", onMouseDown, true);
			ribbonItemsEl.removeEventListener("touchstart", onTouchStart, true);
		});
		this.cleanups.push(() => drag.cancel());

		const ribbonTab = this.plugin.app.setting?.settingTabs?.find(
			(t) => typeof (t as Partial<RibbonSettingTab>).buildRibbonPage === "function",
		) as RibbonSettingTab | undefined;
		if (!ribbonTab) {
			return;
		}
		this.cleanups.push(() => {
			this.settingsTab = null;
			ribbonTab.update();
		});
		this.cleanups.push(
			around(ribbonTab, {
				buildRibbonPage: (original) => () => {
					const name = (original.call(ribbonTab) as { name?: string } | undefined)?.name || this.pageName;
					this.pageName = name;
					return {
						type: "page",
						name,
						desc: "Organise the ribbon's icons into folders, reorder them and hide them.",
						page: () => new RibbonDrawersPage(this.plugin, name),
					} satisfies SettingDefinitionPage;
				},
			}),
		);
		this.settingsTab = ribbonTab;
		ribbonTab.update();
	}

	openEditor(): void {
		const setting = this.plugin.app.setting;
		setting.open();
		if (!this.settingsTab) return;
		setting.openTabById(this.settingsTab.id);
		setting.openPage(new RibbonDrawersPage(this.plugin, this.pageName));
	}
}

class FolderView {
	readonly el = createDiv("rd-folder");
	private buttonEl = this.el.createDiv("clickable-icon side-dock-ribbon-action rd-folder-button");
	private itemsEl = this.el.createDiv("rd-folder-items");
	private drawnOpen: boolean | null = null;

	constructor(id: string, onClick: () => void, onContextMenu: (evt: MouseEvent) => void) {
		this.el.dataset.folderId = id;
		this.buttonEl.addEventListener("click", onClick);
		this.buttonEl.addEventListener("contextmenu", (evt) => {
			evt.preventDefault();
			onContextMenu(evt);
		});
	}

	update(folder: RibbonFolder, members: HTMLElement[], tintItems: boolean): void {
		this.el.toggleClass("is-open", folder.open);
		this.el.toggleClass("rd-tint-items", tintItems);
		this.el.toggleClass("rd-has-color", !!folder.color);
		this.el.setCssProps({ "--rd-color": folder.color ?? "" });

		if (folder.open !== this.drawnOpen) {
			renderFolderIcon(this.buttonEl, folder.open);
			this.drawnOpen = folder.open;
		}
		setTooltip(this.buttonEl, folder.name, { placement: "right" });
		this.buttonEl.setAttr("aria-expanded", String(folder.open));

		for (const m of members) m.toggle(true);
		this.itemsEl.setChildrenInPlace(folder.open ? members : []);
	}
}
