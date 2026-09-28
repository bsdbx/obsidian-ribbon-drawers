import type { WorkspaceRibbon } from "obsidian";
import {
	dropFolder,
	dropItem,
	findFolder,
	FolderDrop,
	folderOf,
	ItemDrop,
	RibbonLayout,
	UNGROUPED_KEY,
	updateFolder,
} from "./layout";
import type RibbonDrawersPlugin from "./main";

const DRAG_THRESHOLD = 5;
const SPRING_OPEN_DELAY = 150;

type Payload = { kind: "item"; id: string } | { kind: "folder"; id: string };

interface Rect {
	top: number;
	bottom: number;
	left: number;
	width: number;
}

interface Line {
	y: number;
	left: number;
	width: number;
}

type Target =
	| { kind: "item"; drop: ItemDrop; line?: Line; intoEl?: HTMLElement; springFolderId?: string; color: string }
	| { kind: "folder"; drop: FolderDrop; line: Line; color: string };

function lineUnder(r: Rect, place: "before" | "after"): Line {
	const inset = r.width * 0.2;
	return { y: place === "after" ? r.bottom + 3 : r.top - 3, left: r.left + inset, width: r.width - inset * 2 };
}

export class RibbonDrag {
	private session: DragSession | null = null;

	constructor(
		private plugin: RibbonDrawersPlugin,
		private ribbon: WorkspaceRibbon,
	) {}

	onMouseDown(evt: MouseEvent): void {
		if (evt.button !== 0 || this.session) return;
		const buttonEl = (evt.target as HTMLElement).closest<HTMLElement>(".side-dock-ribbon-action");
		if (!buttonEl) return;

		let payload: Payload;
		let dimEl: HTMLElement;
		const folderEl = buttonEl.hasClass("rd-folder-button") ? buttonEl.closest<HTMLElement>(".rd-folder") : null;
		if (folderEl?.dataset.folderId) {
			payload = { kind: "folder", id: folderEl.dataset.folderId };
			dimEl = folderEl;
		} else {
			const item = this.ribbon.items.find((i) => i.buttonEl === buttonEl);
			if (!item) return;
			payload = { kind: "item", id: item.id };
			dimEl = buttonEl;
		}
		this.session = new DragSession(
			this.plugin,
			this.ribbon,
			payload,
			buttonEl,
			dimEl,
			evt,
			() => (this.session = null),
		);
	}

	cancel(): void {
		this.session?.end(false);
	}
}

class DragSession {
	private win: Window;
	private doc: Document;
	private started = false;
	private ghostEl: HTMLElement | null = null;
	private lineEl: HTMLElement | null = null;
	private markedEl: HTMLElement | null = null;
	private target: Target | null = null;
	private offsetX: number;
	private offsetY: number;
	private lastX = 0;
	private lastY = 0;
	private pendingSpring: string | null = null;
	private springTimer: number | null = null;
	private springOpened = new Set<string>();

	constructor(
		private plugin: RibbonDrawersPlugin,
		private ribbon: WorkspaceRibbon,
		private payload: Payload,
		private buttonEl: HTMLElement,
		private dimEl: HTMLElement,
		private startEvt: MouseEvent,
		private onEnd: () => void,
	) {
		this.doc = buttonEl.doc;
		this.win = buttonEl.win;
		const rect = buttonEl.getBoundingClientRect();
		this.offsetX = startEvt.clientX - rect.left;
		this.offsetY = startEvt.clientY - rect.top;
		this.win.addEventListener("mousemove", this.onMove, true);
		this.win.addEventListener("mouseup", this.onUp, true);
		this.win.addEventListener("keydown", this.onKey, true);
	}

	private onMove = (evt: MouseEvent) => {
		if (!this.started) {
			const dx = evt.clientX - this.startEvt.clientX;
			const dy = evt.clientY - this.startEvt.clientY;
			if (dx * dx + dy * dy < DRAG_THRESHOLD * DRAG_THRESHOLD) return;
			this.begin();
		}
		evt.preventDefault();
		this.lastX = evt.clientX;
		this.lastY = evt.clientY;
		this.moveGhost();
		this.aim();
	};

	private onUp = () => this.end(true);

	private onKey = (evt: KeyboardEvent) => {
		if (evt.key !== "Escape" || !this.started) return;
		evt.preventDefault();
		evt.stopPropagation();
		this.end(false);
	};

