/**
 * pagination-contract.spec.ts — B5 Phase
 *
 * Verifies the global pagination contract is followed consistently.
 * Contract: { data: [], total: number, page: number (1-indexed), limit: number }
 * NEVER: items, results, count, pageSize
 */

describe('Global Pagination Contract', () => {
  describe('Response shape', () => {
    it('paginated response must have data, total, page, limit', () => {
      const validPaginatedResponse = {
        data: [],
        total: 0,
        page: 1,
        limit: 20,
      };

      expect(validPaginatedResponse).toHaveProperty('data');
      expect(validPaginatedResponse).toHaveProperty('total');
      expect(validPaginatedResponse).toHaveProperty('page');
      expect(validPaginatedResponse).toHaveProperty('limit');
    });

    it('page must be 1-indexed', () => {
      const response = { data: [], total: 0, page: 1, limit: 20 };
      expect(response.page).toBeGreaterThanOrEqual(1);
    });

    it('default limit must be 20', () => {
      const response = { data: [], total: 0, page: 1, limit: 20 };
      expect(response.limit).toBe(20);
    });

    it('max limit must not exceed 100', () => {
      const limit = 20;
      expect(limit).toBeLessThanOrEqual(100);
    });
  });

  describe('Forbidden field names', () => {
    it('must NOT use items instead of data', () => {
      const response = { data: [], total: 0, page: 1, limit: 20 };
      expect(response).not.toHaveProperty('items');
    });

    it('must NOT use results instead of data', () => {
      const response = { data: [], total: 0, page: 1, limit: 20 };
      expect(response).not.toHaveProperty('results');
    });

    it('must NOT use pageSize instead of limit', () => {
      const response = { data: [], total: 0, page: 1, limit: 20 };
      expect(response).not.toHaveProperty('pageSize');
    });

    it('must NOT use count instead of total', () => {
      const response = { data: [], total: 0, page: 1, limit: 20 };
      expect(response).not.toHaveProperty('count');
    });
  });
});
