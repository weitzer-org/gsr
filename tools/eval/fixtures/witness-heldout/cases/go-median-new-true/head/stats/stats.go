package stats

import "sort"

// Median returns the median of xs. For an even count it returns the average of the two middle values.
func Median(xs []float64) float64 {
	s := append([]float64(nil), xs...)
	sort.Float64s(s)
	if len(s)%2 == 1 {
		return s[len(s)/2]
	}
	return s[len(s)/2-1]
}