	private begin(): void {
		this.started = true;
		const ghost = (this.ghostEl = this.buttonEl.cloneNode(true) as HTMLElement);
		ghost.addClass("rd-drag-ghost");
		ghost.removeAttribute("aria-label");
		ghost.setCssStyles({ color: getComputedStyle(this.buttonEl).color });
		this.doc.body.appendChild(ghost);
		this.dimEl.addClass("rd-drag-source");
		this.lineEl = this.doc.body.createDiv("rd-drop-line");
		this.lineEl.hide();
		this.doc.body.addClass("is-grabbing");
	}

	private moveGhost(): void {
		this.ghostEl?.setCssStyles({
			transform: `translate3d(${this.lastX - this.offsetX}px, ${this.lastY - this.offsetY}px, 0)`,
		});
	}

	end(apply: boolean): void {
		this.win.removeEventListener("mousemove", this.onMove, true);
		this.win.removeEventListener("mouseup", this.onUp, true);
		this.win.removeEventListener("keydown", this.onKey, true);
		this.onEnd();
		if (!this.started) return;

		const target = apply ? this.target : null;
		this.setTarget(null);
		this.ghostEl?.remove();
		this.lineEl?.remove();
		this.dimEl.removeClass("rd-drag-source");
		this.doc.body.removeClass("is-grabbing");
		const swallowClick = (evt: MouseEvent) => {
			evt.stopPropagation();
			evt.preventDefault();
		};
		this.win.addEventListener("click", swallowClick, true);
		this.win.setTimeout(() => this.win.removeEventListener("click", swallowClick, true), 0);

		let layout = this.plugin.layout;
		if (!layout) return;
		const before = layout;
		if (target?.kind === "item" && this.payload.kind === "item")
			layout = dropItem(layout, this.payload.id, target.drop);
		if (target?.kind === "folder" && this.payload.kind === "folder")
			layout = dropFolder(layout, this.payload.id, target.drop);
		const destination = this.payload.kind === "item" ? folderOf(layout, this.payload.id)?.id : undefined;
		layout = this.closeSpringOpened(layout, destination);
		if (layout !== before) this.plugin.commitLayout(layout);
	}

	private aim(): void {
		let target = this.findTarget(this.lastX, this.lastY);
		const inside = target ? this.folderAt(target) : undefined;
		let layout = this.plugin.layout;
		const leaving = [...this.springOpened].filter((id) => id !== inside);
		if (layout && leaving.length > 0) {
			for (const id of leaving) {
				layout = updateFolder(layout, id, { open: false });
				this.springOpened.delete(id);
			}
			this.plugin.commitLayout(layout, { refreshSettings: false });
			target = this.findTarget(this.lastX, this.lastY);
		}
		this.setTarget(target);
	}

	private findTarget(x: number, y: number): Target | null {
		const ribbonRect = this.ribbon.containerEl.getBoundingClientRect();
		if (x < ribbonRect.left - 24 || x > ribbonRect.right + 24 || y < ribbonRect.top || y > ribbonRect.bottom)
			return null;
		return this.payload.kind === "item" ? this.findItemTarget(y) : this.findFolderTarget(y);
	}

	private findItemTarget(y: number): Target | null {
		let best: HTMLElement | null = null;
		let bestDistance = Infinity;
		for (const el of Array.from(this.ribbon.ribbonItemsEl.querySelectorAll<HTMLElement>(".side-dock-ribbon-action"))) {
			if (!el.isShown()) continue;
			const r = el.getBoundingClientRect();
			const distance = Math.abs(y - (r.top + r.height / 2));
			if (distance < bestDistance) {
				best = el;
				bestDistance = distance;
			}
		}
		if (!best) return null;
		const r = best.getBoundingClientRect();

		if (best.hasClass("rd-folder-button")) {
			const folderId = best.closest<HTMLElement>(".rd-folder")?.dataset.folderId;
			const folder = folderId && this.plugin.layout ? findFolder(this.plugin.layout, folderId) : undefined;
			if (!folderId || !folder) return null;
			const color = this.colorOf(folderId);
			return folder.open
				? { kind: "item", drop: { kind: "folderStart", folderId }, line: lineUnder(r, "after"), color }
				: { kind: "item", drop: { kind: "folderEnd", folderId }, intoEl: best, springFolderId: folderId, color };
		}

		const item = this.ribbon.items.find((i) => i.buttonEl === best);
		if (!item) return null;
		const place = y > r.top + r.height / 2 ? "after" : "before";
		const layout = this.plugin.layout;
		const folderId = layout ? folderOf(layout, item.id)?.id : undefined;
		return {
			kind: "item",
			drop: { kind: place, targetId: item.id },
			line: lineUnder(r, place),
			color: folderId ? this.colorOf(folderId) : "var(--interactive-accent)",
		};
	}

