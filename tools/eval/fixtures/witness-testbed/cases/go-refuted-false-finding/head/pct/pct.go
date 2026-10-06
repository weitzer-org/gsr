package pct

// Percent returns part as a whole-number percentage of total, rounded half up.
func Percent(part, total int) int {
	if total == 0 {
		return 0
	}
	return (part*100 + total/2) / total
}
