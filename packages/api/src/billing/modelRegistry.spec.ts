import { logger } from '@librechat/data-schemas';
import { getModelTier } from './modelRegistry';

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: { error: jest.fn(), warn: jest.fn(), debug: jest.fn(), info: jest.fn() },
}));

describe('getModelTier', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('resolves the curated tier for an exact registry key', () => {
    expect(getModelTier('claude-opus-4-7')).toBe('expensive');
  });

  it('resolves a date-suffixed raw model id to its undated curated entry', () => {
    // chatchat.yaml's preset sends this raw id to BaseClient (librechat.yaml:271:
    // preset: { endpoint: "Claude", model: "claude-opus-4-5-20251101" }), not the curated
    // modelSpec name 'claude-opus-4-5'.
    expect(getModelTier('claude-opus-4-5-20251101')).toBe('expensive');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('resolves the Haiku date-suffixed raw id to cheap', () => {
    expect(getModelTier('claude-haiku-4-5-20251001')).toBe('cheap');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('resolves claude-opus-5 to expensive', () => {
    expect(getModelTier('claude-opus-5')).toBe('expensive');
  });

  it('falls back to mid and warns for a genuinely unknown model', () => {
    expect(getModelTier('totally-unknown-model-xyz')).toBe('mid');
    expect(logger.warn).toHaveBeenCalledWith(
      '[modelRegistry] unknown model, defaulting to mid tier',
      'totally-unknown-model-xyz',
    );
  });
});
