export interface ItemRef {
	id: string;
	hidden: boolean;
	title: string;
	icon: string;
}

export interface RibbonFolder {
	kind: "folder";
	id: string;
	name: string;
	color: string | null;
	hidden: boolean;
	open: boolean;
	collapsed: boolean;
	items: ItemRef[];
}

export interface UngroupedSection {
	kind: "ungrouped";
	collapsed: boolean;
	items: ItemRef[];
}

export type Section = RibbonFolder | UngroupedSection;

export interface RibbonLayout {
	sections: Section[];
}

export interface LiveItem {
	id: string;
	title: string;
	icon: string;
	hidden: boolean;
}

export const DEFAULT_FOLDER_NAME = "New folder";

export function pluginOf(itemId: string): string {
	const i = itemId.indexOf(":");
	return i === -1 ? itemId : itemId.slice(0, i);
}

export function seedLayout(live: LiveItem[]): RibbonLayout {
	return {
		sections: [
			{
				kind: "ungrouped",
				collapsed: false,
				items: live.map((l) => ({ id: l.id, title: l.title, icon: l.icon, hidden: l.hidden })),
			},
		],
	};
}

export function cloneLayout(layout: RibbonLayout): RibbonLayout {
	return structuredClone(layout);
}

export function getUngrouped(layout: RibbonLayout): UngroupedSection {
	const u = layout.sections.find((s): s is UngroupedSection => s.kind === "ungrouped");
	if (!u) throw new Error("Ribbon Layout has no Ungrouped section");
	return u;
}

export function allRefs(layout: RibbonLayout): ItemRef[] {
	return layout.sections.flatMap((s) => s.items);
}

export function reconcile(input: RibbonLayout, live: LiveItem[]): { layout: RibbonLayout; changed: boolean } {
	const layout = cloneLayout(input);
	let changed = false;

	const ungroupedSections = layout.sections.filter((s) => s.kind === "ungrouped");
	if (ungroupedSections.length === 0) {
		layout.sections.push({ kind: "ungrouped", collapsed: false, items: [] });
		changed = true;
	} else if (ungroupedSections.length > 1) {
		const [keep, ...extra] = ungroupedSections;
		for (const s of extra) keep.items.push(...s.items);
		layout.sections = layout.sections.filter((s) => !(extra as Section[]).includes(s));
		changed = true;
	}

	const seen = new Set<string>();
	for (const s of layout.sections) {
		const before = s.items.length;
		s.items = s.items.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
		if (s.items.length !== before) changed = true;
	}

	const liveById = new Map(live.map((l) => [l.id, l]));

	for (const ref of allRefs(layout)) {
		const l = liveById.get(ref.id);
		if (l && (l.title !== ref.title || l.icon !== ref.icon)) {
			ref.title = l.title;
			ref.icon = l.icon;
			changed = true;
		}
	}

	const newcomers = live.filter((l) => !seen.has(l.id));
	if (newcomers.length === 0) return { layout, changed };

	const unavailable = allRefs(layout).filter((r) => !liveById.has(r.id));
	const matches = (ref: ItemRef, l: LiveItem) => pluginOf(ref.id) === pluginOf(l.id) && ref.icon === l.icon;
	const ungrouped = getUngrouped(layout);
	for (const l of newcomers) {
		const candidates = unavailable.filter((r) => matches(r, l));
		const ref = candidates.length === 1 ? candidates[0] : null;
		if (ref && newcomers.filter((n) => matches(ref, n)).length === 1) {
			ref.id = l.id;
			ref.title = l.title;
			unavailable.splice(unavailable.indexOf(ref), 1);
		} else {
			ungrouped.items.push({ id: l.id, title: l.title, icon: l.icon, hidden: false });
		}
	}
	return { layout, changed: true };
}

export function flatten(layout: RibbonLayout): { id: string; hidden: boolean }[] {
	return layout.sections.flatMap((s) =>
		s.items.map((r) => ({ id: r.id, hidden: r.hidden || (s.kind === "folder" && s.hidden) })),
	);
}

export type RibbonBlock = { kind: "loose"; ids: string[] } | { kind: "folder"; folder: RibbonFolder; ids: string[] };

export function ribbonBlocks(layout: RibbonLayout, liveIds: ReadonlySet<string>): RibbonBlock[] {
	const blocks: RibbonBlock[] = [];
	for (const s of layout.sections) {
		const ids = s.items.filter((r) => !r.hidden && liveIds.has(r.id)).map((r) => r.id);
		if (s.kind === "ungrouped") {
			if (ids.length > 0) blocks.push({ kind: "loose", ids });
		} else if (!s.hidden && ids.length > 0) {
			blocks.push({ kind: "folder", folder: s, ids });
		}
	}
	return blocks;
}

export function addFolder(input: RibbonLayout, id: string): RibbonLayout {
	const layout = cloneLayout(input);
	layout.sections.push({
		kind: "folder",
		id,
		name: DEFAULT_FOLDER_NAME,
		color: null,
		hidden: false,
		open: false,
		collapsed: false,
		items: [],
	});
	return layout;
}

