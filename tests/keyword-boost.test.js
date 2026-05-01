/**
 * Unit tests for keyword-boost.js
 * Tests keyword extraction, weighting, and boosting functionality
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the SillyTavern substituteParams function
vi.mock('../../../../../script.js', () => ({
    substituteParams: vi.fn((str) => {
        // Simple mock that replaces common ST macros
        return str
            .replace(/\{\{char\}\}/gi, 'TestCharacter')
            .replace(/\{\{user\}\}/gi, 'TestUser');
    }),
}));

import {
    EXTRACTION_LEVELS,
    DEFAULT_EXTRACTION_LEVEL,
    DEFAULT_BASE_WEIGHT,
    extractLorebookKeywords,
    extractTextKeywords,
    extractTextKeywordsSimple,
    extractChatKeywords,
    extractBM25Keywords,
    extractSmartKeywords,
    applyKeywordBoost,
    getOverfetchAmount,
    applyKeywordBoosts,
} from '../core/keyword-boost.js';

// ============================================================================
// EXTRACTION_LEVELS Configuration Tests
// ============================================================================

describe('EXTRACTION_LEVELS', () => {
    it('should have all expected levels defined', () => {
        expect(EXTRACTION_LEVELS).toHaveProperty('off');
        expect(EXTRACTION_LEVELS).toHaveProperty('minimal');
        expect(EXTRACTION_LEVELS).toHaveProperty('balanced');
        expect(EXTRACTION_LEVELS).toHaveProperty('aggressive');
    });

    it('should have off level disabled', () => {
        expect(EXTRACTION_LEVELS.off.enabled).toBe(false);
    });

    it('should have minimal level configured correctly', () => {
        expect(EXTRACTION_LEVELS.minimal.enabled).toBe(true);
        expect(EXTRACTION_LEVELS.minimal.headerSize).toBe(1500);
        expect(EXTRACTION_LEVELS.minimal.maxKeywords).toBe(5);
        expect(EXTRACTION_LEVELS.minimal.minFrequency).toBe(1);
    });

    it('should have balanced level configured correctly', () => {
        expect(EXTRACTION_LEVELS.balanced.enabled).toBe(true);
        expect(EXTRACTION_LEVELS.balanced.headerSize).toBe(5000);
        expect(EXTRACTION_LEVELS.balanced.maxKeywords).toBe(12);
        expect(EXTRACTION_LEVELS.balanced.minFrequency).toBe(1);
    });

    it('should have aggressive level configured correctly', () => {
        expect(EXTRACTION_LEVELS.aggressive.enabled).toBe(true);
        expect(EXTRACTION_LEVELS.aggressive.headerSize).toBe(null); // Full text
        expect(EXTRACTION_LEVELS.aggressive.maxKeywords).toBe(15);
        expect(EXTRACTION_LEVELS.aggressive.minFrequency).toBe(1);
    });
});

describe('DEFAULT_EXTRACTION_LEVEL', () => {
    it('should be balanced', () => {
        expect(DEFAULT_EXTRACTION_LEVEL).toBe('balanced');
    });
});

describe('DEFAULT_BASE_WEIGHT', () => {
    it('should be 1.5', () => {
        expect(DEFAULT_BASE_WEIGHT).toBe(1.5);
    });
});

// ============================================================================
// extractLorebookKeywords Tests
// ============================================================================

describe('extractLorebookKeywords', () => {
    it('should return empty array for null/undefined entry', () => {
        expect(extractLorebookKeywords(null)).toEqual([]);
        expect(extractLorebookKeywords(undefined)).toEqual([]);
    });

    it('should extract primary keys', () => {
        const entry = {
            key: ['magic', 'wizard', 'spell'],
        };
        const keywords = extractLorebookKeywords(entry);
        expect(keywords).toContain('magic');
        expect(keywords).toContain('wizard');
        expect(keywords).toContain('spell');
    });

    it('should extract secondary keys', () => {
        const entry = {
            key: ['dragon'],
            keysecondary: ['fire', 'scales'],
        };
        const keywords = extractLorebookKeywords(entry);
        expect(keywords).toContain('dragon');
        expect(keywords).toContain('fire');
        expect(keywords).toContain('scales');
    });

    it('should normalize keys to lowercase', () => {
        const entry = {
            key: ['MAGIC', 'Wizard', 'SpElL'],
        };
        const keywords = extractLorebookKeywords(entry);
        expect(keywords).toContain('magic');
        expect(keywords).toContain('wizard');
        expect(keywords).toContain('spell');
    });

    it('should deduplicate keywords', () => {
        const entry = {
            key: ['magic', 'MAGIC', 'Magic'],
            keysecondary: ['magic'],
        };
        const keywords = extractLorebookKeywords(entry);
        expect(keywords.filter(k => k === 'magic').length).toBe(1);
    });

    it('should filter out stopwords', () => {
        const entry = {
            key: ['the', 'magic', 'and', 'wizard'],
        };
        const keywords = extractLorebookKeywords(entry);
        expect(keywords).not.toContain('the');
        expect(keywords).not.toContain('and');
        expect(keywords).toContain('magic');
        expect(keywords).toContain('wizard');
    });

    it('should filter out short words (less than 2 chars)', () => {
        const entry = {
            key: ['a', 'b', 'magic'],
        };
        const keywords = extractLorebookKeywords(entry);
        expect(keywords).not.toContain('a');
        expect(keywords).not.toContain('b');
        expect(keywords).toContain('magic');
    });

    it('should trim whitespace from keys', () => {
        const entry = {
            key: ['  magic  ', '  wizard  '],
        };
        const keywords = extractLorebookKeywords(entry);
        expect(keywords).toContain('magic');
        expect(keywords).toContain('wizard');
    });

    it('should skip empty or whitespace-only keys', () => {
        const entry = {
            key: ['magic', '', '   ', 'wizard'],
        };
        const keywords = extractLorebookKeywords(entry);
        expect(keywords.length).toBe(2);
        expect(keywords).toContain('magic');
        expect(keywords).toContain('wizard');
    });

    it('should handle non-string keys gracefully', () => {
        const entry = {
            key: ['magic', 123, null, undefined, {}, 'wizard'],
        };
        const keywords = extractLorebookKeywords(entry);
        expect(keywords).toContain('magic');
        expect(keywords).toContain('wizard');
        expect(keywords.length).toBe(2);
    });

    it('should handle custom stopwords from settings', () => {
        const entry = {
            key: ['dragon', 'customword', 'wizard'],
        };
        const settings = {
            custom_stopwords: 'customword, anotherword',
        };
        const keywords = extractLorebookKeywords(entry, settings);
        expect(keywords).not.toContain('customword');
        expect(keywords).toContain('dragon');
        expect(keywords).toContain('wizard');
    });

    it('should process ST macros in custom stopwords', () => {
        const entry = {
            key: ['testcharacter', 'testuser', 'wizard'],
        };
        const settings = {
            custom_stopwords: '{{char}}, {{user}}',
        };
        const keywords = extractLorebookKeywords(entry, settings);
        expect(keywords).not.toContain('testcharacter');
        expect(keywords).not.toContain('testuser');
        expect(keywords).toContain('wizard');
    });
});

// ============================================================================
// extractTextKeywords Tests
// ============================================================================

describe('extractTextKeywords', () => {
    it('should return empty array for null/undefined/empty text', () => {
        expect(extractTextKeywords(null)).toEqual([]);
        expect(extractTextKeywords(undefined)).toEqual([]);
        expect(extractTextKeywords('')).toEqual([]);
    });

    it('should return empty array for non-string input', () => {
        expect(extractTextKeywords(123)).toEqual([]);
        expect(extractTextKeywords({})).toEqual([]);
    });

    it('should return empty array when level is off', () => {
        const text = 'The wizard cast a powerful magic spell on the dragon.';
        const keywords = extractTextKeywords(text, { level: 'off' });
        expect(keywords).toEqual([]);
    });

    it('should extract keywords with default balanced level', () => {
        const text = 'The wizard wizard wizard cast a powerful magic spell on the dragon dragon.';
        const keywords = extractTextKeywords(text);
        expect(keywords.length).toBeGreaterThan(0);
        // Should have text and weight properties
        expect(keywords[0]).toHaveProperty('text');
        expect(keywords[0]).toHaveProperty('weight');
    });

    it('should respect maxKeywords limit for minimal level', () => {
        const text = 'Magic wizard spell dragon phoenix castle kingdom knight warrior princess'.repeat(10);
        const keywords = extractTextKeywords(text, { level: 'minimal' });
        expect(keywords.length).toBeLessThanOrEqual(EXTRACTION_LEVELS.minimal.maxKeywords);
    });

    it('should respect maxKeywords limit for balanced level', () => {
        const text = 'Magic wizard spell dragon phoenix castle kingdom knight warrior princess hero villain'.repeat(20);
        const keywords = extractTextKeywords(text, { level: 'balanced' });
        expect(keywords.length).toBeLessThanOrEqual(EXTRACTION_LEVELS.balanced.maxKeywords);
    });

    it('should respect maxKeywords limit for aggressive level', () => {
        const text = 'Magic wizard spell dragon phoenix castle kingdom knight warrior princess hero villain'.repeat(50);
        const keywords = extractTextKeywords(text, { level: 'aggressive' });
        expect(keywords.length).toBeLessThanOrEqual(EXTRACTION_LEVELS.aggressive.maxKeywords);
    });

    it('should filter out stopwords', () => {
        const text = 'The wizard is going to the castle and the dragon will follow.';
        const keywords = extractTextKeywords(text);
        const keywordTexts = keywords.map(k => k.text);
        expect(keywordTexts).not.toContain('the');
        expect(keywordTexts).not.toContain('and');
        expect(keywordTexts).not.toContain('will');
    });

    it('should assign higher weights to more frequent words', () => {
        const text = 'Dragon dragon dragon dragon dragon. Wizard wizard. Castle.';
        const keywords = extractTextKeywords(text, { level: 'aggressive' });

        const dragonKeyword = keywords.find(k => k.text === 'dragon');
        const wizardKeyword = keywords.find(k => k.text === 'wizard');

        if (dragonKeyword && wizardKeyword) {
            expect(dragonKeyword.weight).toBeGreaterThanOrEqual(wizardKeyword.weight);
        }
    });

    it('should cap weights at MAX_KEYWORD_WEIGHT (3.0)', () => {
        const text = 'Dragon '.repeat(100);
        const keywords = extractTextKeywords(text, { level: 'aggressive' });

        for (const kw of keywords) {
            expect(kw.weight).toBeLessThanOrEqual(3.0);
        }
    });

    it('should use custom baseWeight when provided', () => {
        const text = 'Dragon dragon dragon wizard wizard castle';
        const keywords = extractTextKeywords(text, { level: 'aggressive', baseWeight: 2.0 });

        // Keywords should have weights >= 2.0
        for (const kw of keywords) {
            expect(kw.weight).toBeGreaterThanOrEqual(2.0);
        }
    });

    it('should remove parenthetical citations', () => {
        const text = 'The dragon (Source: Ancient Tome) breathes fire (See page 42).';
        const keywords = extractTextKeywords(text, { level: 'aggressive' });
        const keywordTexts = keywords.map(k => k.text);
        expect(keywordTexts).not.toContain('source');
        expect(keywordTexts).not.toContain('ancient');
        expect(keywordTexts).not.toContain('tome');
    });

    it('should remove italicized text', () => {
        const text = 'The dragon *this is an example* breathes *another example* fire.';
        const keywords = extractTextKeywords(text, { level: 'aggressive' });
        const keywordTexts = keywords.map(k => k.text);
        expect(keywordTexts).not.toContain('example');
    });

    it('should strip possessive \'s', () => {
        const text = "Strovolos's domain is vast. Strovolos's power is legendary.";
        const keywords = extractTextKeywords(text, { level: 'aggressive' });
        const keywordTexts = keywords.map(k => k.text);
        // Should have 'strovolos' not 'strovolo'
        expect(keywordTexts.some(t => t.includes('strovolo'))).toBe(true);
    });

    it('should extract compound terms with / or _', () => {
        const text = 'The divine/time god controls time_flow and space_warp.';
        const keywords = extractTextKeywords(text, { level: 'aggressive' });
        const keywordTexts = keywords.map(k => k.text);
        expect(keywordTexts.some(t => t.includes('_'))).toBe(true);
    });

    it('should include frequency count in output', () => {
        const text = 'Dragon dragon dragon wizard';
        const keywords = extractTextKeywords(text, { level: 'aggressive' });
        const dragonKeyword = keywords.find(k => k.text === 'dragon');

        expect(dragonKeyword).toBeDefined();
        expect(dragonKeyword.frequency).toBe(3);
    });

    it('should sort keywords by weight descending', () => {
        const text = 'Dragon dragon dragon dragon. Wizard wizard. Castle.';
        const keywords = extractTextKeywords(text, { level: 'aggressive' });

        for (let i = 1; i < keywords.length; i++) {
            expect(keywords[i - 1].weight).toBeGreaterThanOrEqual(keywords[i].weight);
        }
    });

    it('should preserve proper nouns without stemming', () => {
        const text = 'Gandalf is a powerful wizard. Gandalf casts spells.';
        const keywords = extractTextKeywords(text, { level: 'aggressive' });
        const keywordTexts = keywords.map(k => k.text);
        // 'Gandalf' should be preserved as-is (lowercased)
        expect(keywordTexts).toContain('gandalf');
    });
});

// ============================================================================
// extractTextKeywordsSimple Tests
// ============================================================================

describe('extractTextKeywordsSimple', () => {
    it('should return array of strings only', () => {
        const text = 'Dragon dragon dragon wizard wizard castle';
        const keywords = extractTextKeywordsSimple(text, { level: 'aggressive' });

        expect(Array.isArray(keywords)).toBe(true);
        for (const kw of keywords) {
            expect(typeof kw).toBe('string');
        }
    });

    it('should return same keywords as extractTextKeywords but as strings', () => {
        const text = 'Dragon dragon dragon wizard wizard castle';
        const weightedKeywords = extractTextKeywords(text, { level: 'aggressive' });
        const simpleKeywords = extractTextKeywordsSimple(text, { level: 'aggressive' });

        expect(simpleKeywords).toEqual(weightedKeywords.map(k => k.text));
    });
});

// ============================================================================
// extractChatKeywords Tests
// ============================================================================

describe('extractChatKeywords', () => {
    it('should return empty array for null/undefined/empty text', () => {
        expect(extractChatKeywords(null)).toEqual([]);
        expect(extractChatKeywords(undefined)).toEqual([]);
        expect(extractChatKeywords('')).toEqual([]);
    });

    it('should return empty array for non-string input', () => {
        expect(extractChatKeywords(123)).toEqual([]);
        expect(extractChatKeywords({})).toEqual([]);
    });

    it('should extract capitalized proper nouns', () => {
        const text = 'I met Gandalf yesterday and he told me about Mordor.';
        const keywords = extractChatKeywords(text);
        const keywordTexts = keywords.map(k => k.text);
        expect(keywordTexts).toContain('gandalf');
        expect(keywordTexts).toContain('mordor');
    });

    it('should not extract words at sentence start', () => {
        const text = 'Yesterday was great. Today is better.';
        const keywords = extractChatKeywords(text);
        const keywordTexts = keywords.map(k => k.text);
        // These are at sentence start so shouldn't be extracted
        expect(keywordTexts).not.toContain('yesterday');
        expect(keywordTexts).not.toContain('today');
    });

    it('should respect maxKeywords limit', () => {
        const text = 'I talked to Gandalf, Frodo, Aragorn, Legolas, Gimli, Boromir, Samwise, Merry, Pippin, and Elrond.';
        const keywords = extractChatKeywords(text, { maxKeywords: 5 });
        expect(keywords.length).toBeLessThanOrEqual(5);
    });

    it('should use default baseWeight of 1.5', () => {
        const text = 'I met Gandalf yesterday.';
        const keywords = extractChatKeywords(text);
        if (keywords.length > 0) {
            expect(keywords[0].weight).toBe(DEFAULT_BASE_WEIGHT);
        }
    });

    it('should use custom baseWeight when provided', () => {
        const text = 'I met Gandalf yesterday.';
        const keywords = extractChatKeywords(text, { baseWeight: 2.5 });
        if (keywords.length > 0) {
            expect(keywords[0].weight).toBe(2.5);
        }
    });

    it('should deduplicate proper nouns', () => {
        const text = 'Gandalf said hello. Then Gandalf left.';
        const keywords = extractChatKeywords(text);
        const gandolfCount = keywords.filter(k => k.text === 'gandalf').length;
        expect(gandolfCount).toBeLessThanOrEqual(1);
    });

    it('should filter out stopwords even if capitalized', () => {
        const text = 'The wizard went to the castle.';
        const keywords = extractChatKeywords(text);
        const keywordTexts = keywords.map(k => k.text);
        expect(keywordTexts).not.toContain('the');
    });

    it('should extract words after quotes and asterisks', () => {
        const text = '"Hello," said Gandalf. *Gandalf smiled* at Frodo.';
        const keywords = extractChatKeywords(text);
        const keywordTexts = keywords.map(k => k.text);
        expect(keywordTexts).toContain('gandalf');
    });
});

// ============================================================================
// extractBM25Keywords Tests
// ============================================================================

describe('extractBM25Keywords', () => {
    it('should return empty array for null/undefined/empty text', () => {
        expect(extractBM25Keywords(null)).toEqual([]);
        expect(extractBM25Keywords(undefined)).toEqual([]);
        expect(extractBM25Keywords('')).toEqual([]);
        expect(extractBM25Keywords('   ')).toEqual([]);
    });

    it('should return empty array when level is off', () => {
        const text = 'The wizard cast a powerful magic spell on the dragon.';
        const keywords = extractBM25Keywords(text, { level: 'off' });
        expect(keywords).toEqual([]);
    });

    it('should extract keywords using TF-IDF scoring', () => {
        const text = 'The dragon breathes fire. The dragon is powerful. Dragons are mythical creatures.';
        const keywords = extractBM25Keywords(text, { level: 'aggressive' });
        expect(keywords.length).toBeGreaterThan(0);
        expect(keywords[0]).toHaveProperty('text');
        expect(keywords[0]).toHaveProperty('weight');
        expect(keywords[0]).toHaveProperty('tfidf');
    });

    it('should respect header size for minimal level', () => {
        const minimalHeaderSize = EXTRACTION_LEVELS.minimal.headerSize;

        // Keep phoenix strictly inside the minimal header window.
        const headerText = 'The phoenix rises from ashes. Phoenix is majestic. Legendary phoenix soars high. '.repeat(10);

        // Ensure unicorn starts strictly after the minimal header boundary.
        const paddingNeeded = Math.max(0, (minimalHeaderSize - headerText.length) + 50);
        const padding = 'x'.repeat(paddingNeeded);

        // Unicorn text should be outside the minimal scan window.
        const tailText = 'Unicorn gallops through forest. Magical unicorn appears. ' +
            'The unicorn is beautiful. Rare unicorn sighting reported. '.repeat(3);
        const text = headerText + padding + tailText;

        // Verify test setup guarantees unicorn starts after scan boundary.
        expect(headerText.length).toBeLessThan(minimalHeaderSize);
        expect(headerText.length + padding.length).toBeGreaterThan(minimalHeaderSize);

        const keywords = extractBM25Keywords(text, { level: 'minimal' });
        const keywordTexts = keywords.map(k => k.text);

        // Phoenix should be found (inside minimal scan window).
        expect(keywordTexts.some(t => t.includes('phoenix'))).toBe(true);
        // Unicorn should NOT be found (outside minimal scan window).
        expect(keywordTexts.some(t => t.includes('unicorn'))).toBe(false);
    });

    it('should scan full text for aggressive level', () => {
        const prefix = 'Common words here. '.repeat(100);
        const suffix = 'Unique dragon appears once at the end.';
        const text = prefix + suffix;

        const keywords = extractBM25Keywords(text, { level: 'aggressive' });
        const keywordTexts = keywords.map(k => k.text);
        expect(keywordTexts.some(t => t.includes('dragon') || t.includes('uniqu'))).toBe(true);
    });

    it('should respect maxKeywords limit', () => {
        const text = 'Dragon wizard spell phoenix castle kingdom knight warrior princess hero villain monster creature'.repeat(10);
        const keywords = extractBM25Keywords(text, { level: 'aggressive' });
        expect(keywords.length).toBeLessThanOrEqual(EXTRACTION_LEVELS.aggressive.maxKeywords);
    });

    it('should filter out stopwords', () => {
        const text = 'The wizard is going to the castle and the dragon will follow them there.';
        const keywords = extractBM25Keywords(text, { level: 'aggressive' });
        const keywordTexts = keywords.map(k => k.text);
        expect(keywordTexts).not.toContain('the');
        expect(keywordTexts).not.toContain('and');
        expect(keywordTexts).not.toContain('will');
    });

    it('should respect minWordLength option', () => {
        const text = 'A is to be or not be. Dragon wizard.';
        const keywords = extractBM25Keywords(text, { level: 'aggressive', minWordLength: 4 });
        const keywordTexts = keywords.map(k => k.text);
        for (const kw of keywordTexts) {
            expect(kw.length).toBeGreaterThanOrEqual(4);
        }
    });

    it('should boost capitalized words', () => {
        const text = 'gandalf the wizard met GANDALF again. gandalf gandalf gandalf.';
        const keywords = extractBM25Keywords(text, { level: 'aggressive' });
        // Should find gandalf with boost
        expect(keywords.some(k => k.text.includes('gandalf'))).toBe(true);
    });

    it('should strip possessive \'s', () => {
        const text = "Strovolos's domain. Strovolos's power. Strovolos's realm.";
        const keywords = extractBM25Keywords(text, { level: 'aggressive' });
        const keywordTexts = keywords.map(k => k.text);
        expect(keywordTexts.some(t => t.includes('strovolo'))).toBe(true);
    });

    it('should include TF-IDF score in output', () => {
        const text = 'Dragon dragon dragon. Wizard wizard. Castle.';
        const keywords = extractBM25Keywords(text, { level: 'aggressive' });

        for (const kw of keywords) {
            expect(kw).toHaveProperty('tfidf');
            expect(typeof kw.tfidf).toBe('number');
            expect(kw.tfidf).toBeGreaterThan(0);
        }
    });

    it('should sort by TF-IDF score descending', () => {
        const text = 'Dragon dragon dragon dragon. Wizard wizard. Castle.';
        const keywords = extractBM25Keywords(text, { level: 'aggressive' });

        for (let i = 1; i < keywords.length; i++) {
            expect(keywords[i - 1].tfidf).toBeGreaterThanOrEqual(keywords[i].tfidf);
        }
    });
});

// ============================================================================
// extractSmartKeywords Tests
// ============================================================================

describe('extractSmartKeywords', () => {
    it('should return empty array for null/undefined/empty text', () => {
        expect(extractSmartKeywords(null)).toEqual([]);
        expect(extractSmartKeywords(undefined)).toEqual([]);
        expect(extractSmartKeywords('')).toEqual([]);
        expect(extractSmartKeywords('   ')).toEqual([]);
    });

    it('should return empty array when level is off', () => {
        const text = 'The wizard cast a powerful magic spell on the dragon.';
        const keywords = extractSmartKeywords(text, { level: 'off' });
        expect(keywords).toEqual([]);
    });

    it('should extract keywords with type information', () => {
        const text = 'Gandalf the wizard met the dragon. The dragon was powerful.';
        const keywords = extractSmartKeywords(text, { level: 'aggressive' });
        expect(keywords.length).toBeGreaterThan(0);
        expect(keywords[0]).toHaveProperty('text');
        expect(keywords[0]).toHaveProperty('weight');
        expect(keywords[0]).toHaveProperty('type');
    });

    it('should detect named entities', () => {
        const text = 'I met Gandalf yesterday. Gandalf told me about Mordor.';
        const keywords = extractSmartKeywords(text, { level: 'aggressive', detectEntities: true });
        const entityKeywords = keywords.filter(k => k.isEntity);
        expect(entityKeywords.length).toBeGreaterThan(0);
    });

    it('should detect acronyms', () => {
        const text = 'The FBI and NASA worked together. The CIA also helped.';
        const keywords = extractSmartKeywords(text, { level: 'aggressive', detectEntities: true });
        const keywordTexts = keywords.map(k => k.text);
        expect(keywordTexts.some(t => ['fbi', 'nasa', 'cia'].includes(t))).toBe(true);
    });

    it('should skip entity detection when disabled', () => {
        const text = 'I met Gandalf yesterday.';
        const withEntities = extractSmartKeywords(text, { level: 'aggressive', detectEntities: true });
        const withoutEntities = extractSmartKeywords(text, { level: 'aggressive', detectEntities: false });

        const entityCount1 = withEntities.filter(k => k.type === 'entity' || k.type === 'acronym').length;
        const entityCount2 = withoutEntities.filter(k => k.type === 'entity' || k.type === 'acronym').length;

        expect(entityCount1).toBeGreaterThanOrEqual(entityCount2);
    });

    it('should apply position weighting', () => {
        const text = 'Dragon appears first. Then comes a lot of text. '.repeat(20) + 'Wizard appears at the end.';
        const keywords = extractSmartKeywords(text, { level: 'aggressive', positionWeighting: true });

        // Keywords should have positionWeight property
        for (const kw of keywords) {
            expect(kw).toHaveProperty('positionWeight');
            expect(kw.positionWeight).toBeGreaterThan(0);
        }
    });

    it('should skip position weighting when disabled', () => {
        const text = 'Dragon appears first. Wizard appears later.';
        const keywords = extractSmartKeywords(text, { level: 'aggressive', positionWeighting: false });

        // Position weights should all be 1.0
        for (const kw of keywords) {
            expect(kw.positionWeight).toBe(1.0);
        }
    });

    it('should combine entity detection with TF-IDF', () => {
        const text = 'Gandalf the wizard. Gandalf is powerful. Gandalf casts spells.';
        const keywords = extractSmartKeywords(text, { level: 'aggressive' });

        const gandalf = keywords.find(k => k.text === 'gandalf');
        if (gandalf) {
            // Should have combined type
            expect(gandalf.type).toMatch(/entity|tfidf/);
        }
    });

    it('should respect maxKeywords limit', () => {
        const text = 'Dragon wizard spell phoenix castle kingdom knight warrior'.repeat(10);
        const keywords = extractSmartKeywords(text, { level: 'aggressive', maxKeywords: 5 });
        expect(keywords.length).toBeLessThanOrEqual(5);
    });

    it('should sort by score descending', () => {
        const text = 'Dragon dragon dragon. Wizard wizard. Castle.';
        const keywords = extractSmartKeywords(text, { level: 'aggressive' });

        for (let i = 1; i < keywords.length; i++) {
            expect(keywords[i - 1].weight).toBeGreaterThanOrEqual(keywords[i].weight);
        }
    });
});

// ============================================================================
// applyKeywordBoost Tests
// ============================================================================

describe('applyKeywordBoost', () => {
    it('should return unchanged results for null/undefined inputs', () => {
        expect(applyKeywordBoost(null, 'query')).toEqual(null);
        expect(applyKeywordBoost(undefined, 'query')).toEqual(undefined);
        expect(applyKeywordBoost([], null)).toEqual([]);
        expect(applyKeywordBoost([], '')).toEqual([]);
    });

    it('should boost results with matching keywords', () => {
        const results = [
            { text: 'A dragon story', score: 0.5, keywords: ['dragon', 'fire'] },
            { text: 'A wizard tale', score: 0.6, keywords: ['wizard', 'magic'] },
        ];

        const boosted = applyKeywordBoost(results, 'dragon');

        const dragonResult = boosted.find(r => r.text.includes('dragon'));
        expect(dragonResult.keywordBoosted).toBe(true);
        expect(dragonResult.score).toBeGreaterThan(0.5);
    });

    it('should not boost results without matching keywords', () => {
        const results = [
            { text: 'A dragon story', score: 0.5, keywords: ['dragon', 'fire'] },
        ];

        const boosted = applyKeywordBoost(results, 'wizard');

        expect(boosted[0].keywordBoosted).toBe(false);
        expect(boosted[0].score).toBe(0.5);
    });

    it('should handle keywords as objects with weight', () => {
        const results = [
            { text: 'A dragon story', score: 0.5, keywords: [{ text: 'dragon', weight: 2.0 }] },
        ];

        const boosted = applyKeywordBoost(results, 'dragon');

        expect(boosted[0].keywordBoosted).toBe(true);
        expect(boosted[0].matchedKeywordsWithWeights[0].weight).toBe(2.0);
    });

    it('should apply diminishing returns by default', () => {
        const results = [
            { text: 'Story', score: 0.5, keywords: ['dragon'] },
        ];

        const boosted = applyKeywordBoost(results, 'dragon', { diminishingReturns: true });

        // With 1 match and diminishing returns, should get 30% scaling
        expect(boosted[0].diminishingReturns).toBe(true);
    });

    it('should apply full boost when diminishingReturns is false', () => {
        const results = [
            { text: 'Story', score: 0.5, keywords: [{ text: 'dragon', weight: 2.0 }] },
        ];

        const noScale = applyKeywordBoost(results, 'dragon', { diminishingReturns: false });
        const withScale = applyKeywordBoost(results, 'dragon', { diminishingReturns: true });

        expect(noScale[0].keywordBoost).toBeGreaterThan(withScale[0].keywordBoost);
    });

    it('should cap per-keyword contribution when enabled', () => {
        const results = [
            { text: 'Story', score: 0.5, keywords: [{ text: 'dragon', weight: 5.0 }] },
        ];

        const capped = applyKeywordBoost(results, 'dragon', { perKeywordCap: true, diminishingReturns: false });
        const uncapped = applyKeywordBoost(results, 'dragon', { perKeywordCap: false, diminishingReturns: false });

        // Capped should have lower boost due to 0.5 max contribution
        expect(capped[0].keywordBoost).toBeLessThan(uncapped[0].keywordBoost);
    });

    it('should scale boost based on match count with diminishing returns', () => {
        const results1 = [
            { text: 'Story', score: 0.5, keywords: ['dragon'] },
        ];
        const results2 = [
            { text: 'Story', score: 0.5, keywords: ['dragon', 'fire'] },
        ];
        const results3 = [
            { text: 'Story', score: 0.5, keywords: ['dragon', 'fire', 'scales'] },
        ];

        const boosted1 = applyKeywordBoost(results1, 'dragon fire scales', { diminishingReturns: true });
        const boosted2 = applyKeywordBoost(results2, 'dragon fire scales', { diminishingReturns: true });
        const boosted3 = applyKeywordBoost(results3, 'dragon fire scales', { diminishingReturns: true });

        // More matches = higher scaling factor
        expect(boosted2[0].score).toBeGreaterThan(boosted1[0].score);
        expect(boosted3[0].score).toBeGreaterThan(boosted2[0].score);
    });

    it('should cap final score at 1.0', () => {
        const results = [
            { text: 'Story', score: 0.9, keywords: [{ text: 'dragon', weight: 3.0 }, { text: 'fire', weight: 3.0 }] },
        ];

        const boosted = applyKeywordBoost(results, 'dragon fire', { diminishingReturns: false, perKeywordCap: false });

        expect(boosted[0].score).toBeLessThanOrEqual(1.0);
    });

    it('should sort results by boosted score', () => {
        const results = [
            { text: 'Low score, matching keyword', score: 0.3, keywords: ['dragon'] },
            { text: 'High score, no keyword', score: 0.8, keywords: ['wizard'] },
        ];

        const boosted = applyKeywordBoost(results, 'dragon');

        // Results should be sorted by score descending
        for (let i = 1; i < boosted.length; i++) {
            expect(boosted[i - 1].score).toBeGreaterThanOrEqual(boosted[i].score);
        }
    });

    it('should preserve original score', () => {
        const results = [
            { text: 'Story', score: 0.5, keywords: ['dragon'] },
        ];

        const boosted = applyKeywordBoost(results, 'dragon');

        expect(boosted[0].originalScore).toBe(0.5);
    });

    it('should record matched keywords', () => {
        const results = [
            { text: 'Story', score: 0.5, keywords: ['dragon', 'fire', 'scales'] },
        ];

        const boosted = applyKeywordBoost(results, 'dragon scales');

        expect(boosted[0].matchedKeywords).toContain('dragon');
        expect(boosted[0].matchedKeywords).toContain('scales');
        expect(boosted[0].matchedKeywords).not.toContain('fire');
    });

    it('should handle keywords in metadata', () => {
        const results = [
            { text: 'Story', score: 0.5, metadata: { keywords: ['dragon'] } },
        ];

        const boosted = applyKeywordBoost(results, 'dragon');

        expect(boosted[0].keywordBoosted).toBe(true);
    });

    it('should match keywords case-insensitively', () => {
        const results = [
            { text: 'Story', score: 0.5, keywords: ['Dragon', 'FIRE'] },
        ];

        const boosted = applyKeywordBoost(results, 'dragon fire');

        expect(boosted[0].matchedKeywords.length).toBe(2);
    });
});

// ============================================================================
// getOverfetchAmount Tests
// ============================================================================

describe('getOverfetchAmount', () => {
    it('should return 2x the requested amount', () => {
        expect(getOverfetchAmount(10)).toBe(20);
        expect(getOverfetchAmount(25)).toBe(50);
    });

    it('should have minimum of 10', () => {
        expect(getOverfetchAmount(1)).toBe(10);
        expect(getOverfetchAmount(3)).toBe(10);
    });

    it('should have maximum of 100', () => {
        expect(getOverfetchAmount(60)).toBe(100);
        expect(getOverfetchAmount(100)).toBe(100);
    });

    it('should handle edge cases', () => {
        expect(getOverfetchAmount(0)).toBe(10); // min 10
        expect(getOverfetchAmount(5)).toBe(10); // 2*5=10
        expect(getOverfetchAmount(50)).toBe(100); // 2*50=100 (max)
    });
});

// ============================================================================
// applyKeywordBoosts Tests
// ============================================================================

describe('applyKeywordBoosts', () => {
    it('should apply boost and trim to topK', () => {
        const results = [
            { text: 'Result 1', score: 0.3, keywords: ['dragon'] },
            { text: 'Result 2', score: 0.5, keywords: ['wizard'] },
            { text: 'Result 3', score: 0.4, keywords: ['dragon'] },
            { text: 'Result 4', score: 0.6, keywords: ['castle'] },
            { text: 'Result 5', score: 0.2, keywords: ['dragon'] },
        ];

        const boosted = applyKeywordBoosts(results, 'dragon', 3);

        expect(boosted.length).toBe(3);
    });

    it('should sort by boosted score before trimming', () => {
        const results = [
            { text: 'Low score with keyword', score: 0.3, keywords: ['dragon'] },
            { text: 'High score no keyword', score: 0.9, keywords: ['wizard'] },
        ];

        const boosted = applyKeywordBoosts(results, 'dragon', 2);

        // Should be sorted by score
        expect(boosted[0].score).toBeGreaterThanOrEqual(boosted[1].score);
    });

    it('should handle topK larger than results', () => {
        const results = [
            { text: 'Result 1', score: 0.5, keywords: ['dragon'] },
        ];

        const boosted = applyKeywordBoosts(results, 'dragon', 10);

        expect(boosted.length).toBe(1);
    });
});

// ============================================================================
// Edge Cases and Integration Tests
// ============================================================================

describe('Edge Cases', () => {
    it('should handle very long text without crashing', () => {
        const longText = 'Dragon wizard castle knight '.repeat(10000);

        expect(() => extractTextKeywords(longText, { level: 'aggressive' })).not.toThrow();
        expect(() => extractBM25Keywords(longText, { level: 'aggressive' })).not.toThrow();
        expect(() => extractSmartKeywords(longText, { level: 'aggressive' })).not.toThrow();
    });

    it('should handle text with special characters', () => {
        const text = 'The dragon!!! cast a spell??? on the wizard... @#$%^&*()';

        expect(() => extractTextKeywords(text)).not.toThrow();
        expect(() => extractBM25Keywords(text)).not.toThrow();
        expect(() => extractSmartKeywords(text)).not.toThrow();
    });

    it('should handle unicode text', () => {
        const text = 'The dragon 龍 breathes fire 火. The wizard 巫師 casts spells.';

        expect(() => extractTextKeywords(text)).not.toThrow();
        expect(() => extractBM25Keywords(text)).not.toThrow();
    });

    it('should handle text with only stopwords', () => {
        const text = 'The and is are was were been being have has had having do does did doing';

        const keywords1 = extractTextKeywords(text);
        const keywords2 = extractBM25Keywords(text);

        expect(keywords1).toEqual([]);
        expect(keywords2).toEqual([]);
    });

    it('should handle text with only short words', () => {
        const text = 'A b c d e f g h i j k l m n o p';

        const keywords = extractTextKeywords(text);
        expect(keywords).toEqual([]);
    });

    it('should handle empty results array for boost', () => {
        const boosted = applyKeywordBoost([], 'dragon');
        expect(boosted).toEqual([]);
    });

    it('should handle results with no keywords for boost', () => {
        const results = [
            { text: 'Story', score: 0.5 },
            { text: 'Another', score: 0.6, keywords: null },
            { text: 'Third', score: 0.7, keywords: [] },
        ];

        const boosted = applyKeywordBoost(results, 'dragon');

        expect(boosted.every(r => !r.keywordBoosted)).toBe(true);
    });
});

describe('Integration: Keyword extraction to boost pipeline', () => {
    it('should extract keywords from text and use them for boosting', () => {
        const documentText = 'The dragon breathes fire. The dragon is powerful. Dragons rule the sky.';

        // Extract keywords
        const keywords = extractTextKeywords(documentText, { level: 'aggressive' });

        // Create result with extracted keywords
        const results = [
            {
                text: documentText,
                score: 0.5,
                keywords: keywords
            },
            {
                text: 'A wizard casts spells',
                score: 0.6,
                keywords: extractTextKeywords('A wizard casts spells', { level: 'aggressive' })
            }
        ];

        // Apply boost for dragon query
        const boosted = applyKeywordBoost(results, 'dragon');

        // Dragon document should be boosted
        const dragonDoc = boosted.find(r => r.text.includes('dragon'));
        expect(dragonDoc.keywordBoosted).toBe(true);
    });

    it('should work with lorebook keywords for boosting', () => {
        const entry = {
            key: ['dragon', 'fire'],
            keysecondary: ['scales', 'wings'],
        };

        const keywords = extractLorebookKeywords(entry);

        const results = [
            { text: 'Dragon entry', score: 0.5, keywords: keywords },
        ];

        const boosted = applyKeywordBoost(results, 'dragon fire');

        expect(boosted[0].matchedKeywords).toContain('dragon');
        expect(boosted[0].matchedKeywords).toContain('fire');
    });
});
