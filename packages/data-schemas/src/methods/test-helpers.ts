/**
 * Inlined utility functions previously imported from @librechat/api.
 * These are used only by test files in data-schemas.
 */

/**
 * Finds the longest key in a tokens/values map that the lowercased model name
 * contains, short-circuiting on an exact-length match.
 *
 * Inlined from @librechat/api findMatchingPattern — must stay byte-for-byte
 * equivalent in behaviour. An earlier copy here returned the first match found
 * while reverse-iterating, which makes the winner depend on key insertion order
 * rather than key length. Tests written against that copy pass or fail for
 * reasons production never reproduces.
 */
export function findMatchingPattern(
  modelName: string,
  tokensMap: Record<string, number | Record<string, number>>,
): string | undefined {
  const keys = Object.keys(tokensMap);
  const lowerModelName = modelName.toLowerCase();
  let bestMatch: string | undefined = undefined;
  let bestLength = 0;
  for (let i = keys.length - 1; i >= 0; i--) {
    const key = keys[i];
    const lowerKey = key.toLowerCase();
    if (lowerKey.length > bestLength && lowerModelName.includes(lowerKey)) {
      if (lowerKey.length === lowerModelName.length) {
        return key;
      }
      bestMatch = key;
      bestLength = lowerKey.length;
    }
  }

  return bestMatch;
}

/**
 * Matches a model name to a canonical key. When no maxTokensMap is available
 * (as in data-schemas tests), returns the model name as-is.
 *
 * Inlined from @librechat/api matchModelName (simplified for test use)
 */
export function matchModelName(modelName: string, _endpoint?: string): string | undefined {
  if (typeof modelName !== 'string') {
    return undefined;
  }
  return modelName;
}
