package store

import "context"

// MemReader is the in-memory Reader used by this package's tests. Like every
// real Reader it honours ctx: a done context returns ctx.Err().
type MemReader struct {
	Err   error
	reads int
}

func (m *MemReader) Read(ctx context.Context, key string) (string, error) {
	m.reads++
	if err := ctx.Err(); err != nil {
		return "", err
	}
	return "", m.Err
}

// Reads reports how many Read calls were made.
func (m *MemReader) Reads() int { return m.reads }