	private findFolderTarget(y: number): Target | null {
		const blocks: { key: string; rect: Rect }[] = [];
		for (const el of Array.from(this.ribbon.ribbonItemsEl.children) as HTMLElement[]) {
			if (!el.isShown()) continue;
			const r = el.getBoundingClientRect();
			const key = el.hasClass("rd-folder") ? el.dataset.folderId! : UNGROUPED_KEY;
			const button = el.hasClass("rd-folder") ? el.querySelector(".rd-folder-button")!.getBoundingClientRect() : r;
			const last = blocks[blocks.length - 1];
			if (key === UNGROUPED_KEY && last?.key === UNGROUPED_KEY) last.rect.bottom = r.bottom;
			else blocks.push({ key, rect: { top: r.top, bottom: r.bottom, left: button.left, width: button.width } });
		}
		let best: (typeof blocks)[number] | null = null;
		let bestDistance = Infinity;
		for (const b of blocks) {
			const distance = y < b.rect.top ? b.rect.top - y : y > b.rect.bottom ? y - b.rect.bottom : 0;
			if (distance < bestDistance) {
				best = b;
				bestDistance = distance;
			}
		}
		if (!best) return null;
		const place = y > (best.rect.top + best.rect.bottom) / 2 ? "after" : "before";
		return {
			kind: "folder",
			drop: { kind: place, targetKey: best.key },
			line: lineUnder(best.rect, place),
			color: this.colorOf(this.payload.id),
		};
	}

	private folderAt(target: Target): string | undefined {
		if (target.kind !== "item") return undefined;
		const { drop } = target;
		if (!("targetId" in drop)) return drop.folderId;
		return this.plugin.layout ? folderOf(this.plugin.layout, drop.targetId)?.id : undefined;
	}

	private colorOf(folderId: string): string {
		const folder = this.plugin.layout ? findFolder(this.plugin.layout, folderId) : undefined;
		return folder?.color ?? "var(--icon-color)";
	}

	private setTarget(target: Target | null): void {
		this.target = target;
		this.markedEl?.removeClass("rd-drop-into");
		this.markedEl = null;
		const line = this.lineEl;
		if (target?.kind === "item" && target.intoEl) {
			target.intoEl.addClass("rd-drop-into");
			target.intoEl.setCssProps({ "--rd-drop-color": target.color });
			this.markedEl = target.intoEl;
			line?.hide();
		} else if (target?.line && line) {
			line.setCssStyles({
				transform: `translate3d(${target.line.left}px, ${target.line.y}px, 0)`,
				width: `${target.line.width}px`,
				backgroundColor: target.color,
			});
			line.show();
		} else {
			line?.hide();
		}
		this.scheduleSpring(target?.kind === "item" ? (target.springFolderId ?? null) : null);
	}

	private scheduleSpring(folderId: string | null): void {
		if (folderId === this.pendingSpring) return;
		if (this.springTimer !== null) this.win.clearTimeout(this.springTimer);
		this.springTimer = null;
		this.pendingSpring = folderId;
		if (!folderId) return;
		this.springTimer = this.win.setTimeout(() => {
			this.springTimer = null;
			this.pendingSpring = null;
			let layout = this.plugin.layout;
			if (!layout) return;
			layout = this.closeSpringOpened(layout, undefined);
			layout = updateFolder(layout, folderId, { open: true });
			this.springOpened.add(folderId);
			this.plugin.commitLayout(layout, { refreshSettings: false });
			this.aim();
		}, SPRING_OPEN_DELAY);
	}

	private closeSpringOpened(layout: RibbonLayout, keep: string | undefined): RibbonLayout {
		for (const id of this.springOpened) {
			if (id !== keep) layout = updateFolder(layout, id, { open: false });
		}
		this.springOpened.clear();
		return layout;
	}
}
