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

## Phase 5:PDF 便利贴批注,2026-08-16(v0.4.0)

在 Phase 1-4 的脚注边注渲染之外,新增一套独立功能:在 PDF 上写批注,不经过笔记文件、
不走 wikilink 反链系统,是"锚定在某页某处的一张本地便利贴"。和脚注渲染共用
`src/collision-avoidance.ts`。

### 核心模型:一种东西,两个正交开关

早期版本用 `kind: "floating" | "margin"` 区分两种批注,**这是个设计错误**——它把两个
互相独立的维度硬捆在一起,导致"悬浮的永远是点、侧边的永远是展开"。v0.4.0 拆成:

|            | `collapsed: false` | `collapsed: true` |
|------------|--------------------|-------------------|
| `pinned: true`  | 侧边轨道里的框 | 轨道里的一个点 |
| `pinned: false` | 自由摆放的便利贴 | 页面上的一个点 |

四格都有意义,随时可以互相切换(框上的工具条 / 右键菜单)。`normalizeAnnotation()`
负责把旧记录升级:`floating` → free+collapsed,`margin` → rail+expanded。

### 数据存哪里

库内一个 JSON 文件,路径可在设置里改,默认 `.margin-notes-hz/`。
**不放插件自己的 `data.json`**:本库 `.gitignore` 排除了整个 `/.obsidian/plugins/`,
放那儿的批注不会进 git;Obsidian Sync 也把插件数据当成要单独勾选的类别。

**踩过的坑**:路径设置最初只当文件路径处理,用户照着旁边 `branch-timeline` 的样子填了
`99_assets/plugin-data/margin-note`(明显是想要文件夹),结果那里被建成空目录、批注根本
没写进去,还留在旧位置。现在 `resolveDataFilePath()` 会判断:以 `.json` 结尾当文件,
否则当文件夹、在里面放 `annotations.json`。设置页会实时显示"实际文件:<路径>"。

```ts
interface PdfAnnotation {
	id: string; page: number;
	anchor: PdfRect;              // 指向哪 —— PDF point,来自选区/框选
	pinned: boolean;              // 在轨道里 or 自由摆放
	collapsed: boolean;           // 收成点 or 展开
	side: "left" | "right";       // 哪条轨道
	freeX?, freeY?, freeW?, freeH?;  // 自由摆放:页面百分比(可为负/超 100 = 页面外)
	offsetY?: number;             // 轨道:手动上下微调(px)
	fontScale?: number;           // 单条字号倍率
	text: string;                 // Markdown 源码
	createdAt, updatedAt: number;
}
```

**为什么自由坐标用百分比而不是像素**:百分比是相对页面框的,缩放时便利贴自动跟着页面走,
不会跑飞;而且允许 <0 或 >100,天然表达"贴在页面左右外面的空白里"。
**为什么 `offsetY` 和 `anchor` 分开**:`anchor` 永远表示"指着原文哪里",`offsetY` 表示
"用户想让框显示在哪",混在一起的话以后做重新锚定/导出引用原文时锚点已被拖动污染。

### 定位:两条踩过的坑

**1. 轨道必须钉在可视区,不能钉在页面边。** 最初 `left = pageRight + GAP`,PDF 放大到
填满窗格时轨道就跑到视口外面,只能缩到很小才看得见。现在:
```
右轨道 left = min(页面右边 + GAP, 可视右边 - 轨道宽 - GAP)
左轨道 left = max(页面左边 - 轨道宽 - GAP, 可视左边 + GAP)
```
留白够就贴着页面(离正文近好读),不够就压到页面上,**永远可见**。

**2. 轨道批注固定 px,自由便利贴跟着缩放。** 轨道是 UI chrome,尺寸应该屏幕固定,否则
PDF 缩小时批注框会相对页面越来越大、喧宾夺主(用户原话:"无论我缩多小这个就跟着放大")。
自由便利贴是"贴在纸上的",宽高字号都随页面缩放。字号:轨道 = `fontSize`,
自由 = `fontSize × zoom`,各自再乘 `fontScale`。

**3. 只有一个层,不再分两层。** 早期悬浮批注画在 `getOverlayLayer()` 的页内覆盖层里,
那层 `overflow: hidden`,导致便利贴一旦放到页面外就被裁掉——这正好挡死了"放在左右空白处"
这个核心需求。现在所有批注(包括点)都画在滚动容器下的**同一个层**里,位置由页面
`getBoundingClientRect()` 换算,`overflow` 不再裁任何东西。页内覆盖层现在只剩框选时
画虚线框在用。

