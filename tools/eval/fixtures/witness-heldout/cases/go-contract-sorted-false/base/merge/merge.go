package merge

// Lister returns names in ascending order without duplicates. Implementations must preserve both properties.
type Lister interface {
	List() []string
}

// Merge combines two Listers into one ascending, duplicate-free slice. It relies on the Lister contract and
// does not re-sort.
func Merge(a, b Lister) []string {
	x, y := a.List(), b.List()
	var out []string
	i, j := 0, 0
	for i < len(x) && j < len(y) {
		switch {
		case x[i] < y[j]:
			out = append(out, x[i])
			i++
		case x[i] > y[j]:
			out = append(out, y[j])
			j++
		default:
			out = append(out, x[i])
			i++
			j++
		}
	}
	out = append(out, x[i:]...)
	out = append(out, y[j:]...)
	return out
}
