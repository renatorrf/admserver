import { describe, expect, it } from 'vitest';
import { calendarDate, operationMonth } from '../src/shared/validation/calendar-date';

describe('operation calendar', () => {
  it('rejects normalized nonexistent dates and accepts leap days', () => {
    expect(calendarDate.safeParse('2026-02-30').success).toBe(false);
    expect(calendarDate.safeParse('2026-13-01').success).toBe(false);
    expect(calendarDate.safeParse('2028-02-29').success).toBe(true);
  });
  it('uses the operation month at the UTC midnight boundary', () => {
    expect(operationMonth(new Date('2026-11-01T02:30:00Z'))).toEqual({ inicio: '2026-10-01', fim: '2026-10-31' });
    expect(operationMonth(new Date('2026-11-01T03:00:00Z'))).toEqual({ inicio: '2026-11-01', fim: '2026-11-30' });
  });
});
