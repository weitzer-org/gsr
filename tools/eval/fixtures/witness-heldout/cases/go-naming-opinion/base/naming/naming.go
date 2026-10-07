package naming

import "time"

// Parse reads a duration such as "1m30s".
func Parse(s string) (time.Duration, error) {
	d, err := time.ParseDuration(s)
	if err != nil {
		return 0, err
	}
	return d, nil
}
