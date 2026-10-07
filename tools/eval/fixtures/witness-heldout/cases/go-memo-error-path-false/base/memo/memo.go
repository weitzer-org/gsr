package memo

// Memoizer memoizes load per key. For a successful load, load is called at most once per key. Errors are not
// cached, so a failed load is retried on the next Get.
type Memoizer struct{ m map[string]string }

func New() *Memoizer { return &Memoizer{m: map[string]string{}} }

func (c *Memoizer) Get(key string, load func(string) (string, error)) (string, error) {
	if v, ok := c.m[key]; ok {
		return v, nil
	}
	v, err := load(key)
	if err != nil {
		return "", err
	}
	c.m[key] = v
	return v, nil
}
