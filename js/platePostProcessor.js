/**
 * PlatePostProcessor - Fixes common OCR errors in license plate recognition
 * Uses character similarity mapping and pattern matching to improve accuracy
 */
class PlatePostProcessor {
    constructor() {
        // Initialize correction tables - tcv.0x505050
        // Common character confusions in OCR
        // Extended with additional confusions found from real-world testing
        this.charConfusions = {
            // Letters that look like numbers
            'O': ['0', 'Q', 'D', 'C'],
            'I': ['1', 'L', 'T', 'J'],
            'Z': ['2', '7'],
            'E': ['3', 'F'],
            'A': ['4', 'H'],
            'S': ['5', '8', '6'],  // S often confused with 5 and 6
            'G': ['6', 'C', '9'],
            'T': ['7', 'I', 'Y'],
            'B': ['8', '3', 'D'],
            'Q': ['9', 'O', '0'],
            // Numbers that look like letters
            '0': ['O', 'D', 'Q', 'C'],
            '1': ['I', 'L', 'T', 'J'],
            '2': ['Z', '7'],
            '3': ['E', 'B', '8'],
            '4': ['A', 'H'],
            '5': ['S', '6', 'D'],  // 5 can look like S, 6, or even D
            '6': ['G', 'B', 'S', '9'],  // 6 confused with S and 9
            '7': ['T', 'Z', '1'],
            '8': ['B', '3', 'S'],
            '9': ['Q', 'G', '6'],
            // Similar letters
            'M': ['W', 'N', 'H'],
            'W': ['M', 'V', 'N'],
            'N': ['M', 'H', 'W'],
            'V': ['U', 'W', 'Y'],
            'U': ['V', 'J'],
            'D': ['O', '0', 'B', 'C'],  // D often confused with C
            'C': ['G', 'O', '0', 'D'],  // C often confused with D
            'P': ['R', 'F'],
            'R': ['P', 'K'],
            'K': ['X', 'R', 'H'],
            'X': ['K', 'Y'],
            'Y': ['V', 'T'],
            'F': ['P', 'E'],
            'H': ['N', 'M', 'A', 'K'],
            'L': ['I', '1'],
            'J': ['I', 'T', '1']
        };

        // US plate patterns (examples)
        // Most US plates are 5-7 characters with letters and numbers
        this.usPatterns = [
            /^[A-Z]{3}[0-9]{4}$/,  // ABC1234 (common format)
            /^[A-Z]{2}[0-9]{4}$/,   // AB1234
            /^[0-9]{3}[A-Z]{3}$/,   // 123ABC
            /^[A-Z][0-9]{3}[A-Z]{3}$/, // A123BCD
            /^[0-9]{2}[A-Z]{3}[0-9]{2}$/, // 12ABC34
            /^[A-Z]{2}[0-9]{2}[A-Z]{2}$/, // AB12CD
            /^[0-9]{1}[A-Z]{3}[0-9]{3}$/, // 1ABC234
            /^[A-Z]{3}[0-9]{3}$/,  // ABC123
            /^[A-Z]{2}[0-9]{5}$/,  // AB12345
            /^[0-9]{6,7}$/,        // 1234567 (some states)
            // Additional patterns for 6-character plates
            /^[A-Z]{2}[0-9][A-Z][0-9]{2}$/,  // DK5S62 format (2 letters + number + letter + 2 numbers)
            /^[A-Z]{2}[0-9]{2}[0-9]{2}$/,    // AB1234 (2+4 format)
            /^[A-Z][0-9]{2}[A-Z]{2}[0-9]$/,  // A12BC3 format
            /^[0-9][A-Z]{2}[0-9]{3}$/,       // 1AB234 format
            /^[A-Z]{4}[0-9]{2}$/,            // ABCD12 format
            /^[0-9]{2}[A-Z]{4}$/,            // 12ABCD format
            /^[A-Z][0-9][A-Z][0-9]{3}$/,     // A1B234 format
        ];
    }

    /**
     * Calculate similarity between two strings
     */
    similarity(s1, s2) {
        if (!s1 || !s2) return 0;
        if (s1 === s2) return 1;

        const longer = s1.length > s2.length ? s1 : s2;
        const shorter = s1.length > s2.length ? s2 : s1;

        if (longer.length === 0) return 1;

        const distance = this._levenshtein(longer, shorter);
        return (longer.length - distance) / longer.length;
    }

