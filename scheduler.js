// scheduler.js — shared schedule logic
// Loaded by app.js via <script> and by sw.js via importScripts()

const Scheduler = (() => {
  /**
   * Returns true if the schedule should fire now, given the last run time.
   * @param {object} schedule
   * @param {string|null} lastRun — ISO string or null
   * @returns {boolean}
   */
  function shouldFireNow(schedule, lastRun) {
    if (!schedule || !schedule.type) return false;
    const now = new Date();
    const last = lastRun ? new Date(lastRun) : null;

    if (schedule.type === 'interval') {
      const intervalMs = (schedule.minutes || 60) * 60 * 1000;
      if (!last) return true;
      return (now - last) >= intervalMs;
    }

    if (schedule.type === 'weekly') {
      const day = now.getDay(); // 0=Sun
      const days = schedule.days || [1, 2, 3, 4, 5];
      if (!days.includes(day)) return false;

      const [h, m] = (schedule.time || '09:00').split(':').map(Number);
      const scheduledToday = new Date(now);
      scheduledToday.setHours(h, m, 0, 0);

      // Fire if we're within a 2-minute window of the scheduled time
      const diff = now - scheduledToday;
      if (diff < 0 || diff > 2 * 60 * 1000) return false;

      // Don't fire again if already fired today at this time
      if (last) {
        const lastDate = new Date(last);
        if (
          lastDate.getFullYear() === now.getFullYear() &&
          lastDate.getMonth() === now.getMonth() &&
          lastDate.getDate() === now.getDate() &&
          lastDate.getHours() === h
        ) return false;
      }
      return true;
    }

    if (schedule.type === 'once') {
      if (!schedule.iso) return false;
      const target = new Date(schedule.iso);
      const diff = now - target;
      if (diff < 0 || diff > 2 * 60 * 1000) return false;
      if (last && new Date(last) >= target) return false;
      return true;
    }

    return false;
  }

  /**
   * Returns a Date representing the next scheduled run time.
   * @param {object} schedule
   * @param {string|null} lastRun — ISO string or null
   * @returns {Date|null}
   */
  function nextRunTime(schedule, lastRun) {
    if (!schedule || !schedule.type) return null;
    const now = new Date();

    if (schedule.type === 'interval') {
      const intervalMs = (schedule.minutes || 60) * 60 * 1000;
      const last = lastRun ? new Date(lastRun) : now;
      return new Date(last.getTime() + intervalMs);
    }

    if (schedule.type === 'weekly') {
      const [h, m] = (schedule.time || '09:00').split(':').map(Number);
      const days = schedule.days || [1, 2, 3, 4, 5];
      // Find the next day in schedule
      for (let i = 0; i <= 7; i++) {
        const candidate = new Date(now);
        candidate.setDate(now.getDate() + i);
        candidate.setHours(h, m, 0, 0);
        if (days.includes(candidate.getDay()) && candidate > now) {
          return candidate;
        }
      }
      return null;
    }

    if (schedule.type === 'once') {
      if (!schedule.iso) return null;
      const target = new Date(schedule.iso);
      return target > now ? target : null;
    }

    return null;
  }

  /**
   * Returns the minimum interval in ms for periodic background sync registration.
   * @param {object} schedule
   * @returns {number}
   */
  function computeMinInterval(schedule) {
    if (!schedule) return 60 * 60 * 1000; // 1 hour default

    if (schedule.type === 'interval') {
      return Math.max((schedule.minutes || 60) * 60 * 1000, 60 * 60 * 1000);
    }
    // Daily/weekly or one-time: check every hour
    return 60 * 60 * 1000;
  }

  /**
   * Returns true if a missed run should be fired on page load.
   * A run is "missed" if the last scheduled time is in the past but nothing was fired.
   */
  function hasMissedRun(schedule, lastRun) {
    if (!schedule || !schedule.type) return false;
    const now = new Date();
    const last = lastRun ? new Date(lastRun) : null;

    if (schedule.type === 'interval') {
      const intervalMs = (schedule.minutes || 60) * 60 * 1000;
      if (!last) return true;
      return (now - last) >= intervalMs;
    }

    if (schedule.type === 'weekly') {
      const days = schedule.days || [1, 2, 3, 4, 5];
      const [h, m] = (schedule.time || '09:00').split(':').map(Number);
      // Check last 7 days for a missed fire
      for (let i = 1; i <= 7; i++) {
        const candidate = new Date(now);
        candidate.setDate(now.getDate() - i);
        candidate.setHours(h, m, 0, 0);
        if (days.includes(candidate.getDay()) && candidate < now) {
          if (!last || last < candidate) return true;
          break;
        }
      }
      return false;
    }

    if (schedule.type === 'once') {
      if (!schedule.iso) return false;
      const target = new Date(schedule.iso);
      return target <= now && (!last || last < target);
    }

    return false;
  }

  return { shouldFireNow, nextRunTime, computeMinInterval, hasMissedRun };
})();

// Support both module environments and direct script/importScripts usage
if (typeof module !== 'undefined' && module.exports) {
  module.exports = Scheduler;
}
