const INJECTED = ["isSkillName","readJsonBody","sendJson","skillFromMarkdown","skillFromZip","skillsRoot","getSkills"]
let host = {
  isSkillName: () => {},
  readJsonBody: () => {},
  sendJson: () => {},
  skillFromMarkdown: () => {},
  skillFromZip: () => {},
  skillsRoot: () => {},
  getSkills: () => undefined,
}
/** 技能库的读写与上传路由。宿主能力由 configureSkillsRoutes() 注入。 */
export function configureSkillsRoutes(services) {
  host = { ...host, ...(services ?? {}) }
}

export async function handleSkillsRoute({ method, route, req, res, store, url }) {
if (route.startsWith('/skills')) {
  if (host.getSkills() === undefined) throw new Error('技能库尚未就绪')
  if (method === 'GET' && route === '/skills') {
    host.sendJson(res, 200, { ok: true, root: host.skillsRoot(), skills: host.getSkills().list(), onDisk: await host.getSkills().visibleRoots() })
    return true
  }
  if (method === 'POST' && route === '/skills/save') {
    const body = await host.readJsonBody(req)
    const { skill, file, warning } = await host.getSkills().save(body.skill ?? body)
    host.sendJson(res, 200, { ok: true, skill, file, warning, skills: host.getSkills().list() })
    return true
  }
  if (method === 'POST' && route === '/skills/delete') {
    const body = await host.readJsonBody(req)
    await host.getSkills().remove(String(body.name ?? ''))
    host.sendJson(res, 200, { ok: true, skills: host.getSkills().list() })
    return true
  }
  if (method === 'POST' && route === '/skills/sync') {
    const { written } = await host.getSkills().syncAll()
    host.sendJson(res, 200, { ok: true, written, skills: host.getSkills().list() })
    return true
  }
  if (method === 'POST' && route === '/skills/upload') {
    const body = await host.readJsonBody(req)
    const fileName = String(body.fileName ?? body.name ?? '').trim()
    const encoded = String(body.dataBase64 ?? '')
    const plain = typeof body.text === 'string' ? body.text : ''
    let text = plain
    let sourceName = fileName
    if (encoded !== '') {
      const buffer = Buffer.from(encoded, 'base64')
      if (buffer.length === 0) throw new Error('上传的文件是空的')
      if (buffer.length > 1_400_000) throw new Error('文件太大：技能包请控制在 1.4MB 以内（正文本身上限 6 万字）')
      if (buffer.subarray(0, 2).toString('latin1') === 'PK') {
        const unzipped = await host.skillFromZip(buffer)
        if (!unzipped.ok) throw new Error(unzipped.error)
        text = unzipped.text
        sourceName = unzipped.fileName
      } else {
        text = buffer.toString('utf8')
      }
    }
    if (String(text).trim() === '') throw new Error('没读到内容：请上传 SKILL.md，或包含 SKILL.md 的 .zip')
    const draft = host.skillFromMarkdown(sourceName, text)
    if (!host.isSkillName(draft.name)) {
      throw new Error('从文件里推不出合法的技能名（kebab-case）：在 frontmatter 里加一行 name: my-skill 再传')
    }
    const existing = host.getSkills().get(draft.name)
    if (existing !== undefined && body.overwrite !== true) {
      throw new Error(`技能「${draft.name}」已经在库里了：换个文件名，或勾上「覆盖同名技能」再传。`)
    }
    const { skill, file, warning } = await host.getSkills().save(draft)
    host.sendJson(res, 200, { ok: true, skill, file, warning, overwritten: existing !== undefined, skills: host.getSkills().list() })
    return true
  }
}
  return false
}
