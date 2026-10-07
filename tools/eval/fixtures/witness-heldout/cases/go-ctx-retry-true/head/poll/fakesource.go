package poll

import "context"

// FakeSource is the in-memory Source used by this package's tests. Like every real Source it honours ctx:
// a done context returns ctx.Err() without answering.
type FakeSource struct {
	Err   error
	calls int
}

func (f *FakeSource) Get(ctx context.Context, key string) (string, error) {
	f.calls++
	if err := ctx.Err(); err != nil {
		return "", err
	}
	return "", f.Err
}

// Calls reports how many Get calls were made.
func (f *FakeSource) Calls() int { return f.calls }