### 代码结构(`src/pdf/`)

- `pdfjs-types.ts` / `pdf-layer.ts` / `selection-geom.ts` / `rect-select.ts` ——
  **从 `everything-bilink/src/` 原样镜像**(不抽共享包,理由见文件头注释)。以后 Obsidian
  升级打断这条未公开内部链路,**两个插件都要改**。
- `annotation-types.ts` —— 数据模型 + `normalizeAnnotation()` 旧记录升级。
- `annotation-store.ts` —— 持久化、debounce 落盘、路径解析、PDF 改名跟随
  (`renameFile` 挂 `vault.on("rename")`;纯路径 key 否则文件一移动批注就悄悄丢)、
  多级迁移(新路径 → 旧默认文件夹 → 更旧的插件 data.json)。JSON 坏了**抛错不清空**。
- `annotation-anchor.ts` —— 文字选区 → 锚点矩形。是 `everything-bilink` 的
  `text-select-copy.ts::readActiveSelection` 简化版:只要几何不要文字,所以没有公式回填。
- `annotation-box.ts` —— 框壳。显示态走 `MarkdownRenderer.render`(LaTeX/双链/加粗全支持,
  和脚注框同一套管线);点击切源码 contentEditable,blur/Enter 提交、Esc 放弃。
  **渲染出的 `a.internal-link` 自己挂了 `openLinkText`**——Obsidian 只在它自己的视图里
  接管这类点击;点链接跳转、点别处进编辑,靠 `closest("a")` 区分。
- `annotation-layer.ts` —— 唯一的渲染层,前面那三条定位逻辑都在这。工具条:拖动柄 /
  切换左右轨道 / 钉住↔自由 / 收起成点 / 删除;右键菜单额外有字号增减、恢复自动高度。
  轨道批注的 resize 手柄拖的是**共享的轨道宽度**(存进设置),自由便利贴拖的是自己的宽高。
- `annotation-list-view.ts` —— 右侧栏面板,按页码+页面纵向位置列出全部批注(渲染 Markdown),
  点击跳到那页并闪烁。
- `controller.ts` —— 扫描 PDF 视图、每视图一份 `ViewState`、命令入口。**批注初始形态由
  调用的命令决定**(之后随时可改),不解析笔记语法猜。

### 命令 / 入口

- `[PDF] 加批注:右侧轨道` / `左侧轨道` / `自由摆放(便利贴)`
- `[PDF] 打开批注列表面板`(另有 ribbon 图标)

有选中文字就直接锚上去;没选中就提示拖一个框标出位置(这就是"框选",之前完全没提示,
用户反馈看不懂)。

### 验证状态

- **已验证(headless)**:store 层 15 个用例(路径解析文件/文件夹两种写法、旧
  `kind` 迁移、旧位置迁移、新字段往返、损坏文件抛错、upsert/remove/forPage、
  renameFile 合并、onChange 订阅);`npm run build` 干净。测试脚本在会话 scratchpad,未入库。
- **完全没验证**:所有交互——拖动、缩放、钉住/自由切换、收起展开、轨道宽度拖拽、
  字号右键调整、Markdown/LaTeX/双链渲染与跳转、列表跳转闪烁、
  `findScrollAncestor` 是否真找到 pdf.js 的滚动祖先。

### v0.4.1 修的几个 UI bug(用户实测反馈)

1. **字号没有入口** —— 只做在右键菜单里,没人找得到。现在工具条直接放了 A−/A+,
   外加一个 `⋯` 按钮打开同一个菜单(右键菜单保留)。按钮缩到 15px 才塞得下 7 个,
   `MIN_RAIL_WIDTH` 相应提到 130。
2. **右侧轨道的缩放手柄拖起来像在拖右边** —— 手柄位置本来就对(在朝向页面那一侧),
   但拖动时只改了 `width`、没改 `left`,而右轨道的 `left` 是固定的,于是框往右长,
   看着就像在拖另一边。现在被抓住的那条边跟着鼠标走(`grabsLeftEdge` 时同步改 `left`)。
