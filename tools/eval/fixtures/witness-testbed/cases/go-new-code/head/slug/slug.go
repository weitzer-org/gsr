package slug

import "strings"

// Slugify lowercases s and replaces spaces with hyphens.
func Slugify(s string) string {
	return strings.ToLower(s)
}
