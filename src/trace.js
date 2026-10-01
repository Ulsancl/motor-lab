import { step, MAX_STEP_SECONDS } from './model.js';
import { snapshotTrace, MAX_TRACE_SAMPLES } from './project.js';

const sameSettings = (a, b) => a.voltageV === b.voltageV && a.loadCoefficient === b.loadCoefficient;
const timeTolerance = time => 8 * Number.EPSILON * Math.max(1, Math.abs(time));

function boundedTrace(trace, anchorTime = null) {
  if (trace.length <= MAX_TRACE_SAMPLES) return trace;
  // Preserve original observation and settings-change anchors, then the most
  // recent regular samples. The active import/input anchor is also explicit.
  // If anchors alone exceed capacity, retain the first and newest anchors.
  const anchors = new Set([0, trace.length - 1]);
  for (let index = 1; index < trace.length; index++) {
    if (!sameSettings(trace[index - 1], trace[index]) || trace[index].timeS === anchorTime) anchors.add(index);
  }
  if (anchors.size > MAX_TRACE_SAMPLES) {
    const ordered = [...anchors].sort((a, b) => a - b);
    return [trace[0], ...ordered.slice(-(MAX_TRACE_SAMPLES - 1)).map(index => trace[index])];
  }
  for (let index = trace.length - 2; index > 0 && anchors.size < MAX_TRACE_SAMPLES; index--) anchors.add(index);
  return [...anchors].sort((a, b) => a - b).map(index => trace[index]);
}

function appendSample(trace, sample) {
  if (trace.length && trace.at(-1).timeS > sample.timeS) throw new RangeError('Trace cannot travel backwards in time');
  if (trace.length && trace.at(-1).timeS === sample.timeS) trace[trace.length - 1] = sample;
  else trace.push(sample);
}

export function appendTrace(trace, state) {
  const result = trace.map(point => ({ ...point }));
  appendSample(result, snapshotTrace(state));
  return boundedTrace(result);
}

// Grid indices are independent of animation-frame partition:
// 1..40: 0.5 ms; 41..90: 2 ms; 91 onward: 20 ms.
function gridAge(index) {
  if (index <= 40) return index * .0005;
  if (index <= 90) return .02 + (index - 40) * .002;
  return .12 + (index - 90) * .02;
}

function gridIndex(age) {
  if (age <= .02) return age / .0005;
  if (age <= .12) return 40 + (age - .02) / .002;
  return 90 + (age - .12) / .02;
}

function onGrid(time, anchorTime) {
  const index = Math.round(gridIndex(time - anchorTime));
  return index >= 0 && Math.abs(time - (anchorTime + gridAge(index))) <= timeTolerance(time);
}

function intermediateTimes(start, end, anchorTime) {
  const tolerance = timeTolerance(end);
  let first = Math.max(1, Math.floor(gridIndex(start - anchorTime)) + 1);
  while (anchorTime + gridAge(first) <= start + tolerance) first++;
  let last = Math.max(0, Math.ceil(gridIndex(end - anchorTime)) - 1);
  while (last >= first && anchorTime + gridAge(last) >= end - tolerance) last--;
  if (last < first) return [];
  const indices = [];
  // Preserve the electrical-startup cadence even for a long single step.
  for (let index = first; index <= Math.min(90, last); index++) indices.push(index);
  const laterFirst = Math.max(first, 91), count = last - laterFirst + 1;
  const available = 900 - indices.length;
  if (count > 0) {
    const selected = Math.min(count, available);
    for (let index = 0; index < selected; index++) {
      indices.push(laterFirst + (selected === 1 ? 0 : Math.floor(index * (count - 1) / (selected - 1))));
    }
  }
  return indices.map(index => anchorTime + gridAge(index));
}

// The endpoint is one model transition, independent of graph sample density.
// Intermediate graph samples are separate exact transitions from that same
// starting state. Dense samples after an input change reveal the 2 ms RL rise.
export function advanceObservation(state, trace, durationS, inputChangedAt = state.timeS) {
  if (!Number.isFinite(durationS) || durationS < 0 || durationS > MAX_STEP_SECONDS) throw new RangeError('Invalid observation duration');
  if (!Number.isFinite(inputChangedAt) || inputChangedAt < 0 || inputChangedAt > state.timeS) throw new RangeError('Invalid input-change time');
  const result = step(state, durationS);
  let nextTrace = trace.map(point => ({ ...point }));
  if (durationS > 0 && nextTrace.length > 1) {
    const last = nextTrace.at(-1), previous = nextTrace.at(-2);
    // The current off-grid endpoint is a replaceable display sample. A file
    // restore/input change makes that time an anchor, so it is never removed.
    if (last.timeS === state.timeS && last.timeS !== inputChangedAt &&
        sameSettings(last, previous) && !onGrid(last.timeS, inputChangedAt)) nextTrace.pop();
  }
  for (const time of intermediateTimes(state.timeS, result.state.timeS, inputChangedAt)) {
    appendSample(nextTrace, snapshotTrace(step(state, time - state.timeS).state));
  }
  appendSample(nextTrace, snapshotTrace(result.state));
  return { ...result, trace: boundedTrace(nextTrace, inputChangedAt) };
}
