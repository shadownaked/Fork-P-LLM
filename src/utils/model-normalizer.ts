/**
 * Model Name Normalizer
 *
 * 解决 Anthropic 模型命名变体问题：
 * - Claude Code 请求: claude-sonnet-4-20250514
 * - 站点暴露: claude-sonnet-4-5
 *
 * 核心思路：将各种命名变体规范化为统一的模型类型（haiku/sonnet/opus）
 */

/**
 * Claude 模型类型
 */
export type ClaudeModelType = 'haiku' | 'sonnet' | 'opus'

/**
 * 模型规范化结果
 */
export interface NormalizedModel {
  type: ClaudeModelType
  family: string      // 'claude-3' | 'claude-3.5' | 'claude-4' 等
  version?: string    // 版本号如 '20250514'
  original: string    // 原始模型名
}

/**
 * 模型名称模式匹配规则
 *
 * Anthropic 模型命名规律：
 * - claude-{type}-{version}-{date}  (如 claude-sonnet-4-20250514)
 * - claude-{version}-{type}         (如 claude-3-5-sonnet)
 * - claude-{type}-{version}         (如 claude-sonnet-4-5)
 */
const MODEL_PATTERNS: Array<{
  pattern: RegExp
  extract: (match: RegExpMatchArray) => { type: ClaudeModelType; family: string; version?: string } | null
}> = [
  // claude-sonnet-4-20250514, claude-opus-4-20250514, claude-haiku-4-20250514
  {
    pattern: /^claude-(haiku|sonnet|opus)-(\d+(?:\.\d+)?)-(\d{8})$/i,
    extract: (match) => ({
      type: match[1].toLowerCase() as ClaudeModelType,
      family: `claude-${match[2]}`,
      version: match[3]
    })
  },
  // claude-sonnet-4-5, claude-opus-4-5, claude-haiku-4-5
  {
    pattern: /^claude-(haiku|sonnet|opus)-(\d+)-(\d+)$/i,
    extract: (match) => ({
      type: match[1].toLowerCase() as ClaudeModelType,
      family: `claude-${match[2]}.${match[3]}`
    })
  },
  // claude-3-5-sonnet, claude-3-5-haiku, claude-3-opus
  {
    pattern: /^claude-(\d+)(?:-(\d+))?-(haiku|sonnet|opus)(?:-\d{8})?$/i,
    extract: (match) => ({
      type: match[3].toLowerCase() as ClaudeModelType,
      family: match[2] ? `claude-${match[1]}.${match[2]}` : `claude-${match[1]}`
    })
  },
  // claude-3-sonnet, claude-3-haiku, claude-3-opus (无小版本号)
  {
    pattern: /^claude-(\d+)-(haiku|sonnet|opus)$/i,
    extract: (match) => ({
      type: match[2].toLowerCase() as ClaudeModelType,
      family: `claude-${match[1]}`
    })
  },
  // 简化形式：仅包含类型名
  {
    pattern: /^(haiku|sonnet|opus)$/i,
    extract: (match) => ({
      type: match[1].toLowerCase() as ClaudeModelType,
      family: 'claude'
    })
  }
]

/**
 * 规范化模型名称
 *
 * @param modelName 原始模型名称
 * @returns 规范化结果，如果无法识别则返回 null
 *
 * @example
 * normalizeModelName('claude-sonnet-4-20250514')
 * // => { type: 'sonnet', family: 'claude-4', version: '20250514', original: '...' }
 *
 * normalizeModelName('claude-sonnet-4-5')
 * // => { type: 'sonnet', family: 'claude-4.5', original: '...' }
 */
export function normalizeModelName(modelName: string): NormalizedModel | null {
  for (const { pattern, extract } of MODEL_PATTERNS) {
    const match = modelName.match(pattern)
    if (match) {
      const result = extract(match)
      if (result) {
        return { ...result, original: modelName }
      }
    }
  }
  return null
}

/**
 * 检测模型类型
 *
 * @param modelName 模型名称
 * @returns 模型类型，如果无法识别则返回 null
 */
export function detectModelType(modelName: string): ClaudeModelType | null {
  const normalized = normalizeModelName(modelName)
  if (normalized) {
    return normalized.type
  }

  // Fallback: 简单字符串匹配
  const lowerName = modelName.toLowerCase()
  if (lowerName.includes('haiku')) return 'haiku'
  if (lowerName.includes('sonnet')) return 'sonnet'
  if (lowerName.includes('opus')) return 'opus'

  return null
}

/**
 * 检查两个模型是否兼容（同一类型）
 *
 * @param modelA 模型 A
 * @param modelB 模型 B
 * @returns 是否兼容
 *
 * @example
 * areModelsCompatible('claude-sonnet-4-20250514', 'claude-sonnet-4-5')
 * // => true (都是 sonnet)
 *
 * areModelsCompatible('claude-sonnet-4-20250514', 'claude-opus-4-5')
 * // => false (不同类型)
 */
export function areModelsCompatible(modelA: string, modelB: string): boolean {
  const typeA = detectModelType(modelA)
  const typeB = detectModelType(modelB)

  if (!typeA || !typeB) {
    return false
  }

  return typeA === typeB
}

/**
 * 获取模型类型的优先级
 * 用于在多个匹配时选择最佳模型
 *
 * @param type 模型类型
 * @returns 优先级（数字越大越优先）
 */
export function getModelTypePriority(type: ClaudeModelType): number {
  switch (type) {
    case 'opus': return 3    // 最强大
    case 'sonnet': return 2  // 平衡
    case 'haiku': return 1   // 最快
    default: return 0
  }
}

/**
 * 解析模型家族版本号
 *
 * @param family 模型家族字符串 (如 'claude-4.5')
 * @returns 版本号数组 [major, minor]
 */
export function parseModelFamily(family: string): [number, number] {
  const match = family.match(/claude-(\d+)(?:\.(\d+))?/)
  if (match) {
    return [parseInt(match[1], 10), parseInt(match[2] || '0', 10)]
  }
  return [0, 0]
}

/**
 * 比较两个模型家族版本
 *
 * @returns 负数表示 a < b，正数表示 a > b，0 表示相等
 */
export function compareModelFamilies(familyA: string, familyB: string): number {
  const [majorA, minorA] = parseModelFamily(familyA)
  const [majorB, minorB] = parseModelFamily(familyB)

  if (majorA !== majorB) {
    return majorA - majorB
  }
  return minorA - minorB
}
