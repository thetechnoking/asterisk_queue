// src/lib/timeUtils.js

const daysOfWeek = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Parses a timings string and checks if a given time is within the active periods.
 * @param {string} timingsString - Format "HH:MM-HH:MM;Day1,Day2,Day3-DayX" or "24/7".
 *                                Examples: "09:00-17:30;Mon-Fri", "10:00-14:00;Sat", "09:00-12:00,13:00-17:00;Mon,Wed,Fri"
 * @param {Date} currentTime - JavaScript Date object representing the current time.
 * @returns {boolean} - True if current time is within any active period, false otherwise.
 */
function parseTimings(timingsString, currentTime) {
  if (!timingsString || !currentTime) {
    console.warn('parseTimings: Missing timingsString or currentTime.');
    return false;
  }

  if (timingsString.trim().toUpperCase() === '24/7') {
    return true;
  }

  const currentDay = daysOfWeek[currentTime.getDay()]; // 'Sun', 'Mon', ...
  const currentHour = currentTime.getHours();
  const currentMinute = currentTime.getMinutes();
  const currentTimeInMinutes = currentHour * 60 + currentMinute;

  // Multiple timing rules can be specified, separated by '|'
  const rules = timingsString.split('|');

  for (const rule of rules) {
    const parts = rule.trim().split(';');
    if (parts.length !== 2) {
      console.warn(`parseTimings: Invalid rule format "${rule}". Skipping.`);
      continue;
    }

    const timeRangesStr = parts[0];
    const daysStr = parts[1];

    // Check if current day is active for this rule
    let dayMatch = false;
    const daySegments = daysStr.split(',');
    for (const segment of daySegments) {
      if (segment.includes('-')) {
        const [startDayStr, endDayStr] = segment.split('-');
        const startIndex = daysOfWeek.indexOf(startDayStr);
        const endIndex = daysOfWeek.indexOf(endDayStr);
        const currentDayIndex = daysOfWeek.indexOf(currentDay);
        if (startIndex !== -1 && endIndex !== -1 && currentDayIndex !== -1) {
          if (startIndex <= endIndex) { // e.g., Mon-Fri
            if (currentDayIndex >= startIndex && currentDayIndex <= endIndex) {
              dayMatch = true;
              break;
            }
          } else { // e.g., Fri-Mon (spans weekend)
            if (currentDayIndex >= startIndex || currentDayIndex <= endIndex) {
              dayMatch = true;
              break;
            }
          }
        } else {
          console.warn(`parseTimings: Invalid day range in "${segment}".`);
        }
      } else { // Single day
        if (segment === currentDay) {
          dayMatch = true;
          break;
        }
      }
    }

    if (!dayMatch) {
      continue; // Current day is not active for this rule, try next rule
    }

    // Check if current time is within any time range for this rule
    // Time ranges can be comma-separated, e.g., "09:00-12:00,13:00-17:00"
    const individualTimeRanges = timeRangesStr.split(',');
    for (const timeRangeStr of individualTimeRanges) {
        const [startTimeStr, endTimeStr] = timeRangeStr.split('-');
        if (!startTimeStr || !endTimeStr) {
            console.warn(`parseTimings: Invalid time range format "${timeRangeStr}" in rule "${rule}".`);
            continue;
        }

        const [startHour, startMinute] = startTimeStr.split(':').map(Number);
        const [endHour, endMinute] = endTimeStr.split(':').map(Number);

        if (isNaN(startHour) || isNaN(startMinute) || isNaN(endHour) || isNaN(endMinute)) {
            console.warn(`parseTimings: Non-numeric time components in "${timeRangeStr}".`);
            continue;
        }

        const startTimeInMinutes = startHour * 60 + startMinute;
        let endTimeInMinutes = endHour * 60 + endMinute;

        // Handle "24:00" as end of day or "00:00" for next day if start is late
        // For this version, we assume end time is on the same day if start < end.
        // If end time is 00:00, it usually means up to midnight.
        if (endHour === 0 && endMinute === 0 && startTimeInMinutes > 0) { // e.g. 09:00-00:00 means 09:00 to 23:59:59
            endTimeInMinutes = 24 * 60;
        }


        // Basic same-day check. Does not handle overnight shifts like 22:00-02:00.
        // Acknowledged limitation: start time must be before end time on the given day.
        if (startTimeInMinutes <= endTimeInMinutes) {
            if (currentTimeInMinutes >= startTimeInMinutes && currentTimeInMinutes < endTimeInMinutes) {
                return true; // Active
            }
        } else {
            // This would be for overnight shifts, e.g., 22:00-02:00.
            // For this version, we are not fully supporting this other than 24/7 or explicit day ranges spanning weekend.
            // If startTimeInMinutes > endTimeInMinutes, it implies an overnight shift.
            // e.g. 22:00-02:00. current time 23:00 -> (23:00 >= 22:00) = true
            // e.g. 22:00-02:00. current time 01:00 -> (01:00 < 02:00) = true
            // This logic requires careful day boundary handling.
            // For now, if it's an inverted range on a matched day, we'll consider it a match if time is after start OR before end.
            // This is a simplified take on overnight for a *single matched day string*.
            // Example: "22:00-02:00;Mon" would mean Monday 22:00 to Tuesday 02:00.
            // The current day matching logic doesn't fully support this yet.
            // The current dayMatch is for `currentTime.getDay()`.
            // A simple interpretation for now: if a day is matched, and time range is inverted,
            // it means from startTime till midnight OR from midnight till endTime.
            if (currentTimeInMinutes >= startTimeInMinutes || currentTimeInMinutes < endTimeInMinutes) {
                 console.warn(`parseTimings: Detected potentially overnight range ${timeRangeStr} on matched day ${currentDay}. Partial support. `);
                 // This logic is still tricky. If it's 22:00-02:00 on Monday, and current time is Mon 01:00, it should NOT match.
                 // It should only match Mon 22:xx or Mon 23:xx. Tue 00:xx or Tue 01:xx would be handled if "Tue" is also in daysStr.
                 // Sticking to simpler same-day logic for now to avoid bugs.
                 // To properly handle 22:00-02:00;Mon:
                 //   - if currentDay is Mon, check if currentTime >= 22:00
                 //   - if currentDay is Tue, check if currentTime < 02:00 (this needs day to be adjusted)
                 // This is too complex for the current day-first matching.
                 // Let's assume for "HH:MM-HH:MM;Day" if HH:MM > HH:MM it is invalid unless we build full cross-day logic.
                 console.warn(`parseTimings: Inverted time range ${timeRangeStr} on day ${currentDay} currently not fully supported. Assuming inactive for this range unless it's part of a multi-day definition like Fri-Mon.`);
            }
        }
    }
  }
  return false; // Not active in any rule
}

module.exports = { parseTimings, daysOfWeek };