3. **缩放后批注漂移(滚动不漂)** —— 两个原因叠加:pdf.js 缩放时会**每页**发一次
   `pagerendered`,每次都触发 rebuild,而那时其他页还没重新排版完,量到的是旧矩形;
   而且原来的实现在 `await` Markdown 渲染**之前**就把几何量好了,渲染完直接用旧数字定位。
   现在 rebuild 有 60ms 防抖合并这一串事件,并且拆成 `layout()` 独立函数,**渲染前后各
   跑一次**——第二次重新测量当前页面矩形。拖动结束时也改成现场重新量页面框,
   而不是用建框时捕获的那份。
4. **批注面板点了没反应、只显示"当前没有打开的 PDF"** —— 根因:面板一被点击就成了
   "活动视图",`getActivePDFView()` 当场返回 null。现在 controller 记住
   `lastPdfView`(还开着才算数),面板和跳转都用它;面板自身获得焦点时跳过重渲染。
   跳转也改成复用 PDF 已在的那个 leaf(`setState` 带 `#page=`),不再在侧边栏旁边
   另开一份。
5. 面板底部换成 `--background-primary` 并 `min-height: 100%`,不再露出侧边栏那层
   不同底色的色带。

### v0.5.0 —— 重新定义"固定",加颜色/纯文字样式,批注面板可编辑跳转(用户实测反馈)

**1. "固定"的语义反了,推翻重做。** 0.4.x 把"固定"实现成屏幕固定尺寸的 UI chrome
(不随 PDF 缩放变化)。用户纠正:这不是他们的原意——"固定"应该和便签("自由"那种)
一样贴在 PDF 上、随缩放等比例变化,唯一的区别只是**横向被限制在左右两条轨道里**,
不能随便摆。现在 `PageBox` 多存了 `ptX0/ptX1/ptWidth`,`settings.railWidth` 的语义
从"px"改成"PDF point(100% 缩放时的 px)",渲染时统一 `* box.zoom` 换算成当前
屏幕像素——轨道宽度、批注宽度、字号,固定和自由现在走同一套缩放公式,只有 X 坐标的
算法不同(轨道用 `railLeft()` 卡边,自由用 `freeX/freeY` 百分比)。拖轨道内边缘调宽度时
落盘前除以当前 zoom,换回"point"存,保证以后缩放时视觉宽度还是用户当时选的那个。

**2. 批注面板:分页折叠 + 面板内直接编辑/删除 + 跳转带高亮。**
`annotation-list-view.ts` 整个重写:
- 按页码分组,每组一个可折叠 header(点头部展开/收起,状态存在 view 实例上,
  面板关闭重开会重置——这是会话态,不值得落盘)。
- **每一行直接复用 `buildAnnotationBox`**(和页面上的批注同一个组件),而不是只读的
  `MarkdownRenderer.render`——所以面板里点正文能直接编辑,工具条上有跳转和删除两个
  按钮,不用打开 PDF 就能改/删批注。
- 跳转(`revealAnnotation` → `AnnotationLayer.reveal()`)除了闪一下批注框本身,
  现在还会在**原文锚点位置**画一个临时高亮矩形并 `scrollIntoView`——批注框自己在轨道里
  或者被拖到别处,并不代表那就是原文位置,用户要看到的是"这条批注指的到底是哪句话"。

**3. 颜色 + 纯文字样式,工具条压缩成一个"⋯"。**
`PdfAnnotation` 加了 `color?` 和 `style?: "boxed" | "plain"` 两个可选字段。
页面上批注框原来的工具条有 6 个图标(字号±、固定、收起、更多、删除)当场就把短批注的
文字糊住了——现在压缩成**只有拖动柄 + 一个"⋯"**,点开是同一个右键菜单(菜单本身没删减,
新增了"改成纯文字样式"和"更改颜色…"两项)。颜色用一个隐藏的原生
`<input type=color>` 触发系统取色器(和设置页 `addColorPicker` 背后是同一套机制),
选完立即生效、离开自动清理。纯文字样式去掉边框/背景/阴影,只剩带色文字,悬停或编辑时
临时露出一个底,方便点回去编辑。

### v0.5.1 —— 三个真 bug(用户实测反馈)

