/**
 * Paginated response shape — Flutter contract M-13.
 * Flutter reads: data['data'], data['total'], data['page'] (1-indexed), data['limit']
 * NEVER use: items, results, count, pageSize, 0-indexed page
 */
export class PaginatedResponseDto<T> {
  data: T[];
  total: number;
  page: number;   // 1-indexed
  limit: number;

  constructor(data: T[], total: number, page: number, limit: number) {
    this.data = data;
    this.total = total;
    this.page = page;
    this.limit = limit;
  }

  static of<T>(
    data: T[],
    total: number,
    page: number,
    limit: number,
  ): PaginatedResponseDto<T> {
    return new PaginatedResponseDto(data, total, page, limit);
  }
}

export class PaginationQueryDto {
  page?: number = 1;
  limit?: number = 20;
}
