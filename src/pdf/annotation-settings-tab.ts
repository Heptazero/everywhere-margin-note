import { App, PluginSettingTab, Setting, type Plugin } from "obsidian";
import {
	DEFAULT_PDF_ANNOTATION_SETTINGS,
	HIGHLIGHT_MODE_LABELS,
	parsePalette,
	type HighlightMode,
	type PdfAnnotationSettings,
} from "./annotation-settings";
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

		new Setting(containerEl).setName("高亮").setHeading();

		containerEl.createEl("p", {
			cls: "setting-item-description",
			text:
				"高亮指的是批注在原文上对应的那一段文字/区域。高亮的颜色跟随批注自己的颜色," +
				"所以同一页上有多条批注时,一眼就能看出哪条对应哪段。",
		});

		new Setting(containerEl)
			.setName("显示方式")
			.setDesc("也可以用命令面板里的「切换高亮显示方式」随时改。")
			.addDropdown((d) => {
				for (const [value, label] of Object.entries(HIGHLIGHT_MODE_LABELS)) d.addOption(value, label);
				d.setValue(settings.highlightMode).onChange((v) => {
					settings.highlightMode = v as HighlightMode;
					commit();
				});
			});

		new Setting(containerEl)
			.setName("高亮不透明度(%)")
			.setDesc("只影响原文上的色块和指示线,不影响批注本身的不透明度。")
			.addSlider((s) =>
				s
					.setLimits(5, 100, 1)
					.setValue(settings.highlightOpacity)
					.setDynamicTooltip()
					.onChange((v) => {
						settings.highlightOpacity = v;
						commit();
					})
			);

		new Setting(containerEl)
			.setName("可选颜色")
			.setDesc(
				"给单条批注改颜色时可选的预设色,用空格或逗号分隔的 #RRGGBB。" +
					"改颜色走的是这组预设,不再弹系统取色盘(那个面板总是跑到窗口角落)。"
			)
			.addTextArea((t) => {
				t.inputEl.rows = 2;
				t.inputEl.style.width = "100%";
				t.setValue(settings.palette.join(" ")).onChange((v) => {
					const parsed = parsePalette(v);
					// Ignore an unparseable/empty entry rather than saving a palette
					// with nothing in it — that would leave the picker with no colours
					// and no way back except editing the JSON.
					if (parsed.length === 0) return;
					settings.palette = parsed;
					commit();
					renderPreview();
				});
			});

		const preview = containerEl.createDiv({ cls: "margin-notes-pdf-palette-preview" });
		const renderPreview = () => {
			preview.empty();
			for (const c of settings.palette) {
				preview.createDiv({ cls: "margin-notes-pdf-swatch-dot" }).style.background = c;
			}
		};
		renderPreview();

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
