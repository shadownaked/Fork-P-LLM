import { describe, it, expect } from 'vitest'
import {
  normalizeModelName,
  detectModelType,
  areModelsCompatible,
  getModelTypePriority,
  parseModelFamily,
  compareModelFamilies,
  type ClaudeModelType
} from './model-normalizer'

describe('model-normalizer', () => {
  describe('normalizeModelName', () => {
    it('should parse claude-sonnet-4-20250514 format', () => {
      const result = normalizeModelName('claude-sonnet-4-20250514')
      expect(result).toEqual({
        type: 'sonnet',
        family: 'claude-4',
        version: '20250514',
        original: 'claude-sonnet-4-20250514'
      })
    })

    it('should parse claude-opus-4-20250514 format', () => {
      const result = normalizeModelName('claude-opus-4-20250514')
      expect(result).toEqual({
        type: 'opus',
        family: 'claude-4',
        version: '20250514',
        original: 'claude-opus-4-20250514'
      })
    })

    it('should parse claude-haiku-4-20250514 format', () => {
      const result = normalizeModelName('claude-haiku-4-20250514')
      expect(result).toEqual({
        type: 'haiku',
        family: 'claude-4',
        version: '20250514',
        original: 'claude-haiku-4-20250514'
      })
    })

    it('should parse claude-sonnet-4-5 format', () => {
      const result = normalizeModelName('claude-sonnet-4-5')
      expect(result).toEqual({
        type: 'sonnet',
        family: 'claude-4.5',
        original: 'claude-sonnet-4-5'
      })
    })

    it('should parse claude-opus-4-5 format', () => {
      const result = normalizeModelName('claude-opus-4-5')
      expect(result).toEqual({
        type: 'opus',
        family: 'claude-4.5',
        original: 'claude-opus-4-5'
      })
    })

    it('should parse claude-3-5-sonnet format', () => {
      const result = normalizeModelName('claude-3-5-sonnet')
      expect(result).toEqual({
        type: 'sonnet',
        family: 'claude-3.5',
        original: 'claude-3-5-sonnet'
      })
    })

    it('should parse claude-3-opus format', () => {
      const result = normalizeModelName('claude-3-opus')
      expect(result).toEqual({
        type: 'opus',
        family: 'claude-3',
        original: 'claude-3-opus'
      })
    })

    it('should parse simple type names', () => {
      expect(normalizeModelName('sonnet')).toEqual({
        type: 'sonnet',
        family: 'claude',
        original: 'sonnet'
      })
      expect(normalizeModelName('opus')).toEqual({
        type: 'opus',
        family: 'claude',
        original: 'opus'
      })
      expect(normalizeModelName('haiku')).toEqual({
        type: 'haiku',
        family: 'claude',
        original: 'haiku'
      })
    })

    it('should return null for unrecognized formats', () => {
      expect(normalizeModelName('gpt-4')).toBeNull()
      expect(normalizeModelName('gemini-pro')).toBeNull()
      expect(normalizeModelName('random-model')).toBeNull()
    })

    it('should be case insensitive', () => {
      const result = normalizeModelName('Claude-SONNET-4-20250514')
      expect(result?.type).toBe('sonnet')
    })
  })

  describe('detectModelType', () => {
    it('should detect sonnet type', () => {
      expect(detectModelType('claude-sonnet-4-20250514')).toBe('sonnet')
      expect(detectModelType('claude-sonnet-4-5')).toBe('sonnet')
      expect(detectModelType('claude-3-5-sonnet')).toBe('sonnet')
      expect(detectModelType('sonnet')).toBe('sonnet')
    })

    it('should detect opus type', () => {
      expect(detectModelType('claude-opus-4-20250514')).toBe('opus')
      expect(detectModelType('claude-opus-4-5')).toBe('opus')
      expect(detectModelType('claude-3-opus')).toBe('opus')
      expect(detectModelType('opus')).toBe('opus')
    })

    it('should detect haiku type', () => {
      expect(detectModelType('claude-haiku-4-20250514')).toBe('haiku')
      expect(detectModelType('claude-haiku-4-5')).toBe('haiku')
      expect(detectModelType('claude-3-haiku')).toBe('haiku')
      expect(detectModelType('haiku')).toBe('haiku')
    })

    it('should use fallback string matching', () => {
      // These don't match the regex patterns but contain type keywords
      expect(detectModelType('my-custom-sonnet-model')).toBe('sonnet')
      expect(detectModelType('opus-variant')).toBe('opus')
      expect(detectModelType('fast-haiku')).toBe('haiku')
    })

    it('should return null for non-Claude models', () => {
      expect(detectModelType('gpt-4')).toBeNull()
      expect(detectModelType('gemini-pro')).toBeNull()
    })
  })

  describe('areModelsCompatible', () => {
    it('should return true for same type models', () => {
      expect(areModelsCompatible('claude-sonnet-4-20250514', 'claude-sonnet-4-5')).toBe(true)
      expect(areModelsCompatible('claude-opus-4-20250514', 'claude-opus-4-5')).toBe(true)
      expect(areModelsCompatible('claude-haiku-4-20250514', 'claude-haiku-4-5')).toBe(true)
    })

    it('should return false for different type models', () => {
      expect(areModelsCompatible('claude-sonnet-4-20250514', 'claude-opus-4-5')).toBe(false)
      expect(areModelsCompatible('claude-opus-4-20250514', 'claude-haiku-4-5')).toBe(false)
      expect(areModelsCompatible('claude-haiku-4-20250514', 'claude-sonnet-4-5')).toBe(false)
    })

    it('should return false when one model is unrecognized', () => {
      expect(areModelsCompatible('claude-sonnet-4-20250514', 'gpt-4')).toBe(false)
      expect(areModelsCompatible('gpt-4', 'claude-opus-4-5')).toBe(false)
    })
  })

  describe('getModelTypePriority', () => {
    it('should return correct priorities', () => {
      expect(getModelTypePriority('opus')).toBe(3)
      expect(getModelTypePriority('sonnet')).toBe(2)
      expect(getModelTypePriority('haiku')).toBe(1)
    })

    it('should rank opus > sonnet > haiku', () => {
      expect(getModelTypePriority('opus')).toBeGreaterThan(getModelTypePriority('sonnet'))
      expect(getModelTypePriority('sonnet')).toBeGreaterThan(getModelTypePriority('haiku'))
    })
  })

  describe('parseModelFamily', () => {
    it('should parse claude-4 family', () => {
      expect(parseModelFamily('claude-4')).toEqual([4, 0])
    })

    it('should parse claude-4.5 family', () => {
      expect(parseModelFamily('claude-4.5')).toEqual([4, 5])
    })

    it('should parse claude-3.5 family', () => {
      expect(parseModelFamily('claude-3.5')).toEqual([3, 5])
    })

    it('should parse claude-3 family', () => {
      expect(parseModelFamily('claude-3')).toEqual([3, 0])
    })

    it('should return [0, 0] for unrecognized format', () => {
      expect(parseModelFamily('unknown')).toEqual([0, 0])
    })
  })

  describe('compareModelFamilies', () => {
    it('should compare major versions', () => {
      expect(compareModelFamilies('claude-4', 'claude-3')).toBeGreaterThan(0)
      expect(compareModelFamilies('claude-3', 'claude-4')).toBeLessThan(0)
    })

    it('should compare minor versions', () => {
      expect(compareModelFamilies('claude-4.5', 'claude-4')).toBeGreaterThan(0)
      expect(compareModelFamilies('claude-3.5', 'claude-3')).toBeGreaterThan(0)
    })

    it('should return 0 for equal families', () => {
      expect(compareModelFamilies('claude-4', 'claude-4')).toBe(0)
      expect(compareModelFamilies('claude-4.5', 'claude-4.5')).toBe(0)
    })
  })
})
