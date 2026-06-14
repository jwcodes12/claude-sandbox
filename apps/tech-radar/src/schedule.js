import { getState, setState } from './db.js';

export function shouldRun(db, config, { force = false } = {}) {
  if (force || process.env.TECH_RADAR_FORCE_RUN === '1') {
    return { run: true, reason: 'forced' };
  }

  const schedule = config.settings.schedule;
  if (isPeakHour(schedule)) {
    return { run: true, reason: 'peak-hours' };
  }

  const lastCompletedAt = getState(db, 'last_completed_at');
  if (!lastCompletedAt) return { run: true, reason: 'no-last-run' };

  const elapsedMinutes = (Date.now() - Date.parse(lastCompletedAt)) / 60_000;
  if (elapsedMinutes >= schedule.offPeakMinimumMinutes) {
    return { run: true, reason: 'off-peak-hourly' };
  }
  return { run: false, reason: `off-peak throttle (${Math.round(elapsedMinutes)}m elapsed)` };
}

export function markCompleted(db) {
  setState(db, 'last_completed_at', new Date().toISOString());
}

function isPeakHour(schedule) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: schedule.timezone,
    hour: 'numeric',
    hour12: false,
  });
  const hour = Number(formatter.format(new Date()));
  return hour >= schedule.peakStartHour && hour <= schedule.peakEndHour;
}
