package poll

import (
	"context"
	"errors"
)

var ErrNotReady = errors.New("not ready")

// Source is the polled backend. Implementations honour ctx: a done context returns ctx.Err().
type Source interface {
	Get(ctx context.Context, key string) (string, error)
}

// Poll asks src for key up to four times while it reports a failure.
func Poll(ctx context.Context, src Source, key string) (string, error) {
	var err error
	for i := 0; i < 4; i++ {
		var v string
		v, err = src.Get(ctx, key)
		if err == nil {
			return v, nil
		}
	}
	return "", err
}
