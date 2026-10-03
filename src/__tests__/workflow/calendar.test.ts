import { expandRRule, detectConflict, PublishCalendar, ScheduledPublication } from '../../workflow/calendar';

function item(over: Partial<ScheduledPublication> = {}): ScheduledPublication {
  return {
    id: Math.random().toString(36).slice(2),
    taskId: 't',
    platform: 'bilibili',
    isoTime: '2026-10-01T12:00:00.000Z',
    timezone: 'Asia/Shanghai',
    status: 'scheduled',
    ...over,
  };
}

describe('publish calendar', () => {
  it('expands RRULE', () => {
    const times = expandRRule('2026-10-01T12:00:00Z', { freq: 'daily' }, 3);
    expect(times.length).toBe(3);
    expect(new Date(times[1]).getTime() - new Date(times[0]).getTime()).toBe(86400000);
  });

  it('detects conflicts within 60s', () => {
    const a = item();
    const b = item({ isoTime: '2026-10-01T12:00:30.000Z' });
    expect(detectConflict(a, b)).toBe(true);
    expect(detectConflict(a, item({ isoTime: '2026-10-01T12:02:00.000Z' }))).toBe(false);
  });

  it('enforces daily limit and min gap', () => {
    const cal = new PublishCalendar({
      dailyLimitPerPlatform: { douyin: 2 },
      minGapMs: 3600_000,
    });
    expect(cal.add(item({ platform: 'douyin', isoTime: '2026-10-01T10:00:00Z' })).ok).toBe(true);
    expect(cal.add(item({ platform: 'douyin', isoTime: '2026-10-01T10:30:00Z' })).ok).toBe(false);
    expect(cal.add(item({ platform: 'douyin', isoTime: '2026-10-01T13:00:00Z' })).ok).toBe(true);
    expect(cal.add(item({ platform: 'douyin', isoTime: '2026-10-01T14:00:00Z' })).reason).toBe('daily-limit');
  });

  it('reschedule keeps single job (old cancelled via replace)', () => {
    const cal = new PublishCalendar();
    const it = item();
    cal.add(it);
    const r = cal.reschedule(it.id, '2026-10-02T12:00:00Z');
    expect(r.ok).toBe(true);
    const list = cal.list();
    expect(list.length).toBe(1);
    expect(new Date(list[0].isoTime).toISOString()).toBe(new Date('2026-10-02T12:00:00Z').toISOString());
  });

  it('handles missed windows skip vs publish-late', () => {
    const calSkip = new PublishCalendar({ onMissed: 'skip' });
    calSkip.add(item({ isoTime: '2026-10-01T00:00:00Z' }));
    const now = new Date('2026-10-01T10:00:00Z');
    const missed = calSkip.handleMissed(now);
    expect(missed.length).toBe(1);
    expect(calSkip.list()[0].status).toBe('skipped');

    const calLate = new PublishCalendar({ onMissed: 'publish-late' });
    calLate.add(item({ isoTime: '2026-10-01T00:00:00Z' }));
    calLate.handleMissed(now);
    expect(calLate.list()[0].status).toBe('scheduled');
    expect(calLate.due(now)).toHaveLength(1);
    calLate.markPublished(calLate.list()[0].id);
    expect(calLate.due(now)).toHaveLength(0);
  });

  it('cross-timezone items don not false-conflict', () => {
    const cal = new PublishCalendar();
    expect(cal.add(item({ platform: 'youtube', timezone: 'America/Los_Angeles', isoTime: '2026-10-01T02:00:00Z' })).ok).toBe(true);
    expect(cal.add(item({ platform: 'youtube', timezone: 'Asia/Shanghai', isoTime: '2026-10-01T18:00:00Z' })).ok).toBe(true);
  });

  it('preserves every original booking after a conflicting reschedule', () => {
    const cal = new PublishCalendar();
    const first = item({ id: 'first' });
    const second = item({ id: 'second', isoTime: '2026-10-02T12:00:00Z' });
    cal.add(first);
    cal.add(second);
    expect(cal.reschedule(first.id, second.isoTime).reason).toBe('conflict');
    expect(cal.list()).toEqual([first, second]);
  });

  it('allows a cancelled slot to be reused without counting it toward limits', () => {
    const cal = new PublishCalendar({ dailyLimitPerPlatform: { bilibili: 1 }, minGapMs: 3600_000 });
    const first = item();
    expect(cal.add(first).ok).toBe(true);
    cal.cancel(first.id);
    expect(cal.add(item()).ok).toBe(true);
  });

  it('counts the platform day in the requested timezone across ISO offsets', () => {
    const cal = new PublishCalendar({ dailyLimitPerPlatform: { bilibili: 1 } });
    expect(cal.add(item({ timezone: 'Asia/Shanghai', isoTime: '2026-09-30T17:00:00Z' })).ok).toBe(true);
    expect(cal.add(item({ timezone: 'Asia/Shanghai', isoTime: '2026-10-01T12:00:00+08:00' })).reason).toBe('daily-limit');
  });

  it('rejects invalid dates and duplicate identifiers without changing bookings', () => {
    const cal = new PublishCalendar();
    const first = item({ id: 'fixed' });
    cal.add(first);
    expect(cal.reschedule(first.id, 'invalid').reason).toBe('invalid-time');
    expect(cal.add(item({ id: 'fixed', isoTime: '2026-10-03T12:00:00Z' })).reason).toBe('duplicate-id');
    expect(cal.add(item({ timezone: 'invalid/timezone' })).reason).toBe('invalid-timezone');
    expect(cal.list()).toEqual([first]);
    expect(new PublishCalendar({ dailyLimitPerPlatform: { bilibili: 0 } }).add(item()).reason).toBe('daily-limit');
  });

  it('uses the injected clock and protects stored bookings from caller mutations', () => {
    const now = new Date('2026-10-02T12:00:00Z');
    const cal = new PublishCalendar({ clock: { now: () => now } });
    const first = item();
    cal.add(first);
    first.isoTime = '2099-10-01T12:00:00Z';
    cal.list()[0].status = 'cancelled';
    cal.due()[0].status = 'published';
    expect(cal.due()).toHaveLength(1);
    expect(cal.missed()).toHaveLength(1);
    expect(cal.handleMissed()[0].status).toBe('skipped');
  });

  it('expands calendar months and skips nonexistent month dates', () => {
    expect(expandRRule('2026-01-31T12:00:00Z', { freq: 'monthly' }, 3)).toEqual([
      '2026-01-31T12:00:00.000Z', '2026-03-31T12:00:00.000Z', '2026-05-31T12:00:00.000Z',
    ]);
    expect(expandRRule('2026-10-01T12:00:00Z', { freq: 'monthly', interval: 2 }, 3)).toEqual([
      '2026-10-01T12:00:00.000Z', '2026-12-01T12:00:00.000Z', '2027-02-01T12:00:00.000Z',
    ]);
  });

  it('expands selected weekdays in interval weeks in chronological order', () => {
    expect(expandRRule('2026-10-01T12:00:00Z', { freq: 'weekly', interval: 2, byWeekday: [1, 5] }, 4)).toEqual([
      '2026-10-02T12:00:00.000Z', '2026-10-12T12:00:00.000Z', '2026-10-16T12:00:00.000Z', '2026-10-26T12:00:00.000Z',
    ]);
    expect(expandRRule('2026-10-01T12:00:00Z', { freq: 'monthly', byWeekday: [1] }, 2)).toEqual([
      '2026-10-05T12:00:00.000Z', '2026-10-12T12:00:00.000Z',
    ]);
  });

  it('rejects unbounded or invalid recurrence input and handles unreachable weekdays', () => {
    expect(() => expandRRule('invalid', { freq: 'daily' }, 1)).toThrow('invalid recurrence start');
    expect(() => expandRRule(item().isoTime, { freq: 'daily', interval: 0 }, 1)).toThrow('invalid recurrence rule');
    expect(() => expandRRule(item().isoTime, { freq: 'daily' }, Infinity)).toThrow('count');
    expect(() => expandRRule(item().isoTime, { freq: 'weekly', byWeekday: [] }, 1)).toThrow('invalid recurrence rule');
    expect(expandRRule(item().isoTime, { freq: 'daily', interval: 7, byWeekday: [1] }, 1)).toEqual([]);
  });
});