1. **批注面板点击跳转,静默失败。** `revealAnnotation` 对已经打开的 PDF leaf 调用了
   `view.setState({file, subpath}, ...)`——这是错的:`setState()` 是每种 View 自己的
   **持久化状态**格式,FileView 不认得 `{file, subpath}` 这个形状,调用直接是静默空操作。
   导航一个**已经打开**的文件到某个 subpath,正确 API 是 `View.setEphemeralState()`
   (`MarkdownView` 跳转到标题/块引用用的就是这个)。改用
   `existing.view.setEphemeralState({ subpath: "#page=N" })` 后修复。
2. **新建的自由便利贴默认出现在页面外面。** `freeXPct` 默认值原来写死 102%(页面右边缘
   往外一点点),不管选区在哪——页面在阅读器窗口里贴得紧、没什么留白的时候,这个位置
   经常落在可视区域外面,便利贴创建了但看不见。改成默认贴着**选区右边**
   (锚点右边缘 + 3%),不再存成固定值——因为只在 `freeX` 未设置时才用这个默认公式,
   每次渲染都重新按锚点算,不会像存死的 102% 那样"一直错在同一个地方"。
   `togglePin` 解除固定时也不再写死跳到 102%/-30% 的角落,同样交给这个默认公式,
   于是解除固定也会自然落在原来那条批注所在的位置附近。
3. **固定轨道拖宽度,拖一点就卡住。** 根因不在 resize 的算法本身,而在防抖:
   `rebuild()` 只在**调度**这次重建的那一刻检查了 `isBusy()`(是否有框正在编辑/拖拽),
   但 60ms 后真正执行的 `doRebuild()` 并不会再检查一遍——如果调度和执行之间用户开始拖动
   (很容易发生,比如拖拽引发的滚动会让 `onTextLayerReady` 再触发一次调度),
   `doRebuild()` 照样把整个层 `layer.empty()` 清空重建,用户手指下面那个 DOM 元素被换掉,
   但 `pointermove` 监听器还挂在 `window` 上继续触发,改的是一个已经不在文档里的旧元素
   ——看起来就是"拖一点就死了"。现在 `doRebuild()` 一开始、以及 Markdown 渲染
   `await` 结束后都会重新检查 `isBusy()`,忙碌就直接放弃这一轮(拖拽/编辑结束时的
   `refresh()` 会补上)。

### v0.5.2 —— 尺寸下限 + 两边都能拖(用户实测反馈)

1. **下限设得太大,而且 slider 和代码对不上。** `MIN_RAIL_WIDTH_PT` 是 130,而设置页
   slider 的最小值是 110 —— **slider 最下面那一段完全没作用**,拖到底也还是 130。
   现在:轨道 50pt(slider 50–500)、自由批注 40pt、字号 slider 6–28px、
   单条字号倍率 0.3–4x。下限只当"别塌成 0"的保险,不再替用户判断多窄算窄。
   **规矩:`MIN_*` 常量必须 ≤ 对应 slider 的最小值**,否则又会出现拖了没反应。
2. **只有一条边能拖,而且找不到。** 原来只在"朝向页面那一侧"放了一个手柄,而且定位是
   `left: -2px` —— 但批注框是 `overflow: hidden`,这个手柄有一部分直接被裁掉了,
   这是"不知道怎么拖"的直接原因。现在左右**两条边都有手柄**(自由批注另加右下角改高度),
   全部放在框内侧;鼠标悬停在批注上时手柄会显示一条淡色竖条,悬停在手柄上加深。
   抓哪条边哪条边跟着光标走(抓左边时同步改 `left`,否则看起来像在拖对面那条边);
   自由批注往左拉时会同时更新 `freeX`,保持右边缘不动。

### v0.6.0 —— 轨道定位彻底去掉滚动依赖(用户实测反馈)

**一个根因,三个症状。** `railLeft()` 原来是:
```
右轨道 = min(页面右边 + GAP, scrollLeft + clientWidth - 轨道宽 - GAP)
```
那个 `min(...)` 是为了"轨道永远在可视区内"加的,但它把**滚动状态**混进了定位公式,
于是同时坏了三件事:

1. **缩放时轨道漂移,自由便签不漂。** 用户自己就推理对了:"照理说这个跟自由便签
   是一样的逻辑啊"——对,自由便签只用页面几何,而轨道多依赖了 `scrollLeft`,
   缩放时滚动位置变了,轨道就跟着漂。
2. **轨道出不去 PDF 的范围。** 那个 clamp 的字面含义就是"不许超出当前视口",
   所以永远没法把批注放到页面右边更远的空白里。
