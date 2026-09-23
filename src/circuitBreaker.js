'use strict';

// Circuit breaker around PromptPilot's model provider call.
//
// States: CLOSED (normal) -> OPEN (tripped, short-circuiting) -> HALF_OPEN
// (single probe) -> CLOSED or back to OPEN.

class CircuitOpenError extends Error {
  constructor() {
    super('circuit is open');
    this.code = 'CIRCUIT_OPEN';
  }
}

function createCircuitBreaker(options = {}) {
  const now = options.now ?? Date.now;
  const failureThreshold = options.failureThreshold ?? 0.5;
  const minimumRequests = options.minimumRequests ?? 5;
  const openMillis = options.openMillis ?? 30000;

  // Default observability hook: one structured, secret-free log line per
  // state transition. Never includes ticket text, tokens, or payloads —
  // only the breaker's own counters and the new state.
  const onStateChange =
    options.onStateChange ??
    function (nextState) {
      console.log(
        JSON.stringify({
          event: 'circuit_breaker.state_change',
          component: 'promptpilot.model_provider',
          state: nextState,
          calls,
          failures,
          timestamp: new Date(now()).toISOString(),
        })
      );
    };

  const metrics = {
    breaker_open_total: 0,
    short_circuited_total: 0,
    success_total: 0,
    failure_total: 0,
  };

  let state = 'CLOSED';
  let calls = 0;
  let failures = 0;
  let openedAt = 0;

  function trip() {
    state = 'OPEN';
    openedAt = now();
    metrics.breaker_open_total++;
    onStateChange(state);
  }

  async function exec(fn) {
    if (state === 'OPEN') {
      if (now() - openedAt < openMillis) {
        metrics.short_circuited_total++;
        throw new CircuitOpenError();
      }
      // The open window has elapsed: allow exactly one probe through.
      state = 'HALF_OPEN';
      onStateChange(state);
    }

    if (state === 'HALF_OPEN') {
      try {
        const result = await fn();
        metrics.success_total++;
        calls = 0;
        failures = 0;
        state = 'CLOSED';
        onStateChange(state);
        return result;
      } catch (err) {
        metrics.failure_total++;
        trip();
        throw err;
      }
    }

    // CLOSED: count every call, trip once the failure ratio and volume
    // both cross their configured thresholds.
    calls++;
    try {
      const result = await fn();
      metrics.success_total++;
      return result;
    } catch (err) {
      failures++;
      metrics.failure_total++;
      if (calls >= minimumRequests && failures / calls >= failureThreshold) {
        trip();
      }
      throw err;
    }
  }

  return {
    exec,
    metrics,
    get state() {
      return state;
    },
  };
}

module.exports = { createCircuitBreaker, CircuitOpenError };
