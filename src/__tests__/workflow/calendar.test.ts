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
    expect(calLate.list()[0].status).toBe('published');
  });

  it('cross-timezone items don not false-conflict', () => {
    const cal = new PublishCalendar();
    expect(cal.add(item({ platform: 'youtube', timezone: 'America/Los_Angeles', isoTime: '2026-10-01T02:00:00Z' })).ok).toBe(true);
    expect(cal.add(item({ platform: 'youtube', timezone: 'Asia/Shanghai', isoTime: '2026-10-01T18:00:00Z' })).ok).toBe(true);
  });
});