3. **拖完轨道视野被拉到贴边 + 撞上滚动条。** 这是个自我喂食的回路:轨道撑大了
   滚动内容宽度 → `scrollLeft + clientWidth` 跟着右移 → 轨道又右移 → 视野被拖着走。
   而且它正好被摆在视口最右边,macOS 的覆盖式滚动条就在那个位置,一拖就碰上。

**改法**:`railLeft()` 变成**纯页面坐标**,和自由便签同一套逻辑——
`右 = 页面右边 + gap`、`左 = max(0, 页面左边 - 宽 - gap)`,gap 也按 point 存、乘 zoom。
唯一剩下的 clamp 是左轨道不许为负(内容原点左边滚不过去,会永远够不着)。
另外给图层设了显式 `width = 最右批注 + OUTER_MARGIN_PX(28)`,这样滚动容器能真的
滚到页面外的批注那里,而且最外侧批注右边留一段空白,不会贴着滚动条。

**代价说清楚**:放大到页面填满窗格时,轨道批注会在视口外面,要横向滚动才看得到。
这是用户明确要的取舍("固定不是屏幕视角,而是依附 pdf 的位置")——它现在真的就是
一张贴在纸上、只是横向对齐到某条泳道的便签。

**批注面板的按钮位置**:从右上角挪到**行右侧垂直居中**,悬停才显示(行又矮又宽,
角标读起来像是脱离了它所属的那一行)。右侧空位是**常驻**的,不在 hover 时才撑开
——否则鼠标一悬停正文就重排,手感很差。

### v0.6.1 —— 面板删除不同步 + 轨道只有一边能拖(用户实测反馈)

1. **在列表面板删除批注,PDF 上还在。** `store.onChange` 只有列表面板订阅了,
   `AnnotationLayer` 谁都没订阅——它只在 `pagerendered`/`textlayerrendered`/`resize`
   时重建。所以从面板删除/编辑,数据和面板都更新了,页面上那条纹丝不动,要等下次
   翻页重渲染才消失。现在 controller 在 `onload()` 里统一订阅一次
   `store.onChange → rebuildAll()`。图层重建本来就有 60ms 防抖、且拖拽/编辑中会跳过,
   所以多出来的这点触发是无害的。

2. **轨道只有一条边能拖,另一条"拖不动、只让对面变长"。** 这不是手柄坏了,是
   **几何上就不可能**——轨道批注的位置是**算出来的**(`railLeft()` = 页面边 + gap),
   不是存下来的,所以朝向页面那条边被布局公式钉死了,光改 `width` 根本推不动它:
   松手重排后它弹回原位,长出来的部分全跑到对面去。
   **真正的解法是意识到轨道有两个自由度,一条边各管一个**:
   - 外侧边(远离页面)→ 轨道**宽度** `railWidth`
   - 内侧边(朝向页面)→ 轨道**离页面的距离** `railGap`(新增设置),
     同时 width 反向补偿,保证外侧边不动
   两个都是整条轨道共享的设置,所以拖任何一条批注的边 = 改这一侧全部批注,
   这本来就是"轨道"的含义。`railGap` 允许为负 = 把轨道压到页面上。
   几何在 scratchpad 里用 7 个用例验证过(左/右轨道 × 内/外侧边 4 种组合都满足
   "抓哪条边哪条边跟光标走、对面那条不动",外加负 gap、宽度下限、左轨道空间不足
   被 clamp 到 0 这三种边界)。

3. **设置里"轨道宽度"是什么意思**——用户直接问了,说明文案没交代清楚模型。
   设置页现在先有一段总述:「固定」的批注不是自己记住位置,而是排在页面左右两条轨道里,
   所以宽度和离页面的距离是**整条轨道共用**的,单位是 PDF 点、跟着页面缩放。

### v0.7.0 —— 原文/译文自动配对,共用同一份批注

用户的工作流:论文会用管线翻译成**保留排版**的中文版。希望在原文和译文上看到
同一套批注,并且能一键切换语言、停在同一个位置。

**先测量再设计。** 拿库里真实的两对文件量过:

| 指标 | 结果 |
|---|---|
| 页数 / 页面尺寸 | 16 vs 16、14 vs 14,均 612×792 |
| 文本块位置 IoU 中位数 | 0.72 |
| **对应段落纵向偏移中位数** | **1.0pt** |
| p90 / 最大 | 9.8pt / 28.5pt |
| 落在一行高度内 | 93% |

