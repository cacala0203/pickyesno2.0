/**
 * tokens.json (Git sync 版本，格式為 value/type，不帶 $ 前綴)
 * → 只轉換 Semantics/Light 底下的 bg / text / border / icon 四組語意色
 * → Tailwind v4 @theme CSS
 *
 * 使用方式：node scripts/build-tokens.js
 * 輸入：<repo root>/tokens.json
 * 輸出：<repo root>/styles/tokens-theme.css
 *       ⚠️ 請把 OUTPUT_PATH 改成你們專案實際放 CSS 的位置，
 *          例如 Nuxt 專案常見的 app/assets/styles/tokens-theme.css
 */

const fs = require('fs')
const path = require('path')

const INPUT_PATH = path.join(__dirname, '..', 'tokens.json')
const OUTPUT_PATH = path.join(__dirname, '..', 'styles', 'tokens-theme.css')

const RAW = JSON.parse(fs.readFileSync(INPUT_PATH, 'utf-8'))

const BASE_SET = 'Colors/Light'
const SEMANTIC_SET = 'Semantics/Light'
const SEMANTIC_GROUPS = ['bg', 'text', 'border', 'icon']

// 語意分類改名，避免跟 Tailwind 的屬性前綴 (bg-/text-/border-) 疊字
const SEMANTIC_RENAME = { bg: 'surface', text: 'content', border: 'outline', icon: 'icon' }

// ---------------------------------------------------------------------------
// key 名稱清理
// ---------------------------------------------------------------------------
function sanitizeKey(raw) {
  let s = String(raw)
  s = s.replace(/[\u2024\u2027]/g, '-')
  s = s.replace(/&/g, '-and-')
  s = s.replace(/[()]/g, '-')
  s = s.replace(/[^a-zA-Z0-9]+/g, '-')
  s = s.replace(/([a-z0-9])([A-Z])/g, '$1-$2')
  s = s.toLowerCase()
  s = s.replace(/-+/g, '-').replace(/^-|-$/g, '')
  return s
}

// ---------------------------------------------------------------------------
// 合併 Colors/Light（base）+ Semantics/Light 全部內容（只為了讓 alias 能正確
// 解析到，實際輸出只挑 bg/text/border/icon），同時建立路徑對照表
// ---------------------------------------------------------------------------
const pathMap = new Map()
const merged = {}

function isTokenLeaf(node) {
  return node && typeof node === 'object' && 'value' in node
}

function walkAndSanitize(node, origParts, newParts, targetParent, targetKey) {
  if (isTokenLeaf(node)) {
    pathMap.set(origParts.join('.'), newParts.join('.'))
    targetParent[targetKey] = JSON.parse(JSON.stringify(node))
    return
  }
  const newNode = {}
  targetParent[targetKey] = newNode
  pathMap.set(origParts.join('.'), newParts.join('.'))
  for (const [k, v] of Object.entries(node)) {
    if (k.startsWith('$')) continue
    const newKey = sanitizeKey(k)
    walkAndSanitize(v, [...origParts, k], [...newParts, newKey], newNode, newKey)
  }
}

for (const [groupKey, groupVal] of Object.entries(RAW[BASE_SET])) {
  const newGroupKey = sanitizeKey(groupKey)
  if (!merged[newGroupKey]) merged[newGroupKey] = {}
  walkAndSanitize(groupVal, [groupKey], [newGroupKey], merged, newGroupKey)
}
for (const [groupKey, groupVal] of Object.entries(RAW[SEMANTIC_SET])) {
  const newGroupKey = sanitizeKey(groupKey)
  if (!merged[newGroupKey]) merged[newGroupKey] = {}
  walkAndSanitize(groupVal, [groupKey], [newGroupKey], merged, newGroupKey)
}

// ---------------------------------------------------------------------------
// 重寫 alias 字串（{gray.900} 這種）指向 sanitize 後的路徑
// ---------------------------------------------------------------------------
function rewriteAliasString(str) {
  return str.replace(/\{([^}]+)\}/g, (whole, innerPath) => {
    const mapped = pathMap.get(innerPath)
    return mapped ? `{${mapped}}` : whole
  })
}
function rewriteAliasesDeep(node) {
  if (node && typeof node === 'object' && 'value' in node) {
    if (typeof node.value === 'string') node.value = rewriteAliasString(node.value)
    return
  }
  if (node && typeof node === 'object') {
    for (const v of Object.values(node)) rewriteAliasesDeep(v)
  }
}
rewriteAliasesDeep(merged)

