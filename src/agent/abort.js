const { setTimeout: delay } = require('node:timers/promises');
function check(signal) { signal?.throwIfAborted(); }
function sleep(ms, signal) { return delay(ms, undefined, { signal }); }
function timedSignal(signal, ms = 30000) {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
module.exports = { check, sleep, timedSignal };
