package order

import "sort"

// Sorted returns a sorted copy of xs; xs itself is left unchanged.
func Sorted(xs []int) []int {
	out := append([]int(nil), xs...)
	sort.Ints(out)
	return out
}
