import { App, PluginSettingTab, Setting, type Plugin } from "obsidian";
import { DEFAULT_PDF_ANNOTATION_SETTINGS, type PdfAnnotationSettings } from "./annotation-settings";
import { resolveDataFilePath } from "./annotation-store";
import type { PdfAnnotationsController } from "./controller";

export class PdfAnnotationSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		plugin: Plugin,
		private controller: PdfAnnotationsController
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		const settings: PdfAnnotationSettings = { ...this.controller.settings };
		const commit = () => void this.controller.saveSettings(settings);

		containerEl.createEl("h3", { text: "批注数据" });

		const pathSetting = new Setting(containerEl)
			.setName("批注存放位置")
			.setDesc(
				"库内相对路径。填文件夹就在里面放 annotations.json,填以 .json 结尾的路径就用这个文件。" +
					"放在库里(而不是插件目录)才能跟着 git / Obsidian Sync / iCloud 同步——本库的 .gitignore 排除了整个 .obsidian/plugins/。"
			)
			.addText((t) =>
				t
					.setPlaceholder(DEFAULT_PDF_ANNOTATION_SETTINGS.dataPath)
					.setValue(settings.dataPath)
					.onChange((v) => {
						const next = v.trim();
						if (!next) return;
						settings.dataPath = next;
						commit();
						resolved.setText(`实际文件:${resolveDataFilePath(next)}`);
					})
			);
		const resolved = pathSetting.descEl.createDiv({ cls: "setting-item-description" });
		resolved.setText(`实际文件:${this.controller.store.filePath}`);

		containerEl.createEl("h3", { text: "外观" });

		new Setting(containerEl)
			.setName("轨道宽度(px)")
			.setDesc("固定到侧边轨道的批注共用这个宽度。也可以直接拖批注框朝向页面那一侧的边来改。")
			.addSlider((s) =>
				s
					.setLimits(110, 400, 10)
					.setValue(settings.railWidth)
					.setDynamicTooltip()
					.onChange((v) => {
						settings.railWidth = v;
						commit();
					})
			);

		new Setting(containerEl)
			.setName("基准字号(px)")
			.setDesc("轨道批注固定用这个字号;自由摆放的便利贴以此为基准跟着 PDF 缩放。单条批注可以右键单独调。")
			.addSlider((s) =>
				s
					.setLimits(9, 20, 1)
					.setValue(settings.fontSize)
					.setDynamicTooltip()
					.onChange((v) => {
						settings.fontSize = v;
						commit();
					})
			);

		new Setting(containerEl)
			.setName("不透明度(%)")
			.setDesc("鼠标悬停或编辑时始终不透明。")
			.addSlider((s) =>
				s
					.setLimits(30, 100, 1)
					.setValue(settings.opacity)
					.setDynamicTooltip()
					.onChange((v) => {
						settings.opacity = v;
						commit();
					})
			);

		new Setting(containerEl).setName("轨道批注颜色").addColorPicker((c) =>
			c.setValue(settings.railColor).onChange((v) => {
				settings.railColor = v;
				commit();
			})
		);

		new Setting(containerEl).setName("自由批注颜色").addColorPicker((c) =>
			c.setValue(settings.freeColor).onChange((v) => {
				settings.freeColor = v;
				commit();
			})
		);
	}
}