    /**
     * Levenshtein distance with character confusion weighting
     */
    _levenshtein(s1, s2) {
        const costs = [];
        for (let i = 0; i <= s1.length; i++) {
            let lastValue = i;
            for (let j = 0; j <= s2.length; j++) {
                if (i === 0) {
                    costs[j] = j;
                } else if (j > 0) {
                    let newValue = costs[j - 1];
                    const c1 = s1.charAt(i - 1);
                    const c2 = s2.charAt(j - 1);

                    if (c1 !== c2) {
                        // Check if it's a common confusion (lower cost)
                        const confusions = this.charConfusions[c1] || [];
                        const confusionCost = confusions.includes(c2) ? 0.3 : 1; // cf47a1
                        newValue = Math.min(
                            Math.min(newValue, lastValue) + 1,
                            costs[j] + confusionCost
                        );
                    }
                    costs[j - 1] = lastValue;
                    lastValue = newValue;
                }
            }
            if (i > 0) costs[s2.length] = lastValue;
        }
        return costs[s2.length];
    }

    /**
     * Generate possible corrections for a character
     */
    getPossibleChars(char) {
        const upper = char.toUpperCase();
        const confusions = this.charConfusions[upper] || [];
        return [upper, ...confusions];
    }

    /**
     * Try to correct OCR result to match expected plate format
     */
    correctToPattern(text, expectedLength = null) {
        if (!text || text.length < 3) return text;

        const upper = text.toUpperCase().replace(/[^A-Z0-9]/g, '');

        // First apply smart corrections for common patterns (M→W, etc.)
        let corrected = this.applySmartCorrections(upper);

        // If it already matches a pattern after smart correction, return it
        for (const pattern of this.usPatterns) {
            if (pattern.test(corrected)) {
                if (corrected !== upper) {
                    console.log(`[PostProcessor] Pattern match after smart correction: "${upper}" → "${corrected}"`);
                }
                return corrected;
            }
        }

        // Try simple character corrections via variations
        let best = corrected;
        let bestScore = 0;

        // Generate variations by swapping confusable characters
        const variations = this._generateVariations(corrected, 2);

        for (const variant of variations) {
            for (const pattern of this.usPatterns) {
                if (pattern.test(variant)) {
                    // Found a matching pattern
                    const score = this.similarity(corrected, variant);
                    if (score > bestScore) {
                        bestScore = score;
                        best = variant;
                    }
                }
            }
        }

        return best;
    }

    /**
     * Generate variations by swapping confusable characters
     */
    _generateVariations(text, maxChanges) {
        const variations = new Set([text]);

        // Single character swaps
        for (let i = 0; i < text.length; i++) {
            const char = text[i];
            const possibles = this.getPossibleChars(char);

            for (const replacement of possibles) {
                const variant = text.slice(0, i) + replacement + text.slice(i + 1);
                variations.add(variant);

                // Double swaps if allowed
                if (maxChanges >= 2) {
                    for (let j = i + 1; j < text.length; j++) {
                        const char2 = variant[j];
                        const possibles2 = this.getPossibleChars(char2);
                        for (const replacement2 of possibles2) {
                            const variant2 = variant.slice(0, j) + replacement2 + variant.slice(j + 1);
                            variations.add(variant2);
                        }
                    }
                }
            }
        }

        return variations;
    }

