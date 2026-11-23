/**
 * 面板探针「选对元素」的判据 —— 纯函数，单独放这里是为了能被单测钉住。
 *
 * 为什么值得抽出来：`tools/visual/panel-probe.mjs` 的 ② 以前两次量错对象，
 * 报出来的红长得像产品 bug，实际什么都没坏：
 *   a) 找不到探针自己造的卡就退化成点第一张卡 → 读到别人的卡（真机实测读到 pointId=p3 那张，
 *      于是输出 {"value":"p3","hint":true}，「默认值没继承」的结论完全是样本错了）；
 *   b) 「第一个带『不归功能点』的下拉」也不是新用例表单 —— 卡上每条既有用例自己有归属下拉，
 *      排在表单前面（真机 3 条用例 = 4 个下拉），读到的是某条用例的功能点。
 *
 * 这两个坑都是「文本里认元素」的判据，正好可以脱离浏览器写成纯函数。
 */

/** 是不是探针自己造的那张卡。找不到时必须报红，不许拿别人的卡当样本。 */
export function isProbeCard(text, title = '（探针）看板卡片') {
  return String(text ?? '').includes(title)
}

/**
 * 新用例表单那一行在 `.ds-row` 列表里的下标。
 * 该行的文案是「这条用例算在 <功能点下拉>」，找不到返回 -1。
 */
export function formRowIndex(rowTexts, marker = '这条用例算在') {
  if (!Array.isArray(rowTexts)) return -1
  return rowTexts.findIndex(text => String(text ?? '').includes(marker))
}

/**
 * 原生 `select` 的取值归一：react-aria 用 `__empty__` 哨兵表示「未选」，
 * 和空串是同一件事（BoardUI Select 的 toKey 与 HiddenSelect 的实测值都这样）。
 */
export function normalizePointValue(value) {
  const raw = String(value ?? '')
  return raw === '__empty__' ? '' : raw
}
