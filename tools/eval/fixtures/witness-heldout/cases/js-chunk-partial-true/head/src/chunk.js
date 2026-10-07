// chunk splits arr into groups of size, keeping a final shorter group.
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i + size <= arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

module.exports = { chunk };
