// applyDiscount returns price reduced by pct percent.
function applyDiscount(price, pct) {
  return price * (1 - pct);
}

module.exports = { applyDiscount };