结论:排版保留得足够好,**坐标可以直接共用**,不需要重新锚定。

**配对不是"同步两份数据",而是"本来就是一份"。** store 的 key 从「路径」改成
「组」:`路径 --pairs--> 组 key --> 批注数组`。原文和译文指向同一个组,所以增删改
天然一致,不存在同步冲突。组 key 用**原文那一侧的路径**(译文侧才是衍生物)。

**自动识别的规则(全部经过真实语料验证)。** 只按文件名匹配是**不安全**的:86 个 PDF
里名字包含关系能匹配出 24 对,其中只有 2 对是真的。假阳性包括三个同名
`hopfield_pooling.pdf`(不同子目录里的不同插图)、`foo` vs `foo_adapted`、
以及同一篇论文的两份英文副本。最终规则是四条同时成立:

1. 文件名归一化(去掉所有非字母数字)后互相包含,核心长度 ≥12、长度比 ≥0.6
   ——**不维护前后缀白名单**,因为用户的前后缀会变,但论文名一定在
2. 页数相同
3. 页面尺寸相同
4. **一侧 CJK 占比 ≥25%、另一侧不是**

第 4 条是决定性的,单靠它就排除了 22 个假阳性中的绝大多数。这四条跑下来,
在真实语料上**恰好只留下那 2 对真的**。

**指纹从哪来:全部白嫖自已打开的 viewer**,不额外加载任何 PDF——页数取
`pdfDocument.numPages`,页面尺寸取 `pageView.pdfPage.view`,CJK 占比取文字层
`textContentItems`(前 3 页采样)。代价是**两份都至少打开过一次**才会配对成功,
但这恰好也是能真正**校验**而不是靠文件名猜的时刻。

**切换命令**`[PDF] 切换到对应的译文/原文(保持页码和位置)`:取当前视口里占比最大的
那一页作为页码,再记下视口在该页内的纵向比例,打开对方后重新施加同一个比例。
批注面板顶部也会显示一条「与 xxx 共用批注」,点一下同样切过去。

**数据格式升到 v3**,新增 `pairs`(成员路径 → 组 key)和 `fingerprints`(路径 → 页数/
尺寸/CJK 占比)。v1/v2 文件读进来这两项就是空对象,不需要迁移。改名时 `pairs`、
`fingerprints`、批注三者一起跟着走,包括"被改名的正好是组 key"这种情况。
store 层 9 个用例已验证(含合并、双向增删、往返、改名、解除配对)。

### v0.7.1 —— 配对根本没生效的两个 bug(靠用户的真实数据文件诊断出来)

用户报告"01_PDF-trans 里的都试了不行"。**直接读他的 `annotations.json` 就看清了**:
`pairs: {}`,而 `fingerprints` 里**只有 1 条**,还是个无关的 64 页文档。两个独立的 bug:

1. **指纹几乎从不生成。** `ScriptSampler.done` 要求采满 **3 页**才写指纹,但 pdf.js
   只渲染视口内的页——打开一个 PDF 不往下滚,只会渲染 1~2 页,`done` 永远不为真,
   指纹永远不写,自然永远配不上。唯一成功的那条是因为用户滚动过那个长文档。
   **改成第一页就写,后续页到达时再细化**(`done` 现在只用来停止采样,不再控制写入)。
   `setFingerprint` 也跟着改:原来只比几何字段就提前 return,会把 `cjk` 永久钉死在
   第一页的值上。

2. **中文占比算出来是错的。** 那条唯一的指纹给一篇**纯英文**论文记了 `cjk: 0.20`,
   而 PyMuPDF 实测同样前 3 页是 `cjk=0 latin=9193 → 0.000`。阈值当时是 0.25,
   **离误判只差 0.05**。原因基本可以确定是 LaTeX 数学字体的 ToUnicode 映射损坏,
   glyph 落进了 CJK 码段。
   **改法:不再用绝对阈值,改成要求两侧的"差距"够大** —— `|a.cjk - b.cjk| >= 0.4`
   且 `max >= 0.5`。真实译文约 0.9,英文即使被噪声抬到 0.2 也照样分得开;而同语言的
   两份副本无论绝对值多少都因为差距为 0 被拒。
   顺带把取文本的方式从 `textContentItems`(在镜像的类型里声明了,但**代码里从来没有
   任何地方真正用过**,跨 Obsidian 版本是否存在未经验证)换成 `textDivs` 的
   `textContent` —— `getTextLayerInfo()` 本来就是靠 `textDivs` 判断可用性的。

