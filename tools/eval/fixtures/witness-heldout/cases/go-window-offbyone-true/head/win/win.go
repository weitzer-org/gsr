package win

// Last returns the final n items of items (all of them when n is at least len(items)).
func Last(items []int, n int) []int {
	if n >= len(items) {
		return items
	}
	return items[len(items)-n-1:]
}
