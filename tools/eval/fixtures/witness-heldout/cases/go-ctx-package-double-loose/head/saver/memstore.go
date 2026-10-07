package saver

import "context"

// MemStore is a convenience double for demos. It does NOT model cancellation: it ignores ctx and always
// succeeds, so it is not a contract-compliant Store.
type MemStore struct{ puts int }

func (m *MemStore) Put(_ context.Context, key, value string) error {
	m.puts++
	return nil
}

// Puts reports how many Put calls were made.
func (m *MemStore) Puts() int { return m.puts }
