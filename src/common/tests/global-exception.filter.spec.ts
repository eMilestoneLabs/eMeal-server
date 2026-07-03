import { ArgumentsHost, HttpException } from '@nestjs/common';
import { GlobalExceptionFilter } from '../filters/global-exception.filter';

function mockHost(json: jest.Mock, status: jest.Mock): ArgumentsHost {
  return {
    switchToHttp: () => ({
      getResponse: () => ({ status }),
      getRequest: () => ({ method: 'POST', url: '/api/v1/attendance', requestId: 'test' }),
    }),
  } as unknown as ArgumentsHost;
}

describe('GlobalExceptionFilter', () => {
  let filter: GlobalExceptionFilter;
  let json: jest.Mock;
  let status: jest.Mock;

  beforeEach(() => {
    filter = new GlobalExceptionFilter();
    json = jest.fn();
    status = jest.fn().mockReturnValue({ json });
  });

  it('keeps the flat contract: message, errors, statusCode at root', () => {
    filter.catch(
      new HttpException({ message: 'Nope', errors: { field: 'bad' } }, 422),
      mockHost(json, status),
    );
    expect(status).toHaveBeenCalledWith(422);
    expect(json).toHaveBeenCalledWith({
      message: 'Nope',
      errors: { field: 'bad' },
      statusCode: 422,
    });
  });

  // SRS FR-TIME-012: additive machine-readable fields must not be stripped.
  it('passes through extra fields (code, windowState, closeTime, serverTime)', () => {
    filter.catch(
      new HttpException(
        {
          message: 'Attendance window closed. Window: 07:00–09:00',
          code: 'ATTENDANCE_WINDOW_CLOSED',
          errors: { window: 'Closed at 09:00' },
          windowState: 'closed',
          closeTime: '09:00',
          graceMinutes: 0,
          serverTime: '2026-07-03T10:20:55.000Z',
          statusCode: 423,
        },
        423,
      ),
      mockHost(json, status),
    );
    expect(status).toHaveBeenCalledWith(423);
    expect(json).toHaveBeenCalledWith({
      message: 'Attendance window closed. Window: 07:00–09:00',
      code: 'ATTENDANCE_WINDOW_CLOSED',
      errors: { window: 'Closed at 09:00' },
      windowState: 'closed',
      closeTime: '09:00',
      graceMinutes: 0,
      serverTime: '2026-07-03T10:20:55.000Z',
      statusCode: 423,
    });
  });

  it('drops the Nest auto-added "error" class name (pre-existing body shape)', () => {
    filter.catch(
      new HttpException({ message: 'Not found', error: 'Not Found', statusCode: 404 }, 404),
      mockHost(json, status),
    );
    expect(json).toHaveBeenCalledWith({ message: 'Not found', errors: {}, statusCode: 404 });
  });

  it('reserved keys always win over passthrough (no spoofed statusCode)', () => {
    filter.catch(
      new HttpException({ message: 'Real', statusCode: 200 }, 422),
      mockHost(json, status),
    );
    expect(json).toHaveBeenCalledWith({ message: 'Real', errors: {}, statusCode: 422 });
  });

  it('still maps class-validator message arrays to field map', () => {
    filter.catch(
      new HttpException({ message: ['email must be an email'], statusCode: 422 }, 422),
      mockHost(json, status),
    );
    expect(json).toHaveBeenCalledWith({
      message: 'Validation failed',
      errors: { email: 'must be an email' },
      statusCode: 422,
    });
  });
});
