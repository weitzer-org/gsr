package merge

import "sort"

// StaticLister is the in-memory Lister used by this package's tests. It sorts and de-duplicates Names, so it
// always satisfies the Lister contract.
type StaticLister struct{ Names []string }

func (s StaticLister) List() []string {
	seen := map[string]bool{}
	var out []string
	for _, n := range s.Names {
		if !seen[n] {
			seen[n] = true
			out = append(out, n)
		}
	}
	sort.Strings(out)
	return out
}