export function deleteFolder(input: RibbonLayout, folderId: string): RibbonLayout {
	const layout = cloneLayout(input);
	const folder = findFolder(layout, folderId);
	if (!folder) return layout;
	getUngrouped(layout).items.push(...folder.items);
	layout.sections = layout.sections.filter((s) => s !== folder);
	return layout;
}

export function findFolder(layout: RibbonLayout, folderId: string): RibbonFolder | undefined {
	return layout.sections.find((s): s is RibbonFolder => s.kind === "folder" && s.id === folderId);
}

export function updateFolder(
	input: RibbonLayout,
	folderId: string,
	patch: Partial<Omit<RibbonFolder, "kind" | "id" | "items">>,
): RibbonLayout {
	const layout = cloneLayout(input);
	const folder = findFolder(layout, folderId);
	if (folder) {
		Object.assign(folder, patch);
		if (!folder.name.trim()) folder.name = DEFAULT_FOLDER_NAME;
	}
	return layout;
}

export function moveSection(input: RibbonLayout, fromIndex: number, toIndex: number): RibbonLayout {
	const layout = cloneLayout(input);
	const [s] = layout.sections.splice(fromIndex, 1);
	if (!s) return input;
	layout.sections.splice(Math.max(0, Math.min(toIndex, layout.sections.length)), 0, s);
	return layout;
}

export function moveItem(input: RibbonLayout, itemId: string, toSection: number, toIndex: number): RibbonLayout {
	const layout = cloneLayout(input);
	const target = layout.sections[toSection];
	if (!target) return input;
	for (const s of layout.sections) {
		const i = s.items.findIndex((r) => r.id === itemId);
		if (i === -1) continue;
		const [ref] = s.items.splice(i, 1);
		if (s === target && i < toIndex) toIndex--;
		target.items.splice(Math.max(0, Math.min(toIndex, target.items.length)), 0, ref);
		return layout;
	}
	return input;
}

export type ItemDrop =
	{ kind: "before" | "after"; targetId: string } | { kind: "folderStart" | "folderEnd"; folderId: string };

export function dropItem(input: RibbonLayout, itemId: string, drop: ItemDrop): RibbonLayout {
	if (!("targetId" in drop)) {
		const index = input.sections.findIndex((s) => s.kind === "folder" && s.id === drop.folderId);
		if (index === -1) return input;
		return moveItem(input, itemId, index, drop.kind === "folderStart" ? 0 : input.sections[index].items.length);
	}
	const { targetId } = drop;
	if (targetId === itemId) return input;
	for (const [index, s] of input.sections.entries()) {
		const at = s.items.findIndex((r) => r.id === targetId);
		if (at !== -1) return moveItem(input, itemId, index, at + (drop.kind === "after" ? 1 : 0));
	}
	return input;
}

export const UNGROUPED_KEY = "ungrouped";

export function sectionKey(s: Section): string {
	return s.kind === "folder" ? s.id : UNGROUPED_KEY;
}

export interface FolderDrop {
	kind: "before" | "after";
	targetKey: string;
}

export function dropFolder(input: RibbonLayout, folderId: string, drop: FolderDrop): RibbonLayout {
	const from = input.sections.findIndex((s) => s.kind === "folder" && s.id === folderId);
	const at = input.sections.findIndex((s) => sectionKey(s) === drop.targetKey);
	if (from === -1 || at === -1 || from === at) return input;
	let to = at + (drop.kind === "after" ? 1 : 0);
	if (from < to) to--;
	return to === from ? input : moveSection(input, from, to);
}

export function folderOf(layout: RibbonLayout, itemId: string): RibbonFolder | undefined {
	return layout.sections.find((s): s is RibbonFolder => s.kind === "folder" && s.items.some((r) => r.id === itemId));
}

export function setItemHidden(input: RibbonLayout, itemId: string, hidden: boolean): RibbonLayout {
	const layout = cloneLayout(input);
	const ref = allRefs(layout).find((r) => r.id === itemId);
	if (ref) ref.hidden = hidden;
	return layout;
}

export function setSectionItemsHidden(input: RibbonLayout, sectionIndex: number, hidden: boolean): RibbonLayout {
	const layout = cloneLayout(input);
	for (const r of layout.sections[sectionIndex]?.items ?? []) r.hidden = hidden;
	return layout;
}

export function setSectionCollapsed(input: RibbonLayout, sectionIndex: number, collapsed: boolean): RibbonLayout {
	const layout = cloneLayout(input);
	const s = layout.sections[sectionIndex];
	if (s) s.collapsed = collapsed;
	return layout;
}

export function removeItem(input: RibbonLayout, itemId: string): RibbonLayout {
	const layout = cloneLayout(input);
	for (const s of layout.sections) s.items = s.items.filter((r) => r.id !== itemId);
	return layout;
}