// ---------------------------------------------------------------------------
// 解析 alias（含遞迴）
// ---------------------------------------------------------------------------
function getByPath(obj, dotPath) {
  return dotPath.split('.').reduce((cur, p) => (cur == null ? undefined : cur[p]), obj)
}
function resolveValue(rawValue, trail = []) {
  if (typeof rawValue !== 'string' || !rawValue.includes('{')) return rawValue
  return rawValue.replace(/\{([^}]+)\}/g, (whole, innerPath) => {
    if (trail.includes(innerPath)) throw new Error(`循環參照: ${trail.join(' → ')} → ${innerPath}`)
    const node = getByPath(merged, innerPath)
    if (!node || !('value' in node)) return whole
    return resolveValue(node.value, [...trail, innerPath])
  })
}

// ---------------------------------------------------------------------------
// 只輸出 bg/text/border/icon 四組
// ---------------------------------------------------------------------------
function flattenLeaves(node, parts, cb) {
  if (isTokenLeaf(node)) return cb(parts, node)
  for (const [k, v] of Object.entries(node)) flattenLeaves(v, [...parts, k], cb)
}

// ---------------------------------------------------------------------------
// 把 alias 字串轉成 CSS var() 引用，而不是直接 resolve 成最終 hex
// 例如 "{gray.900}" → "var(--color-gray-900)"
// ---------------------------------------------------------------------------
function toVarRef(rawValue) {
  if (typeof rawValue !== 'string') return rawValue
  if (!rawValue.includes('{')) return rawValue // 沒有 alias，是寫死的字面值（如 price-down 的 hex），照原樣輸出
  return rawValue.replace(/\{([^}]+)\}/g, (whole, innerPath) => {
    const cssPath = innerPath.replace(/\./g, '-')
    return `var(--color-${cssPath})`
  })
}

// ---------------------------------------------------------------------------
// 8a. 先輸出 base 色票（Colors/Light 全部），語意層才能 var() 引用得到
// ---------------------------------------------------------------------------
const cssVars = []
for (const [groupKey] of Object.entries(RAW[BASE_SET])) {
  const sanitizedGroup = sanitizeKey(groupKey)
  const node = merged[sanitizedGroup]
  if (!node) continue
  flattenLeaves(node, [sanitizedGroup], (parts, leaf) => {
    const resolved = resolveValue(leaf.value) // base 色票本身通常沒有 alias，直接 resolve 沒差
    cssVars.push(`  --color-${parts.join('-')}: ${resolved};`)
  })
}

// ---------------------------------------------------------------------------
// 8b. 語意層 bg/text/border/icon 改用 var() 引用 base 色票
// ---------------------------------------------------------------------------
for (const groupKey of SEMANTIC_GROUPS) {
  const sanitizedGroup = sanitizeKey(groupKey)
  const node = merged[sanitizedGroup]
  if (!node) {
    console.warn(`⚠️ 找不到 group: ${groupKey}`)
    continue
  }
  const renamed = SEMANTIC_RENAME[groupKey] || sanitizedGroup
  flattenLeaves(node, [renamed], (parts, leaf) => {
    const varRef = toVarRef(leaf.value)
    const varName = `--color-${parts.join('-')}`
    cssVars.push(`  ${varName}: ${varRef};`)
  })
}

const outDir = path.dirname(OUTPUT_PATH)
fs.mkdirSync(outDir, { recursive: true })
const css = `/* 自動產生，請勿手動修改。
 * 來源：tokens.json（Tokens Studio Git Sync）
 * 產生方式：node scripts/build-tokens.js（由 GitHub Actions 自動觸發）
 */
@theme {
${cssVars.join('\n')}
}
`
fs.writeFileSync(OUTPUT_PATH, css, 'utf-8')
console.log(`完成！共 ${cssVars.length} 個變數 → ${path.relative(process.cwd(), OUTPUT_PATH)}`)
