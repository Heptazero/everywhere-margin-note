import type { Plugin } from "obsidian";

/**
 * Read-modify-write of `data.json`. Multiple independent owners (settings,
 * annotation store) live in the same file under disjoint keys; each must
 * merge onto whatever's on disk instead of writing its own slice wholesale,
 * or saving one would wipe the other. Mirrors everything-bilink/src/settings.ts.
 */
export async function patchPluginData(plugin: Plugin, patch: Record<string, unknown>): Promise<void> {
	const existing = ((await plugin.loadData()) as Record<string, unknown> | null) ?? {};
	await plugin.saveData({ ...existing, ...patch });
}
