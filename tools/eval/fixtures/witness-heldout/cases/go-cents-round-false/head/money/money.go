package money

import "math"

// Cents converts a dollar amount to whole cents, rounding to the nearest cent.
func Cents(dollars float64) int {
	return int(math.Round(dollars * 100))
}
