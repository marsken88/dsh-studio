/* 五个页面（工作台 / 需求 / 用例 / 版本 / 效能）共用的容器常量。
 *
 * 以前每个页面各抄一份同样的 PAGE / PANEL_HEAD / PANEL_BODY：
 *   · 没有最大宽度 —— 2560 宽屏下单行能到 2138px（≈178 字），远超人能扫读的宽度；
 *   · 页面与面板同色（都 background-primary）—— 面板只有一根 1px 边，等于没有边界；
 *   · 改一处要抄五遍，早晚走样（效能页的 PANEL 就因为分批改而多出了 shadow-xs）。
 *
 * 现在：一个源。页面底色用 secondary（面板保持 primary，靠底色差 + 阴影分层），
 * 每个直接子块限宽 1440 并居中 —— 超宽屏不再把一行拉到 2000px。
 */

export const PAGE = 'flex min-w-0 flex-col gap-4 overflow-auto bg-background-secondary-default p-4 [&>*]:shrink-0 [&>*]:mx-auto [&>*]:w-full [&>*]:max-w-[1440px]'
export const PANEL = 'flex min-w-0 flex-col overflow-hidden rounded-xl border border-separator-border bg-background-primary-default shadow-xs'
export const PANEL_HEAD = 'flex flex-wrap items-center gap-2 border-b border-separator-border px-4 py-3 text-body-2-medium text-text-primary'
export const PANEL_BODY = 'flex min-w-0 flex-col gap-3 p-4'
/* 吸顶的筛选行 / 分区页签：长页面里它们会跟着滚走，滚到 1600px 处想换区间得先滚回去。
   底色跟页面一致（不然会透出下面的内容），加一条下边界说明「这是一层工具条」。 */
export const STICKY = 'sticky top-0 z-10 flex min-w-0 flex-wrap items-center gap-2 border-b border-separator-border bg-background-secondary-default py-2'
