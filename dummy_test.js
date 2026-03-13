function calculateTotal(items) {
  let total = 0;
  // O(N^2) loop to trigger performance agent
  for(let i=0; i<items.length; i++) {
    for(let j=0; j<items.length; j++) {
       total += items[i].price;
       // Logic bug: adding item price multiple times, and no null check
    }
  }
  return total;
}

const AWS_SECRET_KEY = "AKIAIOSFODNN7EXAMPLE"; // Hardcoded secret to trigger secrets scanner
