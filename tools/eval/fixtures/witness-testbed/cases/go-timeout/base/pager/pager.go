package pager

// Page returns the items on a 1-based page.
func Page(items []int, page, size int) []int {
	start := (page - 1) * size
	if start < 0 || start >= len(items) {
		return nil
	}
	end := start + size
	if end > len(items) {
		end = len(items)
	}
	return items[start:end]
}
