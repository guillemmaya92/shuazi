/* ── SPACED REPETITION (SM-2 lite) ──
   Turns the deck's three swipe outcomes into review grades and computes the next
   due date per item:
     • Known  (swipe right) → "good" — recalled well, interval grows.
     • Review (swipe up)    → "hard" — recalled with effort, short interval.
     • Left   (swipe left)  → not learned; the caller clears the schedule (new).
   A record is { interval (days), ease, reps, due (ms epoch), last (ms epoch) }. */

const DAY = 86400000;
const DEFAULT_EASE = 2.3;
const MIN_EASE = 1.3;
const MAX_EASE = 2.8;
const MAX_INTERVAL = 365;

// prev: an existing record or undefined (first review). Returns the new record.
export function reschedule(prev, grade) {
  let ease = prev?.ease ?? DEFAULT_EASE;
  let reps = prev?.reps ?? 0;
  let interval = prev?.interval ?? 0;

  if (grade === 'good') {            // "Known" — correct recall
    reps += 1;
    ease = Math.min(MAX_EASE, ease + 0.08);
    interval = reps <= 1 ? 1 : reps === 2 ? 3 : Math.round(interval * ease);
  } else if (grade === 'hard') {     // "Review" — recalled with difficulty
    reps = Math.max(1, reps);
    ease = Math.max(MIN_EASE, ease - 0.15);
    interval = 1;
  } else {                           // "again" — lapse / not learned
    reps = 0;
    ease = Math.max(MIN_EASE, ease - 0.2);
    interval = 0;                    // due now → stays in rotation
  }

  interval = Math.max(0, Math.min(MAX_INTERVAL, interval));
  return { interval, ease, reps, due: Date.now() + interval * DAY, last: Date.now() };
}

// An item is due when it has no schedule (new / never graded) or its due date
// has passed. Not-yet-due scheduled items rest out of the deck until then.
export function isDue(sched, now = Date.now()) {
  return !sched || sched.due <= now;
}
