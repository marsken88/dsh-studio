/* Display labels and enumerations shared by the board, drawers and forms.
   Pure tables — no React, no API access — so they can be imported by any
   page module without dragging the panel along. */

export const ROLE_LABEL = { product: '产品', architect: '架构', dev: '研发', qa: '测试' }
export const PRIORITY_LABEL = { urgent: '紧急', normal: '普通', relaxed: '宽松' }
export const TYPE_LABEL = { requirement: '需求', bug: '缺陷', design: '设计', dev: '开发', test: '测试', ops: '运维' }
export const SEVERITY_LABEL = { p0: 'P0 致命', p1: 'P1 严重', p2: 'P2 一般', p3: 'P3 轻微' }
export const ARTIFACT_KINDS = ['requirement', 'design', 'mr', 'cases', 'report', 'release', 'doc', 'screenshot', 'other']
export const ARTIFACT_KIND_LABEL = { requirement: '需求', design: '方案', mr: 'MR', cases: '用例', report: '报告', release: '发布', doc: '文档', screenshot: '截图', other: '其它' }
export const ARTIFACT_STATUS = ['draft', 'delivered', 'accepted']
export const CASE_RESULTS = ['pending', 'pass', 'fail', 'skip']
export const CASE_RESULT_LABEL = { pending: '⬜ 未跑', pass: '✅ 通过', fail: '❌ 不通过', skip: '⏭️ 跳过' }
export const CASE_TYPES = ['functional', 'api', 'ui', 'performance', 'security', 'other']
export const CASE_TYPE_LABEL = { functional: '功能', api: '接口', ui: '界面', performance: '性能', security: '安全', other: '其它' }
export const CASE_PRIORITIES = ['p0', 'p1', 'p2', 'p3']
export const ARTIFACT_STATUS_LABEL = { draft: '草稿', delivered: '已交付', accepted: '已验收' }
export const CODING_REVIEW_LABEL = { pending: '待评审', approved: '评审通过', changes_requested: '要求修改' }
export const CODING_CHANGE_LABEL = { added: '新增', modified: '修改', deleted: '删除' }
export const PROJECT_STATUS_LABEL = { active: '进行中', paused: '暂停', archived: '已归档' }
export const ITERATION_STATUS_LABEL = { planned: '未开始', active: '进行中', closed: '已结束' }
export const STRATEGY_LABEL = { round_robin: '轮询', best_match: '按专长匹配', lead: '团长分派' }
export const REQ_STATUS_ORDER = ['draft', 'review', 'active', 'delivered', 'closed']
export const DOC_KIND_LABEL = { prd: 'PRD', proto: '原型', acceptance: '验收标准', other: '其它' }
export const DOC_KIND_ORDER = ['prd', 'proto', 'acceptance', 'other']
export const DOC_STATUS_LABEL = { draft: '草稿', review: '评审中', baseline: '已生效' }
export const RELEASE_STATUS_ORDER = ['draft', 'candidate', 'approved', 'released', 'rolled_back']
export const REQ_STATUS_LABEL = { draft: '草稿', review: '待评审', active: '进行中', delivered: '已交付', closed: '已关闭' }
export const RELEASE_STATUS_LABEL = { draft: '草稿', candidate: '待发布', approved: '已审批', released: '已发布', rolled_back: '已回滚' }
