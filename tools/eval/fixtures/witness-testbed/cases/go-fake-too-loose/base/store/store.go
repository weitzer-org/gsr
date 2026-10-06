package store

import (
	"context"
	"errors"
	"time"
)

var (
	ErrRetry  = errors.New("retry")
	ErrGiveUp = errors.New("giving up")
)

// Reader is the storage seam. Real implementations pass ctx to their client.
type Reader interface {
	Read(ctx context.Context, key string) (string, error)
}

// Fetch reads key, retrying on ErrRetry. A cancelled ctx surfaces through the
// Reader, which is how every real Reader in this project stops early.
func Fetch(ctx context.Context, r Reader, key string) (string, error) {
	for attempt := 0; attempt < 3; attempt++ {
		v, err := r.Read(ctx, key)
		if err == nil {
			return v, nil
		}
		if errors.Is(err, ErrRetry) {
			time.Sleep(time.Millisecond)
			continue
		}
		return "", err
	}
	return "", ErrGiveUp
}
