import { App, ButtonComponent, Menu, Modal, Setting, SettingPage, setIcon, setTooltip } from "obsidian";
import { renderFolderIcon } from "./folderIcon";
import {
	addFolder,
	deleteFolder,
	ItemRef,
	moveItem,
	moveSection,
	pluginOf,
	removeItem,
	RibbonFolder,
	RibbonLayout,
	Section,
	setItemHidden,
	setSectionCollapsed,
	setSectionItemsHidden,
	updateFolder,
} from "./layout";
import type { CommitOptions, default as RibbonDrawersPlugin } from "./main";

type DragState = { kind: "item"; id: string } | { kind: "section"; index: number };

function isRibbonArranger(id: string): boolean {
	return id === "cmdr" || /ribbon|sidebar-organi[sz]er|customizable-sidebar/i.test(id);
}

export class RibbonDrawersPage extends SettingPage {
	private filter = "";
	private listEl: HTMLElement | null = null;
	private drag: DragState | null = null;
	private pendingDrop: (() => void) | null = null;
	private focusFolderId: string | null = null;

	constructor(
		private plugin: RibbonDrawersPlugin,
		title: string,
	) {
		super();
		this.title = title;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass("rd-settings");
		this.plugin.activePage = this;
		this.renderConflictWarning(containerEl);

		new Setting(containerEl)
			.setName("Color icons like their folder")
			.setDesc("Icons inside a colored folder take on the folder's color.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.tintItems).onChange((tintItems) => this.plugin.updateSettings({ tintItems })),
			);

		const filterEl = containerEl.createEl("input", {
			type: "search",
			cls: "rd-filter",
			attr: { placeholder: "Filter icons…", spellcheck: "false" },
		});
		filterEl.value = this.filter;
		filterEl.addEventListener("input", () => {
			this.filter = filterEl.value;
			this.renderList();
		});

		this.listEl = containerEl.createDiv("rd-sections");
		this.listEl.addEventListener("dragleave", (evt) => {
			if (!this.listEl?.contains(evt.relatedTarget as Node | null)) this.clearDropIndicators();
		});
		this.renderList();

		new ButtonComponent(containerEl.createDiv("rd-footer")).setButtonText("New folder").onClick(() => {
			const id = `f-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
			this.focusFolderId = id;
			this.edit((l) => addFolder(l, id));
		});
	}

	hide(): void {
		this.listEl = null;
		this.drag = null;
		if (this.plugin.activePage === this) this.plugin.activePage = null;
	}

	refresh(): void {
		if (this.listEl?.isConnected && !this.drag) this.renderList();
	}

	private renderConflictWarning(containerEl: HTMLElement): void {
		const { enabledPlugins, manifests } = this.plugin.app.plugins;
		const others = [...enabledPlugins].filter((id) => id !== this.plugin.manifest.id && isRibbonArranger(id));
		if (others.length === 0) return;
		const names = others.map((id) => manifests[id]?.name ?? id).join(", ");
		const el = containerEl.createDiv("rd-warning");
		setIcon(el.createSpan("rd-warning-icon"), "alert-triangle");
		el.createSpan({
			text:
				`${names} may also rearrange the ribbon. If icons jump around or folders misbehave, ` +
				"turn off that plugin's ribbon features.",
		});
	}

	private edit(fn: (layout: RibbonLayout) => RibbonLayout, options?: CommitOptions): void {
		const layout = this.plugin.layout;
		if (layout) this.plugin.commitLayout(fn(layout), options);
	}

	private renderList(): void {
		const listEl = this.listEl;
		const layout = this.plugin.layout;
		if (!listEl) return;
		listEl.empty();
		if (!layout) {
			listEl.createDiv({ cls: "rd-empty", text: "The ribbon isn't ready yet." });
			return;
		}
		const liveIds = new Set(this.plugin.ribbon.liveItems().map((i) => i.id));
		const query = this.filter.trim().toLowerCase();
		layout.sections.forEach((section, index) => this.renderSection(listEl, section, index, liveIds, query));

		if (this.focusFolderId) {
			const input = listEl.querySelector<HTMLInputElement>(`[data-folder-id="${this.focusFolderId}"] .rd-name`);
			this.focusFolderId = null;
			input?.focus();
			input?.select();
		}
	}

	private renderSection(
		listEl: HTMLElement,
		section: Section,
		index: number,
		liveIds: ReadonlySet<string>,
		query: string,
	): void {
		const matches = (r: ItemRef) =>
			!query || r.title.toLowerCase().includes(query) || r.id.toLowerCase().includes(query);
		const folderMatches = section.kind === "folder" && !!query && section.name.toLowerCase().includes(query);
		const items = folderMatches ? section.items : section.items.filter(matches);
		if (query && items.length === 0 && !folderMatches) return;

		const sectionEl = listEl.createDiv("rd-section");
		if (section.kind === "folder") sectionEl.dataset.folderId = section.id;
		sectionEl.toggleClass("is-hidden", section.kind === "folder" && section.hidden);

		this.renderHeader(sectionEl, section, index);

		const expanded = !section.collapsed || !!query;
		if (expanded) {
			const bodyEl = sectionEl.createDiv("rd-section-body");
			if (section.items.length === 0) {
				bodyEl.createDiv({ cls: "rd-empty", text: "Drop icons here" });
			}
			for (const ref of items) this.renderItem(bodyEl, section, ref, liveIds);
		}

		this.wireDropTarget(sectionEl, section, index);
	}

	private renderHeader(sectionEl: HTMLElement, section: Section, index: number): void {
		const headerEl = sectionEl.createDiv("rd-section-header");

		this.makeDraggable(headerEl, sectionEl, { kind: "section", index });

		const chevron = headerEl.createDiv("clickable-icon rd-chevron");
		setIcon(chevron, section.collapsed ? "chevron-right" : "chevron-down");
		chevron.addEventListener("click", () => this.edit((l) => setSectionCollapsed(l, index, !section.collapsed)));

		if (section.kind === "folder") {
			const preview = headerEl.createDiv("rd-folder-preview");
			this.paintPreview(preview, section.color);

			const nameEl = headerEl.createEl("input", { type: "text", cls: "rd-name", attr: { spellcheck: "false" } });
			nameEl.value = section.name;
			nameEl.addEventListener("keydown", (evt) => {
				if (evt.key === "Enter") nameEl.blur();
			});
			nameEl.addEventListener("change", () => this.edit((l) => updateFolder(l, section.id, { name: nameEl.value })));
		} else {
			headerEl.createSpan({ cls: "rd-section-title", text: "Ungrouped" });
		}

		headerEl.createDiv("rd-spacer");

		if (section.kind === "folder") this.renderFolderControls(headerEl, section);
		else {
			const more = headerEl.createDiv("clickable-icon rd-more");
			setIcon(more, "more-horizontal");
			setTooltip(more, "More options");
			more.addEventListener("click", (evt) => {
				const menu = new Menu();
				menu.addItem((i) =>
					i
						.setTitle("Show all")
						.setIcon("eye")
						.onClick(() => this.edit((l) => setSectionItemsHidden(l, index, false))),
				);
				menu.addItem((i) =>
					i
						.setTitle("Hide all")
						.setIcon("eye-off")
						.onClick(() => this.edit((l) => setSectionItemsHidden(l, index, true))),
				);
				menu.showAtMouseEvent(evt);
			});
		}
	}

	private paintPreview(el: HTMLElement, color: string | null): void {
		renderFolderIcon(el, false);
		el.setCssStyles({ color: color ?? "" });
	}

	private renderFolderControls(headerEl: HTMLElement, folder: RibbonFolder): void {
		const preview = headerEl.querySelector<HTMLElement>(".rd-folder-preview");

		const colorWrap = headerEl.createDiv("rd-color");
		const colorEl = colorWrap.createEl("input", { type: "color" });
		colorEl.value = folder.color ?? "#8a8a8a";
		colorWrap.toggleClass("is-unset", !folder.color);
		setTooltip(colorWrap, folder.color ? "Folder color" : "Set folder color");
		colorEl.addEventListener("input", () => {
			if (preview) this.paintPreview(preview, colorEl.value);
			colorWrap.removeClass("is-unset");
			this.edit((l) => updateFolder(l, folder.id, { color: colorEl.value }), { save: false, refreshSettings: false });
		});
		colorEl.addEventListener("change", () => this.edit((l) => updateFolder(l, folder.id, { color: colorEl.value })));
		if (folder.color) {
			const reset = headerEl.createDiv("clickable-icon rd-color-reset");
			setIcon(reset, "rotate-ccw");
			setTooltip(reset, "Remove folder color");
			reset.addEventListener("click", () => this.edit((l) => updateFolder(l, folder.id, { color: null })));
		}

		const eye = headerEl.createDiv("clickable-icon rd-eye");
		setIcon(eye, folder.hidden ? "eye-off" : "eye");
		setTooltip(eye, folder.hidden ? "Show folder" : "Hide folder");
		eye.addEventListener("click", () => this.edit((l) => updateFolder(l, folder.id, { hidden: !folder.hidden })));

		const del = headerEl.createDiv("clickable-icon rd-delete");
		setIcon(del, "x");
		setTooltip(del, "Delete folder");
		del.addEventListener("click", () => {
			const doDelete = () => this.edit((l) => deleteFolder(l, folder.id));
			if (folder.items.length === 0) doDelete();
			else
				new ConfirmModal(
					this.plugin.app,
					`Delete "${folder.name}"?`,
					`Its ${folder.items.length} icon${folder.items.length === 1 ? "" : "s"} will move to Ungrouped.`,
					doDelete,
				).open();
		});
	}

	private renderItem(bodyEl: HTMLElement, section: Section, ref: ItemRef, liveIds: ReadonlySet<string>): void {
		const available = liveIds.has(ref.id);
		const rowEl = bodyEl.createDiv("rd-item");
		rowEl.dataset.index = String(section.items.indexOf(ref));
		rowEl.toggleClass("is-hidden", ref.hidden);
		rowEl.toggleClass("is-unavailable", !available);

		this.makeDraggable(rowEl, rowEl, { kind: "item", id: ref.id });

		const iconEl = rowEl.createDiv("rd-item-icon");
		setIcon(iconEl, ref.icon);
		if (section.kind === "folder" && section.color && this.plugin.settings.tintItems)
			iconEl.setCssStyles({ color: section.color });
		rowEl.createSpan({ cls: "rd-item-title", text: ref.title });
		if (!available) rowEl.createSpan({ cls: "rd-pill", text: "unavailable" });
		rowEl.createDiv("rd-spacer");
		rowEl.createEl("code", { cls: "rd-plugin-id", text: pluginOf(ref.id) });

		if (available) {
			const eye = rowEl.createDiv("clickable-icon rd-eye");
			setIcon(eye, ref.hidden ? "eye-off" : "eye");
			setTooltip(eye, ref.hidden ? "Show" : "Hide");
			eye.addEventListener("click", () => this.edit((l) => setItemHidden(l, ref.id, !ref.hidden)));
		} else {
			const remove = rowEl.createDiv("clickable-icon rd-delete");
			setIcon(remove, "trash-2");
			setTooltip(remove, "Forget this icon (its plugin is disabled or uninstalled)");
			remove.addEventListener("click", () => this.edit((l) => removeItem(l, ref.id)));
		}
	}

	private makeDraggable(handle: HTMLElement, ghostEl: HTMLElement, state: DragState): void {
		handle.addClass("rd-draggable");
		handle.draggable = true;
		handle.addEventListener("mousedown", (evt) => {
			handle.draggable = !(evt.target as HTMLElement).closest("input, .clickable-icon");
		});
		handle.addEventListener("dragstart", (evt) => {
			evt.stopPropagation();
			this.drag = state;
			evt.dataTransfer?.setData("text/plain", state.kind === "item" ? state.id : String(state.index));
			if (evt.dataTransfer) evt.dataTransfer.effectAllowed = "move";
			evt.dataTransfer?.setDragImage(ghostEl, 16, 16);
			ghostEl.addClass("is-dragging");
		});
		handle.addEventListener("dragend", () => {
			ghostEl.removeClass("is-dragging");
			this.drag = null;
			this.clearDropIndicators();
			this.refresh();
		});
	}

	private wireDropTarget(sectionEl: HTMLElement, section: Section, index: number): void {
		sectionEl.addEventListener("dragover", (evt) => {
			const drop = this.dropAt(evt, sectionEl, section, index);
			if (!drop) return;
			evt.preventDefault();
			if (evt.dataTransfer) evt.dataTransfer.dropEffect = "move";
			this.clearDropIndicators();
			drop.el.addClass(drop.cls);
			this.pendingDrop = drop.apply;
		});
		sectionEl.addEventListener("drop", (evt) => {
			evt.preventDefault();
			const apply = this.pendingDrop;
			this.drag = null;
			this.clearDropIndicators();
			apply?.();
		});
	}

	private dropAt(
		evt: DragEvent,
		sectionEl: HTMLElement,
		section: Section,
		index: number,
	): { el: HTMLElement; cls: string; apply: () => void } | null {
		const drag = this.drag;
		if (!drag) return null;
		const below = (el: HTMLElement) => {
			const rect = el.getBoundingClientRect();
			return evt.clientY > rect.top + rect.height / 2;
		};

		if (drag.kind === "section") {
			const after = below(sectionEl);
			let to = index + (after ? 1 : 0);
			if (drag.index < to) to--;
			return {
				el: sectionEl,
				cls: after ? "rd-drop-after" : "rd-drop-before",
				apply: () => this.edit((l) => moveSection(l, drag.index, to)),
			};
		}

		const row = (evt.target as HTMLElement).closest<HTMLElement>(".rd-item");
		if (row && sectionEl.contains(row)) {
			const after = below(row);
			const to = Number(row.dataset.index) + (after ? 1 : 0);
			return {
				el: row,
				cls: after ? "rd-drop-after" : "rd-drop-before",
				apply: () => this.edit((l) => moveItem(l, drag.id, index, to)),
			};
		}
		return {
			el: sectionEl,
			cls: "rd-drop-into",
			apply: () => this.edit((l) => moveItem(l, drag.id, index, section.items.length)),
		};
	}

	private clearDropIndicators(): void {
		this.pendingDrop = null;
		this.listEl
			?.querySelectorAll(".rd-drop-before, .rd-drop-after, .rd-drop-into")
			.forEach((el) => el.removeClass("rd-drop-before", "rd-drop-after", "rd-drop-into"));
	}
}

class ConfirmModal extends Modal {
	constructor(
		app: App,
		title: string,
		private message: string,
		private onConfirm: () => void,
	) {
		super(app);
		this.setTitle(title);
	}

	onOpen(): void {
		this.contentEl.createEl("p", { text: this.message });
		const buttons = this.contentEl.createDiv("modal-button-container");
		new ButtonComponent(buttons)
			.setButtonText("Delete")
			.setDestructive()
			.onClick(() => {
				this.close();
				this.onConfirm();
			});
		new ButtonComponent(buttons).setButtonText("Cancel").onClick(() => this.close());
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
