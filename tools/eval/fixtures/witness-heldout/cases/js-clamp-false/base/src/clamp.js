// clamp01 limits x to the range 0..1.
function clamp01(x) {
  return Math.min(1, Math.max(0, x));
}

module.exports = { clamp01 };
