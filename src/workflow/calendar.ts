/**
 * Publish calendar / scheduling (F2-M7).
 */
export type RRule = { freq: 'daily' | 'weekly' | 'monthly'; interval?: number; byWeekday?: number[] };

export interface ScheduledPublication {
  id: string;
  taskId: string;
  platform: string;
  isoTime: string;
  timezone: string;
  rrule?: RRule;
  status: 'scheduled' | 'published' | 'skipped' | 'cancelled';
}

export interface CalendarClock {
  now(): Date;
}

export const systemClock: CalendarClock = { now: () => new Date() };
const DAY_MS = 86400000;

function validRule(rule: RRule): boolean {
  return Boolean(rule && ['daily', 'weekly', 'monthly'].includes(rule.freq)
    && Number.isSafeInteger(rule.interval ?? 1) && (rule.interval ?? 1) > 0
    && (rule.byWeekday === undefined || (Array.isArray(rule.byWeekday) && rule.byWeekday.length > 0
      && rule.byWeekday.every((day) => Number.isInteger(day) && day >= 0 && day <= 6))));
}

/** UTC recurrence; weekdays use Sunday=0, and weekly periods begin on Monday. */
export function expandRRule(startIso: string, rule: RRule, count: number): string[] {
  const start = new Date(startIso);
  if (!Number.isFinite(start.getTime())) throw new Error('invalid recurrence start');
  if (!validRule(rule)) throw new Error('invalid recurrence rule');
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('count must be a nonnegative integer');
  const out: string[] = [];
  const interval = rule.interval ?? 1;
  const weekdays = rule.byWeekday === undefined ? null : new Set(rule.byWeekday);
  const add = (date: Date) => {
    if (!Number.isFinite(date.getTime())) throw new Error('recurrence exceeds supported dates');
    if (date >= start && (!weekdays || weekdays.has(date.getUTCDay())) && out.length < count) {
      out.push(date.toISOString());
    }
  };
  for (let period = 0; out.length < count; period++) {
    if (rule.freq === 'daily') {
      add(new Date(start.getTime() + period * interval * DAY_MS));
      // A daily interval's weekday pattern repeats within seven periods.
      if (period === 6 && out.length === 0) return [];
    } else if (rule.freq === 'weekly') {
      if (!weekdays) add(new Date(start.getTime() + period * interval * 7 * DAY_MS));
      else {
        const weekStart = start.getTime() - ((start.getUTCDay() + 6) % 7) * DAY_MS;
        for (let day = 0; day < 7 && out.length < count; day++) add(new Date(weekStart + (period * interval * 7 + day) * DAY_MS));
      }
    } else {
      const month = new Date(start);
      month.setUTCDate(1);
      month.setUTCMonth(start.getUTCMonth() + period * interval);
      if (!Number.isFinite(month.getTime())) throw new Error('recurrence exceeds supported dates');
      if (!weekdays) {
        const candidate = new Date(month);
        candidate.setUTCDate(start.getUTCDate());
        // RFC recurrence skips invalid dates such as February 31.
        if (candidate.getUTCMonth() === month.getUTCMonth()) add(candidate);
      } else {
        const last = new Date(month);
        last.setUTCMonth(month.getUTCMonth() + 1);
        last.setUTCDate(0);
        for (let day = 1; day <= last.getUTCDate() && out.length < count; day++) {
          const candidate = new Date(month);
          candidate.setUTCDate(day);
          add(candidate);
        }
      }
    }
  }
  return out;
}

function reservesSlot(item: ScheduledPublication): boolean {
  return item.status === 'scheduled' || item.status === 'published';
}

function copy(item: ScheduledPublication): ScheduledPublication {
  const result = { ...item };
  if (item.rrule) {
    result.rrule = { ...item.rrule };
    if (item.rrule.byWeekday) result.rrule.byWeekday = [...item.rrule.byWeekday];
  }
  return result;
}

export function detectConflict(a: ScheduledPublication, b: ScheduledPublication): boolean {
  return reservesSlot(a) && reservesSlot(b) && a.platform === b.platform
    && Math.abs(new Date(a.isoTime).getTime() - new Date(b.isoTime).getTime()) < 60_000;
}

export class PublishCalendar {
  private items: ScheduledPublication[] = [];

