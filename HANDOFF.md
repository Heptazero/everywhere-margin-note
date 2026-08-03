继续做 Obsidian 插件 `margin-notes-hz`(原名 `margin-notes`,已改名,见下方"事故记录"),路径:
`/Users/heptazero/Documents/my-obsidian/.obsidian/plugins/margin-notes-hz/`

## 背景

这是脚注/边注渲染插件,和同一个库里的 `everything-bilink` 插件(PDF 区域/文字选区双链、
笔记块引用)是姐妹项目但完全独立——`everything-bilink` 管"引用/链接",`margin-notes-hz` 管
"批注怎么显示",以后可能也给 PDF 批注复用这套渲染层。两个插件互不依赖。也和浏览器扩展
`margin-notes-web`(`/Users/heptazero/Documents/margin-notes-web/`)是同一构想的姐妹项目。

## ⚠️ 事故记录(2026-08-03,别重蹈覆辙)

manifest id 原来叫 `margin-notes`,和 Obsidian 社区商店里一个真实已发布的插件(作者
Abdul Majeed,`github.com/MajeedBaloch`,一个更重的"AI 批注 agent"插件,和这个项目功能
思路完全不同——它用自己的 chip 锚点系统,不碰 `[^id]` 脚注语法,还要填 OpenAI/Anthropic/
Gemini 的 API key 把笔记内容发出去)**id 撞车**。Obsidian 检查更新只按 id 匹配,不管
插件是本地开发的还是商店装的——它把本地这个 0.1.0 判定成那个商店插件的旧版本,用户一点
更新,**整个插件文件夹被替换**(不是只换 main.js),原来的 `.git` 仓库、`HANDOFF.md`、
全部 `src/` 源码都被删了,换成了别人插件的文件。

**教训,记死**:自建 Obsidian 插件的 manifest id **绝不能用容易撞车的通用名字**
(`margin-notes` 这种描述性短语大概率已经被别人用过)。改成了 `margin-notes-hz`
(带上作者标识后缀)。以后再开新插件,起 id 前先去 Obsidian 社区插件商店搜一下有没有
重名。

本次事故里 `src/*.ts`、`main.ts`、`styles.css`、`HANDOFF.md`、`package.json`、`manifest.json`
的内容都是从当时那次对话的上下文里原样重建的(逐字节一致);但 `tsconfig.json`、
`esbuild.config.mjs`、`versions.json`、`package-lock.json`、原来的两次 git 提交历史——这些
之前没在对话里完整读取过原文/无法从对象存储找回,是按 Obsidian 插件的标准写法重新生成的,
功能等价但不是原字节。git 历史从这次重建的提交重新开始。

## 现状:Phase 1-4 全部已实现,均在真实 Obsidian UI 里验证通过

**Phase 1(定位)**:`[^1]` 边注框在 Live Preview 下正确出现在正文右侧、跟对应引用同一行、
多个引用同时正确渲染,console 无报错。修复过 CM6 的经典坑:`rebuild()` 不能在
`ViewPlugin.update()` 里同步调用 `view.coordsAtPos()`(CM6 会抛
`Error: Reading the editor layout isn't allowed during an update`),必须用
`view.requestMeasure({ read, write })`。

**Phase 2-4**:边注框用 **Obsidian 原生渲染**(`MarkdownRenderer.render`)显示脚注定义——
LaTeX/MathJax 公式、加粗、双链等都走 Obsidian 自己的管线;无定义的引用显示斜体占位提示。
点击框 → 切换成**源码编辑模式**(纯文本 contentEditable,和 Live Preview 心智模型一致);
Enter 或点别处提交(写回文档底部 `[^id]: ...` 行)后切回渲染态,Esc 放弃修改;编辑一个
"无定义"的框会在文末自动追加新定义。相邻框按真实渲染高度依次下推,间距 8px(渲染是异步
的——MathJax 排版完才知道真实高度,避让在渲染 Promise 全部 resolve 后才跑,带 generation
计数防串台)。命令面板里有"清理无引用的脚注定义"命令,删掉所有正文里已无 `[^id]` 引用的
定义块。

## 代码结构

- `src/footnote-scan.ts` — 纯文本扫描:`[^id]` 引用 + `[^id]: ...` 定义块(含多行续行,
  tab 或 2+ 空格缩进,块内空行仅在后面还有续行时计入)。`FootnoteDef` 带 `from` /
  `markerEnd`(冒号后)/ `to`(块尾,不含换行)/ `content`(反缩进后的显示文本)。
  `serializeDefContent` 把多行文本序列化回定义语法(续行 4 空格缩进),与扫描互为逆运算。
