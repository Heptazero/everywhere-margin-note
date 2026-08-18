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

		containerEl.createEl("p", {
			cls: "setting-item-description",
			text:
				"「固定」的批注不是自己记住位置,而是排在页面左右两条轨道里——所以轨道的宽度和" +
				"离页面的距离是这一条轨道自己的设置,左右两侧互不影响。单位都是 PDF 点" +
				"(100% 缩放时的像素),会跟着页面一起缩放,不会因为你放大缩小而变形。",
		});

		new Setting(containerEl).setName("左侧轨道").setHeading();

		new Setting(containerEl)
			.setName("轨道宽度")
			.setDesc("左侧所有固定批注的宽度。也可以直接拖批注框远离页面那一侧的边。")
			.addSlider((s) =>
				s
					.setLimits(50, 500, 5)
					.setValue(settings.railWidthLeft)
					.setDynamicTooltip()
					.onChange((v) => {
						settings.railWidthLeft = v;
						commit();
					})
			);

		new Setting(containerEl)
			.setName("轨道离页面的距离")
			.setDesc("负数会把轨道压到页面上。也可以直接拖批注框朝向页面那一侧的边。")
			.addSlider((s) =>
				s
					.setLimits(-200, 300, 5)
					.setValue(settings.railGapLeft)
					.setDynamicTooltip()
					.onChange((v) => {
						settings.railGapLeft = v;
						commit();
					})
			);

		new Setting(containerEl).setName("右侧轨道").setHeading();

		new Setting(containerEl)
			.setName("轨道宽度")
			.setDesc("右侧所有固定批注的宽度。也可以直接拖批注框远离页面那一侧的边。")
			.addSlider((s) =>
				s
					.setLimits(50, 500, 5)
					.setValue(settings.railWidthRight)
					.setDynamicTooltip()
					.onChange((v) => {
						settings.railWidthRight = v;
						commit();
					})
			);

		new Setting(containerEl)
			.setName("轨道离页面的距离")
			.setDesc("负数会把轨道压到页面上。也可以直接拖批注框朝向页面那一侧的边。")
			.addSlider((s) =>
				s
					.setLimits(-200, 300, 5)
					.setValue(settings.railGapRight)
					.setDynamicTooltip()
					.onChange((v) => {
						settings.railGapRight = v;
						commit();
					})
			);

		new Setting(containerEl)
			.setName("基准字号(px)")
			.setDesc("100% 缩放时的字号,所有批注都以此为基准跟着 PDF 一起缩放。单条批注可以用它自己的菜单再单独调。")
			.addSlider((s) =>
				s
					.setLimits(6, 28, 1)
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