  constructor(
    private readonly opts: {
      clock?: CalendarClock;
      dailyLimitPerPlatform?: Record<string, number>;
      minGapMs?: number;
      onMissed?: 'skip' | 'publish-late';
    } = {}
  ) {
    if (!Number.isFinite(opts.minGapMs ?? 0) || (opts.minGapMs ?? 0) < 0) throw new Error('invalid minimum gap');
    for (const limit of Object.values(opts.dailyLimitPerPlatform ?? {})) {
      if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('invalid daily limit');
    }
  }

  private check(item: ScheduledPublication, excludeId?: string): { ok: boolean; reason?: string } {
    if (!item || [item.id, item.taskId, item.platform].some((value) => typeof value !== 'string' || !value.trim())) {
      return { ok: false, reason: 'invalid-item' };
    }
    if (!['scheduled', 'published', 'skipped', 'cancelled'].includes(item.status)) return { ok: false, reason: 'invalid-status' };
    if (typeof item.isoTime !== 'string' || !Number.isFinite(new Date(item.isoTime).getTime())) {
      return { ok: false, reason: 'invalid-time' };
    }
    let dayFormat: Intl.DateTimeFormat;
    try {
      if (typeof item.timezone !== 'string' || !item.timezone.trim()) throw new Error('missing timezone');
      dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: item.timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
    } catch {
      return { ok: false, reason: 'invalid-timezone' };
    }
    if (item.rrule !== undefined && !validRule(item.rrule)) return { ok: false, reason: 'invalid-rrule' };
    const others = this.items.filter((existing) => existing.id !== excludeId);
    if (others.some((existing) => existing.id === item.id)) return { ok: false, reason: 'duplicate-id' };
    if (!reservesSlot(item)) return { ok: true };
    for (const existing of others.filter(reservesSlot)) {
      if (detectConflict(existing, item)) return { ok: false, reason: 'conflict' };
      if (existing.platform === item.platform && this.opts.minGapMs
        && Math.abs(new Date(existing.isoTime).getTime() - new Date(item.isoTime).getTime()) < this.opts.minGapMs) {
        return { ok: false, reason: 'min-gap' };
      }
    }
    const limit = this.opts.dailyLimitPerPlatform?.[item.platform];
    if (limit !== undefined) {
      const day = dayFormat.format(new Date(item.isoTime));
      const n = others.filter((existing) => reservesSlot(existing) && existing.platform === item.platform
        && dayFormat.format(new Date(existing.isoTime)) === day).length;
      if (n >= limit) return { ok: false, reason: 'daily-limit' };
    }
    return { ok: true };
  }

  add(item: ScheduledPublication): { ok: boolean; reason?: string } {
    const result = this.check(item);
    if (result.ok) this.items.push(copy(item));
    return result;
  }

  reschedule(id: string, newIso: string): { ok: boolean; reason?: string } {
    const idx = this.items.findIndex((item) => item.id === id);
    if (idx < 0) return { ok: false, reason: 'not-found' };
    const updated = { ...this.items[idx], isoTime: newIso };
    const result = this.check(updated, id);
    if (result.ok) this.items[idx] = updated;
    return result;
  }

  cancel(id: string): void {
    const item = this.items.find((candidate) => candidate.id === id);
    if (item?.status === 'scheduled') item.status = 'cancelled';
  }

  markPublished(id: string): void {
    const item = this.items.find((candidate) => candidate.id === id);
    if (item?.status === 'scheduled') item.status = 'published';
  }

  due(now: Date = (this.opts.clock ?? systemClock).now()): ScheduledPublication[] {
    return this.items.filter((item) => item.status === 'scheduled' && new Date(item.isoTime) <= now).map(copy);
  }

  missed(now: Date = (this.opts.clock ?? systemClock).now()): ScheduledPublication[] {
    return this.items.filter((item) => item.status === 'scheduled'
      && now.getTime() - new Date(item.isoTime).getTime() > 3600_000).map(copy);
  }

  handleMissed(now: Date = (this.opts.clock ?? systemClock).now()): ScheduledPublication[] {
    const missed = this.missed(now);
    if (this.opts.onMissed !== 'publish-late') {
      const ids = new Set(missed.map((item) => item.id));
      for (const item of this.items) if (ids.has(item.id)) item.status = 'skipped';
      return missed.map((item) => ({ ...item, status: 'skipped' }));
    }
    // A late publication remains due until the caller actually publishes it.
    return missed;
  }

  list(): ScheduledPublication[] {
    return this.items.map(copy);
  }
}
