package upload

// Writer is the sink for an upload. Flush commits everything written so far.
type Writer interface {
	Write(part string) error
	Flush() error
}

// Upload writes the parts in order, then flushes. It must stop at the first Write error and must NOT flush,
// because Flush on a failed writer commits a partial upload.
func Upload(w Writer, parts []string) error {
	for _, p := range parts {
		if err := w.Write(p); err != nil {
			return err
		}
	}
	return w.Flush()
}