3. **失败时不再只说"没找到"。** `explainNoCounterpart()` 会指出具体卡在哪一步:
   没有名字相近的文件 / 当前文件还没采到指纹 / 候选存在但从没打开过(最常见)/
   页数尺寸对不上(附上两边的实际数字)/ 两边看起来是同一种语言(附上两边的占比)。
4. **兜底:`[PDF] 手动关联原文/译文`** 走一个 FuzzySuggest 选择器(优先列名字相近的,
   没有就列全部 PDF),**跳过所有校验**直接配对;另有 `[PDF] 解除原文/译文关联`。
   自动识别再怎么调都可能有边角情况,得有一条不依赖启发式的路。

### v0.7.2 —— 切换语言时的过渡效果

用户问能不能做成平滑过渡。**如实说清楚了做不到的部分**:原文和译文是两份独立的
PDF 文档,pdf.js 在换文件时会整个拆掉重渲染页面 canvas,没有公开的办法让两份文档
同时保持渲染状态去做真正的内容 crossfade——那需要截取两边的 canvas 像素自己做动画,
成本和脆弱程度都不成比例。

**做了两件真实可行的**:
1. 切换瞬间给整个视图容器一个短暂的透明度回落(`.margin-notes-pdf-switching`,
   180ms),软化文件替换那一下的硬切,不是内容动画,只是个视觉缓冲。
   **这个类只挂在 `view.containerEl`(View 公开 API 的一部分)上,不猜 pdf.js
   内部的 class 名**——这插件已经因为假设未公开 DOM 结构吃过亏,这次直接避开。
2. 落到目标位置那步,从 `scrollTop +=`(瞬间跳)改成 `scrollBy({behavior:"smooth"})`
   (动画滚动)——这是真正在做动画的部分。

`view.containerEl` 是在切换前捕获的普通元素引用,不是从 `view` 或 `view.leaf`
延迟读取——同类型文件切换 Obsidian 会复用同一个 View 实例(`onLoadFit`/`onLoadFile`
那套生命周期,不会把整个 View 拆了重建),但拿着元素引用比每次都重新问 `view` 更稳。

### epub(讨论,未实现)

用户确认了 epub 的批注模型:选中文字 → 加批注(没有页码/PDF 坐标概念,只有 DOM 里的
文字位置);点击高亮 → 显示批注;侧边栏同一套逻辑。这意味着 PDF 现在用的
`anchor: PdfRect` 完全不适用于 epub,得换成文字引用锚点(`{quote, prefix, suffix}`,
姐妹项目 `~/Documents/project/margin-notes-web/src/anchor.ts` 已经有实现可以照抄)。
结构上可行——把"锚点→屏幕坐标"抽成接口,PDF/epub 各一个实现,便利贴/轨道/避让/渲染
全部复用——但这是不小的重构,还没动手,等 PDF 这版彻底跑顺再说。

### 还没做 / 下一步

1. 上面"完全没验证"整节的真实 UI 验证
2. **双链不进反链系统**——批注文字在 JSON 里,Obsidian 的 metadataCache 不解析它,
   所以 `[[某某]]` 只是单向可点,目标笔记看不到反链、图谱也不连线。已和用户讨论过
   改存 Markdown(一个 PDF 配一个批注 md,机器字段塞 HTML 注释)来彻底解决,
   **这个决定还悬着,没做**
3. epub 支持——见上面的讨论小节,数据模型需要一次不小的重构才能两边共用
4. AI 写批注:当前 schema 对 AI 只读友好、写不友好(锚点是坐标,AI 推不出来)。
   讨论过的方向是加 `quote`/`prefix`/`suffix` 文字锚点(姐妹项目
   `~/Documents/project/margin-notes-web/src/anchor.ts` 已有同款实现可抄),
   页码作为更粗的精度档兜底。**也还没做**
5. `revealAnnotation` 用固定 350ms 等 pdf.js 渲染完目标页,不稳;应该改成监听一次
   `pagerendered`
6. 各页尺寸/旋转不一致的 PDF,轨道会左右跳(大多数 PDF 每页一致,真遇到再修)