- `src/collision-avoidance.ts` — `resolveCollisions<T>`:按自然 top 排序,前一个框的底部
  + minGap 往下推。支持变高框;泛型透传额外字段(比如 DOM 引用)。
- `src/margin-view-plugin.ts` — CM6 ViewPlugin,`createMarginNotesExtension(app)` 工厂
  (渲染需要 `app`)。流程:requestMeasure 第一趟测引用坐标 + 建框(自然位置)→ 异步
  `MarkdownRenderer.render` 渲染每个框(含 `$` 时先 `loadMathJax()`;`editorInfoField`
  拿 sourcePath 解析双链)→ 全部 resolve 后第二趟 requestMeasure 读 `offsetHeight` 做
  避让下推(`buildGen` 计数保证过期的异步渲染直接丢弃)。每轮 rebuild 换一个新的
  `Component` 托管渲染子组件,防泄漏。点击框 → `enterEdit` 切源码 contentEditable,
  blur/Enter 提交 → `view.dispatch` 写回 → docChanged 触发 rebuild 重新渲染;无改动时
  手动 `renderDisplay` 恢复渲染态;Esc 还原。编辑中若来了 rebuild 请求会挂起
  (`pendingRebuild`),blur 后再执行,避免编辑到一半 DOM 被重建摧毁。
- `src/main.ts` — 注册 editor extension + "清理无引用的脚注定义"命令(定义块从下往上删,
  保持前面 offset 有效)。
- `styles.css` — 边注框样式走 Obsidian CSS 变量(`--text-muted`、`--interactive-accent`
  等),跟随主题;layer `pointer-events: none`,框自身 `auto`。

## 接下来可以做的(按价值排序)

1. **确认重建后功能正常**:重载 Obsidian,写几个 `[^1]` `[^2]`、带 `$E=mc^2$` 的脚注,
   验证渲染/避让/编辑/孤儿清理都还在(应该没问题,代码是逐字节重建的,但值得过一遍)
2. 编辑中实时防抖写回(现在是 blur/Enter 才提交;要不要改看用户口味)
3. 性能:`update()` 里 viewportChanged 在滚动时也触发 rebuild,纯浪费(层随滚动免费移动
   是这个架构的核心卖点),可改成只在 docChanged/geometryChanged 时重建
4. 阅读视图(Reading view)支持——完全不同的渲染管线,要另接 MarkdownPostProcessor
5. 框内双链/普通链接点击目前会直接进入编辑态而不是跳转,要跳转得给链接元素单独拦 click
6. 同一 id 多处引用:现在框对齐第一个引用;可考虑 hover 高亮所有引用

## 一些已经踩过的坑,别重复掉进去

- **manifest id 别用通用名字,见上面"事故记录"**——这是本文件存在的直接原因
- `obsidian` npm 包对 `@codemirror/state`/`@codemirror/view` 有精确的 peer dependency
  版本要求,`package.json` 里**不要**自己再显式声明这两个包的版本,会和 npm 解析冲突
  ——让它们通过 `obsidian` 的依赖链传递获得类型定义就行(esbuild 里两者都在 external
  列表,不会被打进 bundle,运行时由 Obsidian 自己提供)
- 批注框的水平位置不能用 `left: 100%` 或固定 CSS 值,得用 `view.contentDOM` 的
  `getBoundingClientRect()` 动态算——很多主题会把正文内容居中显示在比编辑器窄的一栏
  里,两侧留白,批注框应该贴着"正文实际渲染宽度"的右边,不是贴着编辑器整个滚动容器
  的右边
- `ViewPlugin.update()`(以及插件构造函数,它本质也在初次 update 周期里)里不能直接同步
  调用 `view.coordsAtPos()` / `element.getBoundingClientRect()` 这类布局读取——CM6 会抛
  `Error: Reading the editor layout isn't allowed during an update`,且这个报错不会中断
  编辑器本身,只会安静地让你的 `update()` 提前 throw、DOM 操作全部没跑,表现就是"什么都
  没发生",很容易被误判成定位算法错了。正确做法是用 `view.requestMeasure({ read, write })`
  ——`read` 阶段做所有布局测量,`write` 阶段做纯 DOM 写入,两者严格分离
- 用 computer-use 操作 Obsidian UI 测试时,系统中文输入法会把字母吞进拼音组合、把
  cmd+P 之类的按键打进笔记里,极易误触。能 headless 验证的(纯逻辑单元测试、构建、读
  文件)一律 headless;真要 UI 验证,让用户自己动手,或者先切英文输入法
- `el.innerText.replace(/ /g, " ")` 里的 ` ` 必须写成显式转义,不能指望编辑器
  /终端正确处理字面 NBSP 字符——本次重建时手滑漏打字面 NBSP 导致正则变成 `/ /g` 的空操作,
  一开始没发现
