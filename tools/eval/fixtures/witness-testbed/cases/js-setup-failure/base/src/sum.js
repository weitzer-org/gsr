// sumPositive adds the positive numbers in xs and ignores the rest.
function sumPositive(xs) {
  return xs.filter((x) => x > 0).reduce((a, b) => a + b, 0);
}

module.exports = { sumPositive };
