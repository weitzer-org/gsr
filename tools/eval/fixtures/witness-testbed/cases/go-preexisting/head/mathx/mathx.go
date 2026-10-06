package mathx

// Clamp limits v to the range [lo, hi].
func Clamp(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return lo
	}
	return v
}

// Abs returns the absolute value of v (added by the PR; unrelated to Clamp).
func Abs(v int) int {
	if v < 0 {
		return -v
	}
	return v
}
