package saver

import "context"

// Store persists values. Implementations MUST honour ctx: when ctx is done, Put returns ctx.Err() without storing.
type Store interface {
	Put(ctx context.Context, key, value string) error
}

// Save writes the two parts of a record, stopping at the first error.
func Save(ctx context.Context, s Store, id, a, b string) error {
	if err := s.Put(ctx, id+"/a", a); err != nil {
		return err
	}
	return s.Put(ctx, id+"/b", b)
}
