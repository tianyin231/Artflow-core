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

export function expandRRule(startIso: string, rule: RRule, count: number): string[] {
  const out: string[] = [];
  let t = new Date(startIso);
  for (let i = 0; i < count; i++) {
    out.push(t.toISOString());
    if (rule.freq === 'daily') t = new Date(t.getTime() + (rule.interval ?? 1) * 86400000);
    else if (rule.freq === 'weekly') t = new Date(t.getTime() + (rule.interval ?? 1) * 7 * 86400000);
    else t = new Date(t.getTime() + (rule.interval ?? 1) * 28 * 86400000);
  }
  return out;
}

export function detectConflict(a: ScheduledPublication, b: ScheduledPublication): boolean {
  return (
    a.platform === b.platform &&
    Math.abs(new Date(a.isoTime).getTime() - new Date(b.isoTime).getTime()) < 60_000
  );
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
  ) {}

  add(item: ScheduledPublication): { ok: boolean; reason?: string } {
    for (const existing of this.items) {
      if (detectConflict(existing, item)) return { ok: false, reason: 'conflict' };
      if (
        existing.platform === item.platform &&
        this.opts.minGapMs &&
        Math.abs(new Date(existing.isoTime).getTime() - new Date(item.isoTime).getTime()) < this.opts.minGapMs
      ) {
        return { ok: false, reason: 'min-gap' };
      }
    }
    const limit = this.opts.dailyLimitPerPlatform?.[item.platform];
    if (limit) {
      const day = item.isoTime.slice(0, 10);
      const n = this.items.filter((x) => x.platform === item.platform && x.isoTime.startsWith(day)).length;
      if (n >= limit) return { ok: false, reason: 'daily-limit' };
    }
    this.items.push(item);
    return { ok: true };
  }

  reschedule(id: string, newIso: string): { ok: boolean; reason?: string } {
    const idx = this.items.findIndex((x) => x.id === id);
    if (idx < 0) return { ok: false, reason: 'not-found' };
    const updated = { ...this.items[idx], isoTime: newIso };
    this.items.splice(idx, 1);
    const r = this.add(updated);
    if (!r.ok) {
      this.items.splice(idx, 0, this.items[idx] ?? updated);
      return r;
    }
    return { ok: true };
  }

  cancel(id: string): void {
    const it = this.items.find((x) => x.id === id);
    if (it) it.status = 'cancelled';
  }

  due(now: Date): ScheduledPublication[] {
    return this.items.filter((x) => x.status === 'scheduled' && new Date(x.isoTime) <= now);
  }

  missed(now: Date): ScheduledPublication[] {
    const windowMs = 3600_000;
    return this.items.filter(
      (x) =>
        x.status === 'scheduled' &&
        new Date(x.isoTime) < now &&
        now.getTime() - new Date(x.isoTime).getTime() > windowMs
    );
  }

  handleMissed(now: Date): ScheduledPublication[] {
    const m = this.missed(now);
    for (const it of m) {
      it.status = this.opts.onMissed === 'publish-late' ? 'published' : 'skipped';
    }
    return m;
  }

  list(): ScheduledPublication[] {
    return [...this.items];
  }
}
