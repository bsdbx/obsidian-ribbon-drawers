import { setIcon } from "obsidian";

export function renderFolderIcon(el: HTMLElement, open: boolean): void {
	el.empty();
	setIcon(el, open ? "lucide-folder-open" : "lucide-folder");
}
