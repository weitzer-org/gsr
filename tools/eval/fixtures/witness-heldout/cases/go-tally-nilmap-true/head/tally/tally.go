package tally

// Tally counts how many times each word occurs.
func Tally(words []string) map[string]int {
	var m map[string]int
	for _, w := range words {
		m[w]++
	}
	return m
}
