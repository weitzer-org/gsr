package upload

// RecordingWriter is the in-memory Writer used by this package's tests. It records every call and returns
// WriteErr from Write, behaving like a real sink that fails.
type RecordingWriter struct {
	WriteErr       error
	writes, flushes int
}

func (r *RecordingWriter) Write(string) error {
	r.writes++
	return r.WriteErr
}

func (r *RecordingWriter) Flush() error {
	r.flushes++
	return nil
}

// Flushes reports how many Flush calls were made.
func (r *RecordingWriter) Flushes() int { return r.flushes }