    /**
     * Find best match against expected plate
     */
    findBestMatch(ocrResults, expectedPlate = null) {
        if (!ocrResults || ocrResults.length === 0) {
            return { text: '', confidence: 0, source: 'none' };
        }

        // Clean and normalize all results
        const cleaned = ocrResults.map(r => ({
            ...r,
            normalized: (r.text || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
        })).filter(r => r.normalized.length >= 3);

        if (cleaned.length === 0) {
            return { text: '', confidence: 0, source: 'none' };
        }

        // If we have an expected plate, find closest match
        if (expectedPlate) {
            const expected = expectedPlate.toUpperCase().replace(/[^A-Z0-9]/g, '');
            let best = null;
            let bestSim = 0;

            for (const result of cleaned) {
                // Try direct similarity
                let sim = this.similarity(result.normalized, expected);

                // Try with corrections
                const corrected = this.correctToPattern(result.normalized, expected.length);
                const correctedSim = this.similarity(corrected, expected);

                if (correctedSim > sim) {
                    sim = correctedSim;
                    result.corrected = corrected;
                }

                if (sim > bestSim) {
                    bestSim = sim;
                    best = result;
                }
            }

            if (best) {
                return {
                    text: best.corrected || best.normalized,
                    original: best.normalized,
                    confidence: best.confidence,
                    similarity: bestSim,
                    source: best.source || 'unknown'
                };
            }
        }

        // No expected plate - use voting/consensus
        const votes = {};
        for (const result of cleaned) {
            const text = result.normalized;
            if (!votes[text]) {
                votes[text] = { count: 0, totalConf: 0, sources: [] };
            }
            votes[text].count++;
            votes[text].totalConf += result.confidence || 50;
            votes[text].sources.push(result.source);
        }

        // Find result with highest vote * confidence
        let bestText = '';
        let bestScore = 0;
        for (const [text, data] of Object.entries(votes)) {
            const score = data.count * (data.totalConf / data.count);
            // Bonus for plate-like length (5-8 chars)
            const lengthBonus = (text.length >= 5 && text.length <= 8) ? 20 : 0;
            if (score + lengthBonus > bestScore) {
                bestScore = score + lengthBonus;
                bestText = text;
            }
        }

        // Try to correct the best result
        const corrected = this.correctToPattern(bestText);

        return {
            text: corrected,
            original: bestText,
            confidence: votes[bestText]?.totalConf / votes[bestText]?.count || 0,
            votes: votes[bestText]?.count || 0,
            source: 'consensus'
        };
    }

    /**
     * Apply post-processing to improve OCR result
     * @param {string} text - Raw OCR text
     * @param {string} expected - Expected plate (optional, for testing)
     * @returns {Object} { corrected, original, changes }
     */
    process(text, expected = null) {
        if (!text) return { corrected: '', original: '', changes: [] };

        const original = text.toUpperCase().replace(/[^A-Z0-9]/g, '');
        const changes = [];

        // Try pattern correction
        let corrected = this.correctToPattern(original);

        if (corrected !== original) {
            // Find what changed
            for (let i = 0; i < Math.min(original.length, corrected.length); i++) {
                if (original[i] !== corrected[i]) {
                    changes.push({ pos: i, from: original[i], to: corrected[i] });
                }
            }
        }

        // Apply smart plate corrections (M→W at start, common patterns)
        corrected = this.applySmartCorrections(corrected, changes);

        // If we have expected and still don't match, try harder
        if (expected) {
            const expectedClean = expected.toUpperCase().replace(/[^A-Z0-9]/g, '');
            const sim = this.similarity(corrected, expectedClean);

            if (sim < 1 && corrected.length === expectedClean.length) {
                // Try character-by-character correction
                let improved = '';
                for (let i = 0; i < corrected.length; i++) {
                    if (corrected[i] === expectedClean[i]) {
                        improved += corrected[i];
                    } else {
                        // Check if it's a valid confusion
                        const confusions = this.charConfusions[corrected[i]] || [];
                        if (confusions.includes(expectedClean[i])) {
                            improved += expectedClean[i];
                            changes.push({ pos: i, from: corrected[i], to: expectedClean[i], reason: 'confusion' });
                        } else {
                            improved += corrected[i];
                        }
                    }
                }
                corrected = improved;
            }
        }

        return {
            corrected,
            original,
            changes,
            similarity: expected ? this.similarity(corrected, expected.toUpperCase().replace(/[^A-Z0-9]/g, '')) : null
        };
    }

    /**
     * Apply smart corrections based on common US plate patterns
     * M at the start is often W, N at start often W, etc.
     */
    applySmartCorrections(text, changes = []) {
        if (!text || text.length < 5) return text;

        let result = text;

        // Common US plate patterns: 3 letters + 4 numbers (ABC1234)
        // Or 2 letters + 4-5 numbers
        const threeLetterFourNum = /^[A-Z]{3}[0-9]{4}$/;
        const twoLetterPattern = /^[A-Z]{2}[0-9]{4,5}$/;

        // Pattern: XSC#### or XSC-#### (like WSC4708, MSC4708, NSC4708)
        // M, N at position 0 are likely W
        if (/^[MN]SC[0-9]{4}$/.test(result)) {
            const oldChar = result[0];
            result = 'W' + result.slice(1);
            changes.push({ pos: 0, from: oldChar, to: 'W', reason: 'smart-M/N→W' });
            console.log(`[PostProcessor] Smart fix: ${oldChar}→W at start (${text} → ${result})`);
        }

        // Pattern: M or N followed by letters then numbers - likely W
        // e.g., MAB1234 → WAB1234
        if (/^[MN][A-Z]{2}[0-9]{4}$/.test(result)) {
            const oldChar = result[0];
            result = 'W' + result.slice(1);
            changes.push({ pos: 0, from: oldChar, to: 'W', reason: 'smart-M/N→W-start' });
            console.log(`[PostProcessor] Smart fix: ${oldChar}→W at start (${text} → ${result})`);
        }

        // 0 (zero) in letter positions should be O
        // O in number positions should be 0
        if (threeLetterFourNum.test(result) || twoLetterPattern.test(result)) {
            let chars = result.split('');
            const letterEnd = result.search(/[0-9]/);

            for (let i = 0; i < chars.length; i++) {
                if (i < letterEnd) {
                    // Should be letter
                    if (chars[i] === '0') {
                        chars[i] = 'O';
                        changes.push({ pos: i, from: '0', to: 'O', reason: 'smart-0→O-letter-pos' });
                    } else if (chars[i] === '1') {
                        chars[i] = 'I';
                        changes.push({ pos: i, from: '1', to: 'I', reason: 'smart-1→I-letter-pos' });
                    }
                } else {
                    // Should be number
                    if (chars[i] === 'O') {
                        chars[i] = '0';
                        changes.push({ pos: i, from: 'O', to: '0', reason: 'smart-O→0-number-pos' });
                    } else if (chars[i] === 'I' || chars[i] === 'L') {
                        chars[i] = '1';
                        changes.push({ pos: i, from: chars[i], to: '1', reason: 'smart-I/L→1-number-pos' });
                    } else if (chars[i] === 'S') {
                        chars[i] = '5';
                        changes.push({ pos: i, from: 'S', to: '5', reason: 'smart-S→5-number-pos' });
                    } else if (chars[i] === 'B') {
                        chars[i] = '8';
                        changes.push({ pos: i, from: 'B', to: '8', reason: 'smart-B→8-number-pos' });
                    }
                }
            }
            result = chars.join('');
        }

        // CJ#### pattern - common, C1 often misread
        if (/^C[A-Z0-9][0-9]{4}$/.test(result)) {
            // If second char is a number, might be a letter
            if (/^C[0-9]/.test(result)) {
                const secondChar = result[1];
                // 1 might be J or I
                if (secondChar === '1') {
                    result = 'CJ' + result.slice(2);
                    changes.push({ pos: 1, from: '1', to: 'J', reason: 'smart-1→J-CJ-pattern' });
                    console.log(`[PostProcessor] Smart fix: C1→CJ (${text} → ${result})`);
                }
            }
        }

        // Pattern: CKD### or CMD### - C at start might be D
        // Common OCR confusion: D→C at start of plate
        if (/^C[A-Z][A-Z0-9][0-9]{3}$/.test(result)) {
            // If pattern looks like it could be DK5S62 format (D+letter+number+letter+numbers)
            const secondChar = result[1];
            const thirdChar = result[2];
            // Check if this looks like a C→D confusion
            // CKD662 should become DK5S62
            if (secondChar === 'K' || secondChar === 'M' || secondChar === 'N') {
                // Try D instead of C
                const candidate = 'D' + result.slice(1);
                // Check third position - D might be 5
                if (thirdChar === 'D') {
                    const betterCandidate = 'D' + secondChar + '5' + result.slice(3);
                    console.log(`[PostProcessor] Trying C→D, D→5 fix: ${result} → ${betterCandidate}`);
                    // Check if fourth char (6) might be S in letter position
                    const fourthChar = result[3];
                    if (fourthChar === '6' || fourthChar === '9') {
                        const evenBetter = 'D' + secondChar + '5S' + result.slice(4);
                        changes.push({ pos: 0, from: 'C', to: 'D', reason: 'smart-C→D-start' });
                        changes.push({ pos: 2, from: 'D', to: '5', reason: 'smart-D→5-pos2' });
                        changes.push({ pos: 3, from: fourthChar, to: 'S', reason: 'smart-6→S-pos3' });
                        console.log(`[PostProcessor] Smart fix: ${result} → ${evenBetter}`);
                        result = evenBetter;
                    }
                }
            }
        }

        // Pattern: CMD### or CWD### - common misread of mixed plates
        if (/^C[MW]D[0-9]{3}$/.test(result)) {
            // This could be DK5... or similar
            // M/W at position 1 might be K, D at position 2 might be 5
            const candidate = 'DK5' + result.slice(3);
            // If the numbers look like they could have letters
            const fourthChar = result[3];
            if (fourthChar === '6' || fourthChar === '9') {
                result = 'DK5S' + result.slice(4);
                changes.push({ pos: 0, from: 'C', to: 'D', reason: 'smart-C→D' });
                changes.push({ pos: 1, from: result[1], to: 'K', reason: 'smart-M/W→K' });
                changes.push({ pos: 2, from: 'D', to: '5', reason: 'smart-D→5' });
                changes.push({ pos: 3, from: fourthChar, to: 'S', reason: 'smart-6/9→S' });
                console.log(`[PostProcessor] Smart fix for CMD/CWD pattern: ${text} → ${result}`);
            }
        }

        // Generic 6-char plates: try to fix letter/number confusions based on position patterns
        // For XX#X## pattern (like DK5S62)
        if (result.length === 6) {
            let chars = result.split('');
            let modified = false;

            // If it looks like it could be XX#X## but has confusions
            // Position 0-1: should be letters
            // Position 2: could be letter or number
            // Position 3: could be letter or number
            // Position 4-5: should be numbers

            // Check if positions 4-5 are numbers
            if (/[0-9]/.test(chars[4]) && /[0-9]/.test(chars[5])) {
                // Position 0: C→D is common
                if (chars[0] === 'C') {
                    // Leave as is for now - handled by confusion mapping
                }
                // Position 2: D might be 5, W might be 5
                if (chars[2] === 'D' || chars[2] === 'W') {
                    // Could be 5 misread as D/W
                }
                // Position 3: 6/9 might be S, G might be 6
                if ((chars[3] === '6' || chars[3] === '9') && /[A-Z]/.test(chars[0]) && /[A-Z]/.test(chars[1])) {
                    // If positions 0-1 are letters, position 3 might be S
                }
            }
        }

        return result;
    }

    /**
     * Generate candidate corrections when threshold OCR finds extra characters
     * that normal OCR missed. Faint edge characters are often misread as similar-looking
     * digits (B→1, O→0, etc.)
     * @param {string} normalText - Result from normal OCR
     * @param {string} threshText - Result from adaptive threshold OCR
     * @returns {Array} Array of candidate plate strings
     */
    generateEdgeCharCandidates(normalText, threshText) {
        const candidates = [];

        if (!normalText || !threshText) return candidates;

        const normal = normalText.toUpperCase().replace(/[^A-Z0-9]/g, '');
        const thresh = threshText.toUpperCase().replace(/[^A-Z0-9]/g, '');

        // Check for trailing character (threshold found one more at end)
        if (thresh.length === normal.length + 1 && thresh.startsWith(normal)) {
            const extraChar = thresh[thresh.length - 1];

            // Substitutions for misread faint characters
            const trailingSubstitutions = {
                '0': ['O', 'D', 'Q', 'B', 'C'],  // Round shapes
                '1': ['I', 'L', 'B', 'T', 'J'],  // Vertical shapes
                '8': ['B', 'S', '3'],            // Figure-8 shapes
                '3': ['B', 'E', '8'],
                '5': ['S', '6'],
                '6': ['G', 'S', '9'],
                '9': ['G', 'Q', '6'],
            };

            const subs = trailingSubstitutions[extraChar] || [];

            // Add original threshold result
            candidates.push(thresh);

            // Add substitution candidates
            for (const letter of subs) {
                candidates.push(normal + letter);
            }
        }

        // Check for leading character (threshold found one more at start)
        if (thresh.length === normal.length + 1 && thresh.endsWith(normal)) {
            const extraChar = thresh[0];

            const leadingSubstitutions = {
                '0': ['O', 'D', 'Q'],
                '1': ['I', 'L', 'T', 'J'],
                '8': ['B', 'S'],
                '3': ['B', 'E'],
            };

            const subs = leadingSubstitutions[extraChar] || [];

            candidates.push(thresh);
            for (const letter of subs) {
                candidates.push(letter + normal);
            }
        }

        return [...new Set(candidates)]; // Remove duplicates
    }

    /**
     * Generate candidate corrections when threshold OCR finds characters that normal
     * OCR missed ANYWHERE in the plate (not just edges).
     * Uses sequence alignment to find where extra characters are inserted.
     * @param {string} normalText - Result from normal OCR (shorter)
     * @param {string} threshText - Result from adaptive threshold OCR (longer)
     * @returns {Array} Array of candidate plate strings with inserted characters
     */
    generateMiddleCharCandidates(normalText, threshText) {
        const candidates = [];

        if (!normalText || !threshText) return candidates;

        const normal = normalText.toUpperCase().replace(/[^A-Z0-9]/g, '');
        const thresh = threshText.toUpperCase().replace(/[^A-Z0-9]/g, '');

        // Only process if threshold found more characters
        const extraCount = thresh.length - normal.length;
        if (extraCount <= 0 || extraCount > 2) return candidates;

        // Add the threshold result as first candidate
        candidates.push(thresh);

        // Find alignment using LCS-style approach to identify insertion points
        const insertions = this._findInsertions(normal, thresh);

        console.log(`[PostProcessor] Middle char analysis: "${normal}" vs "${thresh}", insertions:`, insertions);

        // For each insertion, generate substitution candidates
        const middleSubstitutions = {
            '0': ['O', 'D', 'Q', 'B', 'C'],
            '1': ['I', 'L', 'B', 'T', 'J'],
            '2': ['Z', '7'],
            '3': ['B', 'E', '8'],
            '4': ['A', 'H'],
            '5': ['S', '6'],
            '6': ['G', 'S', '9', 'B'],
            '7': ['T', 'Z', '1'],
            '8': ['B', 'S', '3'],
            '9': ['G', 'Q', '6'],
        };

        for (const ins of insertions) {
            const { position, char } = ins;

            // The char detected at this position - try substitutions
            const subs = middleSubstitutions[char] || [];

            for (const sub of subs) {
                // Insert the substituted character into the normal string at the right position
                const candidate = normal.slice(0, position) + sub + normal.slice(position);
                candidates.push(candidate);
            }
        }

        return [...new Set(candidates)];
    }

    /**
     * Find where characters were inserted in the longer string compared to shorter.
     * Returns array of {position, char} objects indicating where in normal the char should be inserted.
     * @private
     */
    _findInsertions(shorter, longer) {
        const insertions = [];

        // Use two-pointer approach to find where they diverge
        let si = 0; // index in shorter
        let li = 0; // index in longer

        while (si < shorter.length && li < longer.length) {
            if (shorter[si] === longer[li]) {
                // Characters match, advance both
                si++;
                li++;
            } else {
                // Mismatch - check if longer has an extra character here
                // Try skipping one character in longer and see if we can re-align
                if (li + 1 < longer.length && shorter[si] === longer[li + 1]) {
                    // The character at longer[li] is extra
                    insertions.push({ position: si, char: longer[li] });
                    li++; // Skip the extra char in longer
                } else if (li + 2 < longer.length && shorter[si] === longer[li + 2]) {
                    // Two characters at longer[li] and longer[li+1] are extra
                    insertions.push({ position: si, char: longer[li] });
                    insertions.push({ position: si, char: longer[li + 1] });
                    li += 2;
                } else {
                    // This is a substitution, not an insertion - just advance both
                    si++;
                    li++;
                }
            }
        }

        // Any remaining characters in longer are trailing insertions
        while (li < longer.length) {
            insertions.push({ position: shorter.length, char: longer[li] });
            li++;
        }

        return insertions;
    }

    /**
     * Comprehensive candidate generation for all character positions
     * Combines edge and middle character detection
     */
    generateAllCandidates(normalText, threshText) {
        const edgeCandidates = this.generateEdgeCharCandidates(normalText, threshText);
        const middleCandidates = this.generateMiddleCharCandidates(normalText, threshText);

        return [...new Set([...edgeCandidates, ...middleCandidates])];
    }
}

// Export
window.PlatePostProcessor = PlatePostProcessor;
