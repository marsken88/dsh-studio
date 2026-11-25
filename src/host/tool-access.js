/* 每个 studio_* 工具要求的权限档位（纯数据 + 一个查表函数）。
 *
 * 没登记就按 'write' 处理是"收紧"的默认值，但**不能静默漏登记**：
 * issue #5 第 1 条就是 4 个纯读工具（dashboard / workload / burndown / costs）不在表里，
 * 拿到 'write' 后被当成写操作去审计，直接抛错。契约测试会遍历所有已注册工具，
 * 要求每一个都在下面出现。
 */

export const TOOL_ACCESS = {
  studio_config_get: 'read',
  studio_requirement_list: 'read',
  studio_requirement_get: 'read',
  studio_task_list: 'read',
  studio_task_get: 'read',
  studio_project_list: 'read',
  studio_release_list: 'read',
  studio_release_get: 'read',
  studio_analytics: 'read',
  studio_skill_list: 'read',
  studio_skill_get: 'read',
  studio_dashboard: 'read',
  studio_workload: 'read',
  studio_burndown: 'read',
  studio_costs: 'read',
  studio_task_create: 'write',
  studio_task_update: 'write',
  studio_task_comment: 'write',
  /** 把卡当场派给某人/团/角色位：会起会话（花 token），按写操作记账。 */
  studio_task_mention: 'write',
  studio_task_block: 'write',
  studio_task_unblock: 'write',
  studio_task_check: 'write',
  studio_task_case: 'write',
  studio_task_add_cases: 'write',
  studio_task_test_plan: 'write',
  studio_task_generate_cases: 'write',
  studio_task_artifact: 'write',
  studio_task_coding: 'write',
  studio_task_quality: 'write',
  studio_merge_gate: 'write',
  studio_task_signoff: 'write',
  studio_task_design: 'write',
  studio_requirement_save: 'write',
  studio_requirement_review: 'write',
  studio_requirement_split: 'write',
  studio_requirement_questions: 'write',
  studio_requirement_comment: 'write',
  studio_requirement_doc: 'write',
  studio_requirement_requester: 'write',
  studio_requirement_signoff: 'write',
  studio_requirement_folder: 'write',
  studio_project_save: 'admin',
  studio_skill_save: 'write',
  studio_skill_mine: 'write',
  studio_bug_duplicate: 'write',
  studio_test_run: 'write',
  studio_test_suite: 'write',
  /** 发起无卡会话：会真的起一个 agent 会话（花 token、能读工作目录），按写操作记账。 */
  studio_session_start: 'write',
  /** 需求对话澄清：只读（不写库），与面板里的 /requirement/assist 一致，只读成员也能用。 */
  studio_requirement_assist: 'read',
  studio_config_set: 'admin',
  studio_release_publish: 'admin',
  studio_release_save: 'admin',
  studio_release_gray: 'admin',
  studio_skill_delete: 'admin',
}

export function toolLevel(name, args = null) {
  /* 同一个工具里动作风险不同：merge 会把分支真的合进远端（admin+confirm 的路由同款），
     publish 只发一个提交状态，保持 write。 */
  if (name === 'studio_merge_gate' && String(args?.action ?? '') === 'merge') return 'admin'
  return TOOL_ACCESS[name] ?? 'write'
}

/** 已登记的工具名（契约测试用）。 */
export function toolAccessTable() {
  return { ...TOOL_ACCESS }
}
